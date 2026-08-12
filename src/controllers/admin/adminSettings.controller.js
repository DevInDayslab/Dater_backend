const adminSettingsService = require("../../services/admin/adminSettings.service");

function handleError(res, error, fallbackMessage) {
  if (error.code === "INVALID_INPUT" || error.code === "INVALID_PASSWORD") {
    return res.status(400).json({ success: false, message: error.message, code: error.code });
  }
  if (error.code === "NOT_FOUND") {
    return res.status(404).json({ success: false, message: error.message, code: error.code });
  }
  return res.status(500).json({
    success: false,
    message: fallbackMessage,
    error: error.message,
  });
}

async function getAccount(req, res) {
  try {
    const data = await adminSettingsService.getAccount(req.admin.adminId);
    return res.status(200).json({
      success: true,
      message: "Admin account fetched",
      data,
    });
  } catch (error) {
    return handleError(res, error, "Failed to fetch admin account");
  }
}

async function changePassword(req, res) {
  try {
    const { currentPassword, newPassword } = req.body || {};
    const data = await adminSettingsService.changePassword({
      adminId: req.admin.adminId,
      sessionId: req.admin.sessionId,
      currentPassword,
      newPassword,
    });
    return res.status(200).json({
      success: true,
      message: "Password updated",
      data,
    });
  } catch (error) {
    return handleError(res, error, "Failed to update password");
  }
}

async function getSeoAdmin(req, res) {
  try {
    const data = await adminSettingsService.getSeoAdmin();
    return res.status(200).json({
      success: true,
      message: "SEO admin fetched",
      data,
    });
  } catch (error) {
    return handleError(res, error, "Failed to fetch SEO admin");
  }
}

async function upsertSeoAdmin(req, res) {
  try {
    const { email, password, name } = req.body || {};
    const data = await adminSettingsService.upsertSeoAdmin({ email, password, name });
    return res.status(200).json({
      success: true,
      message: "SEO admin saved",
      data,
    });
  } catch (error) {
    return handleError(res, error, "Failed to save SEO admin");
  }
}

async function listSeoAdminSessions(req, res) {
  try {
    const data = await adminSettingsService.listSeoAdminSessions();
    return res.status(200).json({
      success: true,
      message: "SEO admin sessions fetched",
      data,
    });
  } catch (error) {
    return handleError(res, error, "Failed to fetch SEO admin sessions");
  }
}

async function revokeSeoAdminSessions(req, res) {
  try {
    const data = await adminSettingsService.revokeSeoAdminSessions();
    return res.status(200).json({
      success: true,
      message: "SEO admin sessions revoked",
      data,
    });
  } catch (error) {
    return handleError(res, error, "Failed to revoke SEO admin sessions");
  }
}

module.exports = {
  getAccount,
  changePassword,
  getSeoAdmin,
  upsertSeoAdmin,
  listSeoAdminSessions,
  revokeSeoAdminSessions,
};
