const adminRevenueService = require("../../services/admin/adminRevenue.service");

async function getSummary(req, res) {
  try {
    const data = await adminRevenueService.getRevenueSummary(req.query.window || "30d");
    return res.status(200).json({
      success: true,
      message: "Revenue summary fetched",
      data,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch revenue summary",
      error: error.message,
    });
  }
}

async function getTopBuyers(req, res) {
  try {
    const data = await adminRevenueService.getTopBuyers(req.query.window || "30d", req.query);
    return res.status(200).json({
      success: true,
      message: "Top buyers fetched",
      data,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch top buyers",
      error: error.message,
    });
  }
}

async function getPackBreakdown(req, res) {
  try {
    const data = await adminRevenueService.getPackBreakdown(req.query.window || "30d");
    return res.status(200).json({
      success: true,
      message: "Pack breakdown fetched",
      data,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch pack breakdown",
      error: error.message,
    });
  }
}

module.exports = {
  getSummary,
  getTopBuyers,
  getPackBreakdown,
};
