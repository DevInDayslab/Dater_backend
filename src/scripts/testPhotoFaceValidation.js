/**
 * Offline checks for photo face / gender alignment helpers (no AWS).
 * Run: node src/scripts/testPhotoFaceValidation.js
 */
const {
  evaluateFacePresence,
  evaluateGenderAlignment,
  profileRequiresFemaleFace,
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

  const womanCtx = { genderMain: "Woman", gender: "", moreOptions: [] };
  assert(profileRequiresFemaleFace(womanCtx), "Woman main requires check");
  const manCtx = { genderMain: "Man", gender: "", moreOptions: [] };
  assert(!profileRequiresFemaleFace(manCtx), "Man skips gender check");

  const genderPass = evaluateGenderAlignment(womanCtx, ok);
  assert(genderPass.passed, "Female >= 85 passes");

  const genderReject = evaluateGenderAlignment(womanCtx, {
    ...ok,
    primaryGenderValue: "Male",
    primaryGenderConfidence: 92,
  });
  assert(!genderReject.passed && genderReject.code === "GENDER_MISMATCH", "male gender mismatch");

  const skip = evaluateGenderAlignment(manCtx, ok);
  assert(skip.skipped && skip.passed, "non-woman skips");

  console.log("photoFaceValidation: all checks passed");
}

main();
