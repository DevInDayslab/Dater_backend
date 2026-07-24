const express = require("express");
const { requireAuth } = require("../middleware/auth.middleware");
const applePaymentsController = require("../controllers/applePayments.controller");

const router = express.Router();

// Public — mirrors GET /api/v1/config/products for iOS StoreKit IDs only.
router.get("/apple-catalog", applePaymentsController.getAppleCatalog);

// App Store Server Notifications V2 (no JWT — Apple posts directly).
router.post("/apple-webhook", applePaymentsController.appleWebhook);

// Authenticated Apple StoreKit 2 verification (Android uses /billing/verify-purchase).
router.post("/verify-apple-purchase", requireAuth, applePaymentsController.verifyApplePurchase);

// Redeem a pending chat-unlock credit (orphaned Apple purchase without threadId).
router.post("/redeem-chat-unlock-credit", requireAuth, applePaymentsController.redeemChatUnlockCredit);

module.exports = router;
