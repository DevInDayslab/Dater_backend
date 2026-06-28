const adminSettingsService = require("../../services/admin/adminSettings.service");

function handleError(res, error, fallbackMessage) {
  const code = error.code;
  if (code === "INVALID_INPUT" || code === "WEAK_PASSWORD" || code === "INVALID_STATUS") {
    return res.status(400).json({ success: false, message: error.message, code });
  }
  if (code === "EMAIL_EXISTS") {
    return res.status(409).json({ success: false, message: error.message, code });
  }
  return res.status(500).json({
    success: false,
    message: fallbackMessage,
    error: error.message,
  });
}

async function listAdmins(req, res) {
  try {
    const admins = await adminSettingsService.listAdmins();
    return res.status(200).json({
      success: true,
      message: "Admin users fetched",
      data: { admins },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch admin users",
      error: error.message,
    });
  }
}

async function createAdmin(req, res) {
  try {
    const { email, name, password } = req.body || {};
    const admin = await adminSettingsService.createAdmin({ email, name, password });
    return res.status(201).json({
      success: true,
      message: "Admin user created",
      data: { admin },
    });
  } catch (error) {
    return handleError(res, error, "Failed to create admin user");
  }
}

async function updateAdminStatus(req, res) {
  try {
    const { status } = req.body || {};
    const result = await adminSettingsService.updateAdminStatus(req.params.adminId, { status });
    if (result.notFound) {
      return res.status(404).json({ success: false, message: "Admin user not found" });
    }
    return res.status(200).json({
      success: true,
      message: "Admin status updated",
      data: { admin: result },
    });
  } catch (error) {
    return handleError(res, error, "Failed to update admin status");
  }
}

module.exports = {
  listAdmins,
  createAdmin,
  updateAdminStatus,
};
