const express = require("express");
const adminSettingsController = require("../../controllers/admin/adminSettings.controller");

const router = express.Router();

router.get("/account", adminSettingsController.getAccount);
router.post("/change-password", adminSettingsController.changePassword);
router.get("/seo-admin", adminSettingsController.getSeoAdmin);
router.put("/seo-admin", adminSettingsController.upsertSeoAdmin);
router.get("/seo-admin/sessions", adminSettingsController.listSeoAdminSessions);
router.post("/seo-admin/revoke-sessions", adminSettingsController.revokeSeoAdminSessions);

module.exports = router;
