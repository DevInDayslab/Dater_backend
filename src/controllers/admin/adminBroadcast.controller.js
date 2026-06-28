const adminBroadcastService = require("../../services/admin/adminBroadcast.service");

function handleError(res, error, fallbackMessage) {
  const code = error.code;
  if (
    code === "INVALID_AUDIENCE" ||
    code === "CITY_REQUIRED" ||
    code === "INVALID_BROADCAST"
  ) {
    return res.status(400).json({ success: false, message: error.message, code });
  }
  return res.status(500).json({
    success: false,
    message: fallbackMessage,
    error: error.message,
  });
}

async function getAudienceSize(req, res) {
  try {
    const { audience, city } = req.body || {};
    const data = await adminBroadcastService.getAudienceSize({ audience, city });
    return res.status(200).json({
      success: true,
      message: "Audience size estimated",
      data,
    });
  } catch (error) {
    return handleError(res, error, "Failed to estimate audience size");
  }
}

async function sendBroadcast(req, res) {
  try {
    const { title, body, audience, city, deepLink } = req.body || {};
    const sentByAdminId =
      req.admin?.adminId && req.admin.adminId !== "api-key" ? req.admin.adminId : null;
    const data = await adminBroadcastService.sendBroadcast({
      title,
      body,
      audience,
      city,
      deepLink,
      sentByAdminId,
    });
    return res.status(200).json({
      success: true,
      message: "Broadcast sent",
      data,
    });
  } catch (error) {
    return handleError(res, error, "Failed to send broadcast");
  }
}

async function listBroadcasts(req, res) {
  try {
    const data = await adminBroadcastService.listBroadcasts(req.query);
    return res.status(200).json({
      success: true,
      message: "Broadcast history fetched",
      data,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch broadcast history",
      error: error.message,
    });
  }
}

module.exports = {
  getAudienceSize,
  sendBroadcast,
  listBroadcasts,
};
