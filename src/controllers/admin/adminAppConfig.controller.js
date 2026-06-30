const adminAppConfigService = require("../../services/admin/adminAppConfig.service");

function handleError(res, error, fallbackMessage) {
  if (error.code === "INVALID_INPUT") {
    return res.status(400).json({ success: false, message: error.message, code: error.code });
  }
  return res.status(500).json({
    success: false,
    message: fallbackMessage,
    error: error.message,
  });
}

async function getAppConfig(req, res) {
  try {
    const data = await adminAppConfigService.getAppConfig();
    return res.status(200).json({
      success: true,
      message: "App config fetched",
      data,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch app config",
      error: error.message,
    });
  }
}

async function presignSplashUpload(req, res) {
  try {
    const data = await adminAppConfigService.presignSplashUpload(req.body?.contentType);
    return res.status(200).json({
      success: true,
      message: "Splash upload URL generated",
      data,
    });
  } catch (error) {
    return handleError(res, error, "Failed to generate splash upload URL");
  }
}

async function updateAppConfig(req, res) {
  try {
    const data = await adminAppConfigService.updateAppConfig(req.body);
    return res.status(200).json({
      success: true,
      message: "App config updated",
      data,
    });
  } catch (error) {
    return handleError(res, error, "Failed to update app config");
  }
}

module.exports = {
  getAppConfig,
  presignSplashUpload,
  updateAppConfig,
};
