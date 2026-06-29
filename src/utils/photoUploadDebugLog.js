const { debugLog, shouldLog } = require("./serverDebugLog");
const {
  MIN_FACE_CONFIDENCE,
  MIN_PRIMARY_FACE_AREA_FRACTION,
} = require("../services/photoFaceValidation.service");
const { MIN_CONFIDENCE: MIN_MODERATION_CONFIDENCE } = require("../services/photoModeration.service");

/** Include reject step + Rekognition summary in API JSON (dev / explicit flag only). */
function includeRejectDetailInResponse() {
  if (process.env.DEBUG_PHOTO_REJECT_DETAIL === "1") return true;
  if (process.env.DEBUG_SERVER_LOG === "1") return true;
  if (process.env.NODE_ENV === "production") return false;
  return true;
}

function round1(n) {
  return Math.round(Number(n || 0) * 10) / 10;
}

function faceBoundingBoxArea(face) {
  const bb = face?.BoundingBox;
  if (!bb) return 0;
  const w = Number(bb.Width || 0);
  const h = Number(bb.Height || 0);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Per-face Rekognition summary for logs (largest-first).
 */
function serializeFacesForLog(faceDetails) {
  const faces = [...(faceDetails || [])];
  faces.sort((a, b) => faceBoundingBoxArea(b) - faceBoundingBoxArea(a));
  return faces.map((face, index) => {
    const bb = face?.BoundingBox || {};
    return {
      rank: index + 1,
      isPrimaryByArea: index === 0,
      faceConfidence: round1(face?.Confidence),
      bboxAreaFraction: round1(faceBoundingBoxArea(face)),
      bboxWidth: round1(bb.Width),
      bboxHeight: round1(bb.Height),
      genderValue: face?.Gender?.Value ?? null,
      genderConfidence: face?.Gender ? round1(face.Gender.Confidence) : null,
    };
  });
}

/**
 * One object to grep: photo_confirm_scan
 */
function logPhotoConfirmScan(ctx, scan) {
  if (!shouldLog()) return;

  const moderation = scan?.moderation || {};
  const facePresence = scan?.facePresence || {};

  debugLog("photo_confirm_scan", {
    ...ctx,
    thresholds: {
      moderationMinConfidence: MIN_MODERATION_CONFIDENCE,
      faceMinConfidence: MIN_FACE_CONFIDENCE,
      faceMinBboxAreaFraction: MIN_PRIMARY_FACE_AREA_FRACTION,
    },
    moderation: {
      passed: moderation.failedModeration !== true,
      policyHits: moderation.policyHits ?? [],
      labelsAtThreshold: moderation.labelsAtThreshold ?? [],
    },
    facePresence: {
      passed: facePresence.passed === true,
      code: facePresence.code ?? null,
      reason: facePresence.reason ?? null,
      faceCount: facePresence.faceCount ?? 0,
      primaryConfidence: round1(facePresence.primaryConfidence),
      primaryAreaFraction: round1(facePresence.primaryAreaFraction),
      multipleFaces: facePresence.multipleFaces === true,
      primaryGenderValue: facePresence.primaryGenderValue ?? null,
      primaryGenderConfidence: round1(facePresence.primaryGenderConfidence),
    },
    facesDetected: serializeFacesForLog(scan?.faceDetails),
    faceSummary: scan?.faceSummary ?? null,
    sourceWebpBytes: scan?.sourceWebpBytes,
    jpegBytes: scan?.jpegBytes,
  });
}

/**
 * Grep: photo_confirm_REJECTED
 * @param {string} step - MODERATION | FACE_PRESENCE | FACE_COMPARE | FACE_COMPARE_ERROR
 */
function logPhotoConfirmRejected(ctx, step, code, detail = {}) {
  if (!shouldLog()) return;
  debugLog("photo_confirm_REJECTED", {
    ...ctx,
    rejectStep: step,
    rejectCode: code,
    ...detail,
  });
}

function logPhotoConfirmApproved(ctx, detail = {}) {
  if (!shouldLog()) return;
  debugLog("photo_confirm_APPROVED", { ...ctx, ...detail });
}

function logFaceCompare(ctx, detail) {
  if (!shouldLog()) return;
  debugLog("photo_confirm_face_compare", { ...ctx, ...detail });
}

function attachRejectDebugToPayload(data, step, detail) {
  if (!includeRejectDetailInResponse()) return data;
  return {
    ...data,
    debugRejectStep: step,
    debugRejectDetail: detail,
  };
}

module.exports = {
  includeRejectDetailInResponse,
  serializeFacesForLog,
  logPhotoConfirmScan,
  logPhotoConfirmRejected,
  logPhotoConfirmApproved,
  logFaceCompare,
  attachRejectDebugToPayload,
};
