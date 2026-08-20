const express = require("express");
const adminDashboardController = require("../../controllers/admin/adminDashboard.controller");

const router = express.Router();

router.get("/stats", adminDashboardController.getStats);
router.get("/growth", adminDashboardController.getGrowth);
router.get("/badges", adminDashboardController.getBadges);
router.get("/breakdowns", adminDashboardController.getBreakdowns);
router.get("/revenue", adminDashboardController.getRevenue);
router.get("/push-health", adminDashboardController.getPushHealth);

module.exports = router;
