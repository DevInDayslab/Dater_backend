const express = require("express");
const adminSettingsController = require("../../controllers/admin/adminSettings.controller");

const router = express.Router();

router.get("/admins", adminSettingsController.listAdmins);
router.post("/admins", adminSettingsController.createAdmin);
router.patch("/admins/:adminId", adminSettingsController.updateAdminStatus);

module.exports = router;
