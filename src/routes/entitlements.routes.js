const express = require("express");
const { requireAuth } = require("../middleware/auth.middleware");
const entitlementsController = require("../controllers/entitlements.controller");

const router = express.Router();

router.get("/me", requireAuth, entitlementsController.getMyEntitlements);
router.post("/premium/purchase", requireAuth, entitlementsController.purchasePremium);
router.post("/boost/purchase", requireAuth, entitlementsController.purchaseBoost);
router.post("/boost/activate", requireAuth, entitlementsController.activateBoost);
router.post("/comments/purchase", requireAuth, entitlementsController.purchaseComments);
router.post("/comments/consume", requireAuth, entitlementsController.consumeComments);

module.exports = router;

