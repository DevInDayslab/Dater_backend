const express = require("express");
const adminRevenueController = require("../../controllers/admin/adminRevenue.controller");

const router = express.Router();

router.get("/summary", adminRevenueController.getSummary);
router.get("/top-buyers", adminRevenueController.getTopBuyers);
router.get("/pack-breakdown", adminRevenueController.getPackBreakdown);

module.exports = router;
