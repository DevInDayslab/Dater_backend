const express = require("express");
const landingController = require("../controllers/landing.controller");
const {
  landingContactBurstLimiter,
  landingContactDailyLimiter,
  landingContactPresignLimiter,
} = require("../middleware/landingContactLimiter.middleware");

const router = express.Router();

router.post(
  "/contact/presign-attachment",
  landingContactPresignLimiter,
  landingController.presignAttachment
);
router.post(
  "/contact",
  landingContactBurstLimiter,
  landingContactDailyLimiter,
  landingController.submitContact
);

module.exports = router;
