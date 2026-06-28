const express = require("express");
const adminAuthController = require("../../controllers/admin/adminAuth.controller");
const { requireAdminAuth } = require("../../middleware/adminAuth.middleware");

const router = express.Router();

router.post("/login", adminAuthController.login);
router.post("/refresh", adminAuthController.refresh);
router.post("/logout", requireAdminAuth, adminAuthController.logout);

module.exports = router;
