const express = require("express");
const adminAppConfigController = require("../../controllers/admin/adminAppConfig.controller");

const router = express.Router();

router.get("/", adminAppConfigController.getAppConfig);
router.post("/splash/presign", adminAppConfigController.presignSplashUpload);
router.patch("/", adminAppConfigController.updateAppConfig);

module.exports = router;
