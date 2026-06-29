/**
 * Offline checks for photo face presence helpers (no AWS).
 * Run: node src/scripts/testPhotoFaceValidation.js
 */
const {
  evaluateFacePresence,
  pickPrimaryFace,
} = require("../services/photoFaceValidation.service");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function face(conf, w, h, genderValue, genderConf) {
  return {
    Confidence: conf,
    BoundingBox: { Width: w, Height: h },
    Gender: genderValue ? { Value: genderValue, Confidence: genderConf } : undefined,
  };
}

function main() {
  const empty = evaluateFacePresence([]);
  assert(!empty.passed && empty.code === "FACE_NOT_DETECTED", "empty faces fail");

  const lowConf = evaluateFacePresence([face(50, 0.3, 0.3)]);
  assert(!lowConf.passed, "low confidence fails");

  const tiny = evaluateFacePresence([face(95, 0.05, 0.05)]);
  assert(!tiny.passed && tiny.reason === "face_too_small", "tiny bbox fails");

  const ok = evaluateFacePresence([face(95, 0.25, 0.25, "Female", 90)]);
  assert(ok.passed, "valid solo face passes");

  const group = [face(90, 0.1, 0.1, "Male", 95), face(92, 0.35, 0.35, "Female", 90)];
  const primary = pickPrimaryFace(group);
  assert(primary === group[1], "largest bbox wins");
  const groupEval = evaluateFacePresence(group);
  assert(groupEval.passed && groupEval.multipleFaces, "group with large primary passes");

  console.log("photoFaceValidation: all checks passed");
}

main();
