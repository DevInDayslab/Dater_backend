const express = require("express");
const adminBroadcastController = require("../../controllers/admin/adminBroadcast.controller");

const router = express.Router();

router.post("/audience-size", adminBroadcastController.getAudienceSize);
router.post("/", adminBroadcastController.sendBroadcast);
router.get("/history", adminBroadcastController.listBroadcasts);

module.exports = router;
