const { DetectFacesCommand } = require("@aws-sdk/client-rekognition");

const MIN_FACE_CONFIDENCE = 80;
/** Primary face bounding box must cover at least this fraction of the image (width*height). */
const MIN_PRIMARY_FACE_AREA_FRACTION = 0.015;

function faceBoundingBoxArea(face) {
  const bb = face?.BoundingBox;
  if (!bb) return 0;
  const w = Number(bb.Width || 0);
  const h = Number(bb.Height || 0);
  return w > 0 && h > 0 ? w * h : 0;
}

function pickPrimaryFace(faceDetails) {
  if (!faceDetails?.length) return null;
  let best = null;
  let bestArea = 0;
  for (const face of faceDetails) {
    const area = faceBoundingBoxArea(face);
    if (area > bestArea) {
      best = face;
      bestArea = area;
    }
  }
  return best;
}

/**
 * @param {import("@aws-sdk/client-rekognition").FaceDetail[]|undefined} faceDetails
 */
function evaluateFacePresence(faceDetails) {
  const faces = faceDetails || [];
  if (faces.length === 0) {
    return {
      passed: false,
      code: "FACE_NOT_DETECTED",
      faceCount: 0,
      primaryConfidence: 0,
      primaryAreaFraction: 0,
      multipleFaces: false,
    };
  }

  const primary = pickPrimaryFace(faces);
  const confidence = Number(primary?.Confidence || 0);
  const areaFraction = faceBoundingBoxArea(primary);

  if (confidence < MIN_FACE_CONFIDENCE) {
    return {
      passed: false,
      code: "FACE_NOT_DETECTED",
      faceCount: faces.length,
      primaryConfidence: confidence,
      primaryAreaFraction: areaFraction,
      multipleFaces: faces.length > 1,
    };
  }

  if (areaFraction < MIN_PRIMARY_FACE_AREA_FRACTION) {
    return {
      passed: false,
      code: "FACE_NOT_DETECTED",
      faceCount: faces.length,
      primaryConfidence: confidence,
      primaryAreaFraction: areaFraction,
      multipleFaces: faces.length > 1,
      reason: "face_too_small",
    };
  }

  return {
    passed: true,
    code: null,
    faceCount: faces.length,
    primaryConfidence: confidence,
    primaryAreaFraction: areaFraction,
    multipleFaces: faces.length > 1,
    primaryGenderValue: primary?.Gender?.Value || null,
    primaryGenderConfidence: Number(primary?.Gender?.Confidence || 0),
  };
}

/**
 * Run DetectFaces on JPEG bytes (Attributes ALL for quality signals).
 */
async function detectFacesOnJpeg(rekognition, jpegBytes) {
  const out = await rekognition.send(
    new DetectFacesCommand({
      Image: { Bytes: jpegBytes },
      Attributes: ["ALL"],
    })
  );
  return out.FaceDetails || [];
}

function summarizeFaces(faceDetails) {
  const primary = pickPrimaryFace(faceDetails);
  return {
    faceCount: (faceDetails || []).length,
    primaryConfidence: primary ? Math.round(Number(primary.Confidence || 0) * 10) / 10 : 0,
    primaryGender: primary?.Gender?.Value || null,
    primaryGenderConfidence: primary?.Gender
      ? Math.round(Number(primary.Gender.Confidence || 0) * 10) / 10
      : 0,
  };
}

module.exports = {
  MIN_FACE_CONFIDENCE,
  MIN_PRIMARY_FACE_AREA_FRACTION,
  detectFacesOnJpeg,
  evaluateFacePresence,
  summarizeFaces,
  pickPrimaryFace,
};
