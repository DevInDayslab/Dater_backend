const express = require("express");
const { requireAuth } = require("../middleware/auth.middleware");
const billingController = require("../controllers/billing.controller");
const googlePlayRtdnService = require("../services/googlePlayRtdn.service");
const { requirePubSubAuth } = require("../middleware/pubsubAuth.middleware");

const router = express.Router();

router.post("/verify-purchase", requireAuth, billingController.verifyPurchase);
router.post("/google-webhook", requirePubSubAuth, googlePlayRtdnService.handleWebhook);

module.exports = router;
