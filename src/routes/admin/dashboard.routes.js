const express = require("express");
const adminDashboardController = require("../../controllers/admin/adminDashboard.controller");

const router = express.Router();

router.get("/stats", adminDashboardController.getStats);
router.get("/growth", adminDashboardController.getGrowth);
router.get("/badges", adminDashboardController.getBadges);

module.exports = router;
