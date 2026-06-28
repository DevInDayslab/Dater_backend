const adminDashboardService = require("../../services/admin/adminDashboard.service");

async function getStats(req, res) {
  try {
    const window = req.query.window || "7d";
    const stats = await adminDashboardService.getDashboardStats(window);
    return res.status(200).json({
      success: true,
      message: "Dashboard stats fetched",
      data: stats,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch dashboard stats",
      error: error.message,
    });
  }
}

async function getGrowth(req, res) {
  try {
    const window = req.query.window || "30d";
    const growth = await adminDashboardService.getUserGrowth(window);
    return res.status(200).json({
      success: true,
      message: "User growth fetched",
      data: growth,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch user growth",
      error: error.message,
    });
  }
}

async function getBadges(req, res) {
  try {
    const badges = await adminDashboardService.getDashboardBadges();
    return res.status(200).json({
      success: true,
      message: "Dashboard badges fetched",
      data: badges,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch dashboard badges",
      error: error.message,
    });
  }
}

async function getBreakdowns(req, res) {
  try {
    const breakdowns = await adminDashboardService.getDashboardBreakdowns();
    return res.status(200).json({
      success: true,
      message: "Dashboard breakdowns fetched",
      data: breakdowns,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch dashboard breakdowns",
      error: error.message,
    });
  }
}

async function getRevenue(req, res) {
  try {
    const window = req.query.window || "30d";
    const revenue = await adminDashboardService.getDashboardRevenue(window);
    return res.status(200).json({
      success: true,
      message: "Dashboard revenue fetched",
      data: revenue,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch dashboard revenue",
      error: error.message,
    });
  }
}

module.exports = {
  getStats,
  getGrowth,
  getBadges,
  getBreakdowns,
  getRevenue,
};
