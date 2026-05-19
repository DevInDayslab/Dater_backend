const { RekognitionClient, DetectModerationLabelsCommand } = require("@aws-sdk/client-rekognition");
const sharp = require("sharp");
const s3Media = require("./s3Media.service");
const photoFaceValidation = require("./photoFaceValidation.service");

const region = process.env.AWS_REGION || "ap-south-1";
const MIN_CONFIDENCE = 80;

const rekognition = new RekognitionClient({ region });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Rekognition Image API accepts JPEG/PNG bytes, not WebP from S3 directly.
 * Retry transient S3 read / eventual consistency issues.
 */
function isRetriableModerationScanError(err) {
  const name = err?.name || err?.Code || "";
  const msg = String(err?.message || "").toLowerCase();
  if (name === "InvalidS3ObjectException") return true;
  if (msg.includes("invalids3objectexception")) return true;
  if (msg.includes("unable to get object")) return true;
  if (msg.includes("unable to get object metadata")) return true;
  if (msg.includes("object does not exist")) return true;
  if (msg.includes("not found") && msg.includes("s3")) return true;
  if (msg.includes("throttl")) return true;
  return false;
}

/**
 * Uses Rekognition moderation taxonomy (parent + name) at >= MIN_CONFIDENCE.
 */
function evaluateHighRiskModeration(labels) {
  const hits = [];
  for (const label of labels) {
    const confidence = label.Confidence ?? 0;
    if (confidence < MIN_CONFIDENCE) continue;
    const name = String(label.Name || "").toLowerCase();
    const parent = String(label.ParentName || "").toLowerCase();
    const haystack = `${parent} ${name}`;

    const explicitSexual =
      haystack.includes("explicit nudity") ||
      haystack.includes("graphic male nudity") ||
      haystack.includes("graphic female nudity") ||
      haystack.includes("sexual activity");

    const violence =
      haystack.includes("violence") ||
      haystack.includes("visually disturbing") ||
      haystack.includes("blood") ||
      haystack.includes("gore") ||
      haystack.includes("corpse") ||
      haystack.includes("self-injury");

    const weapons =
      haystack.includes("weapon") ||
      haystack.includes("firearm") ||
      haystack.includes("gun") ||
      haystack.includes("knife") ||
      haystack.includes("explosive") ||
      haystack.includes("ammunition");

    if (explicitSexual || violence || weapons) {
      const rule = explicitSexual ? "explicit_or_sexual" : weapons ? "weapons" : "violence";
      hits.push({
        name: label.Name,
        parentName: label.ParentName,
        confidence: Math.round(confidence * 10) / 10,
        rule,
      });
    }
  }
  return { failed: hits.length > 0, hits };
}

function summarizeLabels(labels) {
  return (labels || []).map((l) => ({
    name: l.Name,
    parent: l.ParentName,
    confidence: Math.round((l.Confidence ?? 0) * 10) / 10,
  }));
}

/**
 * Download from S3 and transcode to JPEG (shared by moderation + face scans).
 */
async function transcodeS3KeyToJpeg(s3Key) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await s3Media.getObjectBytes(s3Key);
      const jpeg = await sharp(raw)
        .rotate()
        .jpeg({ quality: 88, mozjpeg: true })
        .toBuffer();
      return { raw, jpeg };
    } catch (err) {
      lastErr = err;
      if (attempt === 0 && isRetriableModerationScanError(err)) {
        await sleep(500);
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error("S3 transcode failed");
}

async function scanJpegForModerationDetail(jpeg, sourceByteLength) {
  const out = await rekognition.send(
    new DetectModerationLabelsCommand({
      Image: { Bytes: jpeg },
      MinConfidence: MIN_CONFIDENCE,
    })
  );
  const labels = out.ModerationLabels || [];
  const { failed, hits } = evaluateHighRiskModeration(labels);
  return {
    failedModeration: failed,
    sourceWebpBytes: sourceByteLength,
    jpegBytes: jpeg.length,
    labelsAtThreshold: summarizeLabels(labels),
    policyHits: hits,
  };
}

/**
 * Parallel moderation + face scan on one JPEG buffer.
 * @returns {{
 *   moderation: object,
 *   faceDetails: import("@aws-sdk/client-rekognition").FaceDetail[],
 *   facePresence: object,
 *   genderAlignment: object,
 *   genderContext: object,
 * }}
 */
async function scanJpegForUploadValidation(jpeg, sourceByteLength, userId) {
  const [moderation, faceDetails] = await Promise.all([
    scanJpegForModerationDetail(jpeg, sourceByteLength),
    photoFaceValidation.detectFacesOnJpeg(rekognition, jpeg),
  ]);

  const facePresence = photoFaceValidation.evaluateFacePresence(faceDetails);
  const genderContext = await photoFaceValidation.loadUserGenderContext(userId);
  const genderAlignment = photoFaceValidation.evaluateGenderAlignment(genderContext, facePresence);

  return {
    moderation,
    faceDetails,
    facePresence,
    genderAlignment,
    genderContext,
    faceSummary: photoFaceValidation.summarizeFaces(faceDetails),
  };
}

/**
 * Download from S3, transcode WebP (or other) to JPEG, run Rekognition on bytes.
 * @returns {{ failedModeration: boolean, sourceWebpBytes: number, jpegBytes: number, labelsAtThreshold: object[], policyHits: object[] }}
 */
async function scanS3ObjectForModerationDetail(s3Key) {
  const { raw, jpeg } = await transcodeS3KeyToJpeg(s3Key);
  return scanJpegForModerationDetail(jpeg, raw.length);
}

/**
 * Full upload validation: NSFW/moderation + human face + optional woman→female alignment.
 */
async function scanS3ObjectForUploadValidation(s3Key, userId) {
  const { raw, jpeg } = await transcodeS3KeyToJpeg(s3Key);
  const validation = await scanJpegForUploadValidation(jpeg, raw.length, userId);
  return {
    ...validation,
    sourceWebpBytes: raw.length,
    jpegBytes: jpeg.length,
  };
}

async function scanS3ObjectForModerationFailure(s3Key) {
  const r = await scanS3ObjectForModerationDetail(s3Key);
  return r.failedModeration;
}

module.exports = {
  scanS3ObjectForModerationFailure,
  scanS3ObjectForModerationDetail,
  scanS3ObjectForUploadValidation,
  transcodeS3KeyToJpeg,
  MIN_CONFIDENCE,
};
