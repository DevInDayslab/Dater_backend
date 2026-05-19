const { DetectFacesCommand } = require("@aws-sdk/client-rekognition");

const MIN_FACE_CONFIDENCE = 85;
const MIN_GENDER_CONFIDENCE = 85;
/** Primary face bounding box must cover at least this fraction of the image (width*height). */
const MIN_PRIMARY_FACE_AREA_FRACTION = 0.02;

/**
 * Woman-category sub-labels (gender_main is still "Woman"). Used only for logging / future rules.
 */
const WOMAN_SUB_GENDER_LABELS = new Set(
  [
    "woman",
    "intersex woman",
    "trans woman",
    "transfeminine",
    "woman and nonbinary",
    "cis woman",
  ].map((s) => s.toLowerCase())
);

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

async function loadUserGenderContext(userId) {
  const { query } = require("../config/db");
  const uRes = await query(
    `SELECT gender_main, gender
     FROM users
     WHERE id = $1::uuid
     LIMIT 1`,
    [userId]
  );
  const u = uRes.rows[0];
  if (!u) {
    return { genderMain: "", gender: "", moreOptions: [] };
  }
  const moreRes = await query(
    `SELECT gender FROM user_gender_more_options WHERE user_id = $1::uuid ORDER BY gender ASC`,
    [userId]
  );
  return {
    genderMain: String(u.gender_main || "").trim(),
    gender: String(u.gender || "").trim(),
    moreOptions: moreRes.rows.map((r) => String(r.gender || "").trim()).filter(Boolean),
  };
}

function profileRequiresFemaleFace(genderContext) {
  const main = genderContext.genderMain.toLowerCase();
  if (main === "woman") return true;
  const legacy = genderContext.gender.toLowerCase();
  if (legacy === "woman") return true;
  if (WOMAN_SUB_GENDER_LABELS.has(legacy)) return true;
  for (const opt of genderContext.moreOptions) {
    const o = opt.toLowerCase();
    if (o === "woman" || WOMAN_SUB_GENDER_LABELS.has(o)) return true;
  }
  return false;
}

/**
 * Gender alignment for Woman profiles. Non-woman profiles skip this check.
 * Mismatch is a hard reject (photo removed, same as other moderation failures).
 */
function evaluateGenderAlignment(genderContext, faceEval) {
  if (!profileRequiresFemaleFace(genderContext)) {
    return { passed: true, skipped: true, requiresFemale: false };
  }

  const value = String(faceEval.primaryGenderValue || "").trim();
  const conf = Number(faceEval.primaryGenderConfidence || 0);

  if (value === "Female" && conf >= MIN_GENDER_CONFIDENCE) {
    return {
      passed: true,
      skipped: false,
      requiresFemale: true,
      detectedValue: value,
      detectedConfidence: conf,
    };
  }

  return {
    passed: false,
    skipped: false,
    requiresFemale: true,
    code: "GENDER_MISMATCH",
    detectedValue: value || "Unknown",
    detectedConfidence: conf,
    multipleFaces: faceEval.multipleFaces === true,
  };
}

/**
 * Run DetectFaces on JPEG bytes (Attributes ALL for Gender + quality signals).
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
  MIN_GENDER_CONFIDENCE,
  MIN_PRIMARY_FACE_AREA_FRACTION,
  detectFacesOnJpeg,
  evaluateFacePresence,
  evaluateGenderAlignment,
  loadUserGenderContext,
  profileRequiresFemaleFace,
  summarizeFaces,
  pickPrimaryFace,
};
