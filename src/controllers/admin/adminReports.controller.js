const adminReportsService = require("../../services/admin/adminReports.service");

async function listReports(req, res) {
  try {
    const data = await adminReportsService.listReports(req.query);
    return res.status(200).json({
      success: true,
      message: "Reports fetched",
      data,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch reports",
      error: error.message,
    });
  }
}

async function getReport(req, res) {
  try {
    const data = await adminReportsService.getReportDetail(req.params.reportId);
    if (!data) {
      return res.status(404).json({ success: false, message: "Report not found" });
    }
    return res.status(200).json({
      success: true,
      message: "Report detail fetched",
      data,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch report detail",
      error: error.message,
    });
  }
}

async function dismissReport(req, res) {
  try {
    const result = await adminReportsService.dismissReport(req.params.reportId);
    if (result.notFound) {
      return res.status(404).json({ success: false, message: "Report not found" });
    }
    return res.status(200).json({
      success: true,
      message: "Report dismissed",
      data: {
        dismissedReportId: result.dismissedReportId,
        reportedUserId: result.reportedUserId,
        totalReportsRemaining: result.reconcile.totalReports,
        moderationWarningCount: result.reconcile.expectedWarnings,
        userUnbanned: result.reconcile.userUnbanned,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to dismiss report",
      error: error.message,
    });
  }
}

module.exports = {
  listReports,
  getReport,
  dismissReport,
};
