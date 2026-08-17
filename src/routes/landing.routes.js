const express = require("express");
const landingController = require("../controllers/landing.controller");
const {
  landingContactBurstLimiter,
  landingContactDailyLimiter,
  landingContactPresignLimiter,
} = require("../middleware/landingContactLimiter.middleware");

const router = express.Router();

// Public read-only SEO metadata for browser tab / client-side head updates.
router.get("/seo-meta/:slug", landingController.getSeoMeta);
router.get("/seo-meta", landingController.getSeoMeta);

// Public OG/Twitter image proxy (private S3 → crawlable URL).
router.get("/seo-media/*key", landingController.serveSeoMedia);

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
