const express = require("express");
const landingController = require("../controllers/landing.controller");
const { landingContactLimiter } = require("../middleware/landingContactLimiter.middleware");

const router = express.Router();

router.post(
  "/contact/presign-attachment",
  landingContactLimiter,
  landingController.presignAttachment
);
router.post("/contact", landingContactLimiter, landingController.submitContact);

module.exports = router;
