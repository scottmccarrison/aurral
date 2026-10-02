// Shared identity policy for the pre-download and post-download stages.
//
// beets owns generic title, artist, duration, track-index, and recording-ID
// distance. This module only interprets that result alongside Aurral-specific
// contradictions, source evidence, quality context, and review policy.

import {
  checkVariantCompatibility,
  detectNoise,
  getCoreTitle,
} from "./semanticPolicy.js";
import { getCapabilities } from "./candidateNormalizer.js";
import { getNormalizedText } from "../providers/brainzmashRanking.js";
import {
  albumNamesVariant,
  confirmEditionRenumbering,
  detectAlbumVersion,
} from "./albumVersion.js";

export const MATCHER_UNAVAILABLE_MESSAGE =
  "Track matcher (bundled beets runtime) is unavailable. Verify the Aurral image installation; matching cannot fall back to a weaker algorithm.";

export const DEFAULT_MATCH_THRESHOLDS = Object.freeze({
  strongRecThresh: 0.04,
  mediumRecThresh: 0.25,
  recGapThresh: 0.25,
  // Configurable review behavior (merged from settings.matching)
  autoApproveDistance: 0.10,
  autoDenyDistance: 0.50,
  reviewTimeoutHours: 48,
  reviewAction: "hold",  // "hold", "auto-deny", "retry-next-candidate"
  // Album-version-aware post-download validation
  // (keep in sync with constants.js settings.matching)
  trackNumberMismatchTolerance: true,
  albumVersionMatching: true,
  requireExactAlbumMatch: false,
});

const DURATION_BASE_TOLERANCE_MS = 25000;

export function isWithinBaseDurationTolerance(durationDiffMs, expectedDurationMs) {
  return (
    durationDiffMs <= DURATION_BASE_TOLERANCE_MS ||
    durationDiffMs <= Math.max(12000, expectedDurationMs * 0.18)
  );
}

export function recommendationFromDistance(distance, thresholds = DEFAULT_MATCH_THRESHOLDS) {
  if (!Number.isFinite(distance)) return "none";
  if (distance < thresholds.strongRecThresh) return "strong";
  if (distance <= thresholds.mediumRecThresh) return "medium";
  return "low";
}

export function readRecordingIdentifier(request, candidate) {
  const expected = String(request?.recordingMbid || "").trim() || null;
  const actual = String(candidate?.recordingMbid || "").trim() || null;
  if (!expected || !actual) return { present: false, conflict: false, match: false };
  const match = expected.toLowerCase() === actual.toLowerCase();
  return { present: true, conflict: !match, match };
}

function readYearEvidence(request, candidate, folder = null) {
  const expected = request.releaseYear ? String(request.releaseYear) : null;
  if (!expected) return { conflicting: false, matched: false };
  const years = new Set();
  if (candidate.year) years.add(String(candidate.year));
  for (const year of folder?.years || []) years.add(String(year));
  if (years.size === 0) return { conflicting: false, matched: false };
  return { conflicting: !years.has(expected), matched: years.has(expected) };
}

function readAlbumEvidence(request, candidate) {
  if (!request.albumName || !candidate.album) return null;
  // beets' track_distance intentionally has no album component. Album text
  // remains supporting release evidence, never a replacement for distance;
  // normalize and compare it exactly rather than reimplementing fuzzy match.
  return getNormalizedText(candidate.album) === getNormalizedText(request.albumName)
    ? 100
    : 0;
}

function readTrackNumberEvidence(request, candidate) {
  const expected = Number(request.trackNumber);
  const actual = Number(candidate.trackNumber);
  const mismatch =
    Number.isFinite(expected) &&
    expected > 0 &&
    Number.isFinite(actual) &&
    actual > 0 &&
    expected !== actual;
  const expectedTitles = Array.isArray(request.albumTrackTitles)
    ? request.albumTrackTitles
    : [];
  const indexedTitle = mismatch ? expectedTitles[actual - 1] : null;
  const siblingAtIndex =
    Boolean(indexedTitle) &&
    getNormalizedText(getCoreTitle(indexedTitle)) !==
      getNormalizedText(getCoreTitle(request.trackName));
  return {
    expected: request.trackNumber || null,
    actual: candidate.trackNumber || null,
    mismatch,
    siblingAtIndex,
  };
}

function readDurationEvidence(request, candidate, strict) {
  const expectedMs = Number(request.durationMs || 0);
  const actualMs = Number(candidate.durationMs || 0) || null;
  const diffMs = expectedMs > 0 && actualMs != null ? Math.abs(actualMs - expectedMs) : null;
  const withinBaseTolerance =
    diffMs == null || isWithinBaseDurationTolerance(diffMs, expectedMs);
  const withinValidationWindow =
    diffMs == null ||
    withinBaseTolerance ||
    (!strict && diffMs <= Math.max(60000, expectedMs * 0.45));
  return {
    expectedMs: expectedMs || null,
    actualMs,
    diffMs,
    withinBaseTolerance,
    withinValidationWindow,
  };
}

function readSharedEvidence({ request, candidate, providerEvidence, strict }) {
  const variant = checkVariantCompatibility(request, candidate);
  const identifier = readRecordingIdentifier(request, candidate);
  const noise = detectNoise([candidate.title, candidate.filename].filter(Boolean).join(" "));
  const folder = providerEvidence?.folder || null;
  // Providers may advertise a duration before a file exists. That is source
  // evidence for the pre-download policy, while the candidate duration is
  // the only trustworthy value after parsing the downloaded file.
  const durationCandidate =
    providerEvidence?.advertisedDurationMs != null
      ? { ...candidate, durationMs: providerEvidence.advertisedDurationMs }
      : candidate;
  const duration = readDurationEvidence(request, durationCandidate, strict);
  const trackNumber = readTrackNumberEvidence(request, candidate);
  return {
    variant,
    identifier,
    noise,
    folder,
    duration,
    trackNumber,
    album: readAlbumEvidence(request, candidate),
    year: readYearEvidence(request, candidate, folder),
  };
}

function hardConflict({ request, candidate, providerEvidence, strict, phase, allowNoisyCandidates }) {
  const evidence = readSharedEvidence({ request, candidate, providerEvidence, strict });
  const folder = evidence.folder;
  let reason = null;
  let contradictions = evidence.variant.contradictions;
  let reasons = contradictions.map((label) => `semantic contradiction: ${label}`);

  if (candidate.provider?.locked) {
    reason = "locked";
    reasons = ["candidate is locked on the provider"];
  } else if (folder?.artistContradicted || folder?.ambiguousTitleAlbumArtist) {
    const label = folder.artistContradicted
      ? "artist-mismatch"
      : "ambiguous-title-album-artist";
    reason = label;
    contradictions = [label];
    reasons = folder.artistContradicted
      ? [`filename names a different artist (${folder.filenameArtist})`]
      : ["same-titled single offered by a folder that names no requested artist"];
  } else if (contradictions.length > 0) {
    reason = "contradiction";
  } else if (evidence.identifier.conflict) {
    reason = "recording-mbid-conflict";
    contradictions = [reason];
    reasons = ["candidate recording MBID conflicts with the requested recording"];
  } else if (evidence.noise.length > 0 && !allowNoisyCandidates) {
    reason = "noise";
    reasons = evidence.noise.map((label) => `noise: ${label}`);
  } else if (
    phase === "pre" &&
    evidence.duration.diffMs != null &&
    !evidence.duration.withinBaseTolerance
  ) {
    const { actualMs, expectedMs } = evidence.duration;
    reason = "advertised-duration-mismatch";
    reasons = [`advertised duration ${actualMs}ms is outside tolerance for ${expectedMs}ms`];
  }

  return reason
    ? {
        rejected: true,
        decision: phase === "post" ? "CONFLICTED" : "reject",
        reason,
        contradictions,
        noise: evidence.noise,
        reasons,
        ...evidence,
      }
    : { rejected: false, ...evidence };
}

function baseOutput({ request, candidate, match, evidence, thresholds, phase }) {
  const penalties = match?.penalties || {};
  const distance = match?.distance ?? null;
  const recommendation = recommendationFromDistance(distance, thresholds);
  const titlePenalty = Number(penalties.track_title ?? 0);
  const artistPenalty = Number(penalties.track_artist ?? 0);
  const aurralEvidence = {
    album: evidence.album,
    year: {
      expected: request.releaseYear || null,
      candidate: candidate.year || null,
      ...evidence.year,
    },
    trackNumber: evidence.trackNumber,
    recordingMbid: evidence.identifier.match
      ? { match: true, mbid: candidate.recordingMbid }
      : null,
    folder: evidence.folder,
  };
  if (phase === "post") {
    aurralEvidence.duration = evidence.duration;
    aurralEvidence.titleEvidence = { titlePenalty, artistPenalty };
    aurralEvidence.tags = {
      title: candidate.title,
      artists: candidate.artists,
      album: candidate.album,
      year: candidate.year,
    };
  }
  return {
    candidate,
    distance,
    recommendation,
    penalties,
    maxDistance: match?.maxDistance ?? null,
    rawDistance: match?.rawDistance ?? null,
    aurralEvidence,
    titlePenalty,
    artistPenalty,
    tagsMatchStrongly: titlePenalty < 0.05 && artistPenalty < 0.05,
    shapeAgrees: evidence.duration.withinValidationWindow && !evidence.trackNumber.mismatch,
    reasons: [`beets distance ${distance}`, `recommendation ${recommendation}`],
  };
}

function evaluatePreDownload({ source, evidence, base, thresholds = DEFAULT_MATCH_THRESHOLDS }) {
  if (evidence.identifier.match) {
    return {
      ...base,
      decision: "accept",
      distance: 0,
      recommendation: "strong",
      reasons: ["recording MBID matches the requested recording", ...base.reasons],
    };
  }

  // Use configurable thresholds for decision logic
  const distance = base.distance;
  const autoApprove = thresholds.autoApproveDistance ?? DEFAULT_MATCH_THRESHOLDS.autoApproveDistance;
  const autoDeny = thresholds.autoDenyDistance ?? DEFAULT_MATCH_THRESHOLDS.autoDenyDistance;
  const reviewAction = thresholds.reviewAction ?? DEFAULT_MATCH_THRESHOLDS.reviewAction;

  let decision;
  const reasons = [...base.reasons];

  if (distance != null && distance <= autoApprove) {
    decision = "accept";
    reasons.push(`distance ${distance} within auto-approve threshold (${autoApprove})`);
  } else if (distance != null && distance > autoDeny) {
    // Auto-deny: distance too high, don't even hold for review
    if (reviewAction === "auto-deny") {
      decision = "reject";
      reasons.push(`distance ${distance} exceeds auto-deny threshold (${autoDeny}), auto-deny enabled`);
    } else if (reviewAction === "retry-next-candidate") {
      decision = "reject";
      reasons.push(`distance ${distance} exceeds auto-deny threshold (${autoDeny}), retry-next-candidate enabled`);
    } else {
      decision = "review";
      reasons.push(`distance ${distance} exceeds auto-deny threshold (${autoDeny}), held for review`);
    }
  } else if (base.recommendation === "strong") {
    decision = "accept";
    reasons.push("strong metadata match");
  } else if (base.recommendation === "medium") {
    decision = "verify";
    reasons.push("moderate metadata match, post-download verification required");
  } else {
    // Default to review for low recommendation
    decision = "review";
    reasons.push("weak metadata evidence");
  }

  if (
    getCapabilities(source).structuredArtist &&
    base.artistPenalty >= 0.15
  ) {
    return {
      ...base,
      decision: "reject",
      reason: "artist-mismatch",
      reasons: [...reasons, "provider artist conflicts with the requested artist"],
    };
  }
  if (decision === "accept" && evidence.folder?.artistMissing) {
    decision = "verify";
    reasons.push("no source names the requested artist; downgraded accept to verify");
  }
  if (decision === "accept" && evidence.album != null && evidence.album < 35) {
    decision = "verify";
    reasons.push(`weak album evidence (${evidence.album}) downgraded accept to verify`);
  }
  if (decision === "accept" && evidence.year.conflicting) {
    decision = "verify";
    reasons.push("conflicting year evidence downgraded accept to verify");
  }
  if (evidence.trackNumber.mismatch && base.titlePenalty >= 0.05) {
    return {
      ...base,
      decision: "reject",
      reason: "track-number-mismatch",
      reasons: [...reasons, "track number mismatch with imperfect title evidence"],
    };
  }
  if (decision === "accept" && evidence.trackNumber.siblingAtIndex) {
    decision = "verify";
    reasons.push("candidate index points at a different title from the requested release");
  }
  return { ...base, decision, reasons };
}

// Single source of truth for "may the edition-renumbering tracklist path
// decide this candidate?" — used by evaluatePostDownload AND by the
// post-download validator's fetch gate, so the two can never drift.
//
// Eligible when album-version matching is on, the track numbers actually
// mismatch, the albums are not the same known edition (differing edition
// tokens, same-base-name variant, or an unknown candidate album), and the
// requireExactAlbumMatch hard gate is off.
export function editionRenumberingGate({
  request,
  candidate,
  thresholds = DEFAULT_MATCH_THRESHOLDS,
  trackNumberMismatch = null,
  candidateAlbum = null,
} = {}) {
  const albumVersionMatching =
    thresholds.albumVersionMatching ??
    DEFAULT_MATCH_THRESHOLDS.albumVersionMatching;
  const requireExactAlbumMatch =
    thresholds.requireExactAlbumMatch ??
    DEFAULT_MATCH_THRESHOLDS.requireExactAlbumMatch;
  const albumVersion = detectAlbumVersion(request?.albumName, candidateAlbum);
  const mismatch =
    trackNumberMismatch != null
      ? Boolean(trackNumberMismatch)
      : readTrackNumberEvidence(request, candidate).mismatch;
  const eligible =
    Boolean(albumVersionMatching) &&
    !requireExactAlbumMatch &&
    mismatch &&
    (!albumVersion.matches ||
      albumNamesVariant(request?.albumName, candidateAlbum) ||
      albumVersion.candidateUnknown);
  return { eligible, albumVersion };
}

function evaluatePostDownload({
  base,
  evidence,
  request,
  thresholds = DEFAULT_MATCH_THRESHOLDS,
  editionTracklist = null,
  editionAlbumFallback = null,
}) {
  const candidate = base.candidate;
  const trackNumberMismatchTolerance =
    thresholds.trackNumberMismatchTolerance ??
    DEFAULT_MATCH_THRESHOLDS.trackNumberMismatchTolerance;
  const requireExactAlbumMatch =
    thresholds.requireExactAlbumMatch ??
    DEFAULT_MATCH_THRESHOLDS.requireExactAlbumMatch;

  // (1) Recording identity: a matching recording MBID is decisive on its own.
  // Only a duration outside the validation window can hold it for review, and
  // the sibling-index override below is skipped — the job's albumTrackTitles
  // list describes one edition and is the wrong space to judge an MBID-matched
  // file's position claim against.
  if (evidence.identifier.match) {
    if (evidence.duration.withinValidationWindow) {
      return { ...base, decision: "VERIFIED", reason: null };
    }
    return {
      ...base,
      decision: "AMBIGUOUS",
      reason: `duration mismatch: expected ${evidence.duration.expectedMs}ms, actual ${evidence.duration.actualMs}ms`,
    };
  }

  // (2) Album edition evidence: the file's own album tag first, the parsed
  // pre-download candidate's album as fallback, else unknown.
  const candidateAlbum = candidate.album || editionAlbumFallback || null;
  const editionGate = editionRenumberingGate({
    request,
    candidate,
    thresholds,
    trackNumberMismatch: evidence.trackNumber.mismatch,
    candidateAlbum,
  });

  // (3) Tracklist-aware edition path: the file's claimed position is checked
  // against the tracklist of the FILE's own release (per-medium numbering).
  // A confirmed position verifies even though the job's track number differs;
  // a fetched-but-contradicted tracklist disables the tolerance patch below.
  let editionContradicted = false;
  if (editionGate.eligible && Array.isArray(editionTracklist) && editionTracklist.length > 0) {
    const confirmed = confirmEditionRenumbering({
      tracklist: editionTracklist,
      discNumber: candidate.discNumber,
      trackNumber: candidate.trackNumber,
      fileTitle: candidate.title,
    });
    if (confirmed) {
      // Extra guard: edition renumbering only rescues an otherwise-strong
      // identity — fuzzy tags or a conflicting duration still need review.
      if (base.tagsMatchStrongly && evidence.duration.withinValidationWindow) {
        return { ...base, decision: "VERIFIED", reason: "edition renumbering confirmed" };
      }
    } else {
      editionContradicted = true;
    }
  }

  // (4) Same edition (or edition matching unavailable): a sibling title at the
  // file's claimed index in the REQUESTED release contradicts the file's own
  // position claim — the requested album's numbering is the right space here.
  if (
    !editionGate.eligible &&
    evidence.trackNumber.mismatch &&
    evidence.trackNumber.siblingAtIndex
  ) {
    return {
      ...base,
      decision: "CONFLICTED",
      reason: "embedded title names a sibling track from the requested release",
    };
  }

  // (5) Ordinary tag/shape flow with the track-number tolerance patch.
  let decision;
  let reason = null;
  if (base.tagsMatchStrongly && base.shapeAgrees) {
    decision = "VERIFIED";
  } else if (base.tagsMatchStrongly) {
    // Strong tag match with shape disagreement. If the only issue is track
    // number mismatch (duration is within tolerance), treat as verified —
    // this is typically a deluxe/standard edition difference, not a wrong
    // track. A tracklist that contradicted the file's position claim above
    // disables this relaxation.
    if (
      evidence.duration.withinValidationWindow &&
      evidence.trackNumber.mismatch &&
      trackNumberMismatchTolerance &&
      !editionContradicted
    ) {
      decision = "VERIFIED";
      reason = null;
    } else {
      decision = "AMBIGUOUS";
      reason = !evidence.duration.withinValidationWindow
        ? `duration mismatch: expected ${evidence.duration.expectedMs}ms, actual ${evidence.duration.actualMs}ms`
        : `track number mismatch: expected ${evidence.trackNumber.expected}, actual ${evidence.trackNumber.actual}`;
    }
  } else if (base.recommendation === "medium" && base.shapeAgrees) {
    decision = "AMBIGUOUS";
    reason = `moderate identity match (distance ${base.distance})`;
  } else {
    decision = "CONFLICTED";
    reason = `downloaded file does not match the requested track (distance ${base.distance})`;
  }

  if (decision === "VERIFIED" && evidence.trackNumber.siblingAtIndex && !editionGate.eligible) {
    decision = "CONFLICTED";
    reason = "embedded title names a sibling track from the requested release";
  }

  // (6) requireExactAlbumMatch hard gate: an album-name mismatch (normalized
  // comparison in readAlbumEvidence) caps verification at review, even when a
  // tracklist confirmed the edition renumbering. Step (1) returned early, so
  // an MBID-verified file is never downgraded by this gate.
  if (decision === "VERIFIED" && requireExactAlbumMatch && evidence.album === 0) {
    decision = "AMBIGUOUS";
    reason = `album mismatch: expected "${request.albumName}", actual "${candidateAlbum}"`;
  }

  return { ...base, decision, reason };
}

export function evaluateTrackIdentity({
  request,
  candidate,
  source = candidate?.source,
  match = null,
  thresholds = DEFAULT_MATCH_THRESHOLDS,
  providerEvidence = null,
  strict = false,
  phase = "pre",
  allowNoisyCandidates = false,
  // Album-version-aware post-download evidence. Both are additive and default
  // to null, so pre-download callers and any post caller that has not fetched
  // a tracklist keep the exact prior behavior (the edition path is skipped and
  // the tolerance patch in evaluatePostDownload decides).
  editionTracklist = null,
  editionAlbumFallback = null,
} = {}) {
  const hard = hardConflict({
    request,
    candidate,
    providerEvidence,
    strict,
    phase,
    allowNoisyCandidates,
  });
  if (hard.rejected) return hard;
  if (!match) return { ...hard, pending: true };
  const base = baseOutput({ request, candidate, match, evidence: hard, thresholds, phase });
  const evaluated = phase === "post"
    ? evaluatePostDownload({
        base,
        evidence: hard,
        request,
        thresholds,
        editionTracklist,
        editionAlbumFallback,
      })
    : evaluatePreDownload({ source, evidence: hard, base, thresholds });
  return {
    ...hard,
    ...evaluated,
    contradictions: hard.variant.contradictions,
    noise: hard.noise,
    providerEvidence: providerEvidence || {},
  };
}
