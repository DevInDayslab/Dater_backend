const adminAuthService = require("../../services/admin/adminAuth.service");
const { extractBearerToken } = require("../../middleware/adminAuth.middleware");

function clientMeta(req) {
  return {
    ipAddress: req.ip || req.headers["x-forwarded-for"] || null,
    userAgent: req.headers["user-agent"] || null,
  };
}

async function login(req, res) {
  try {
    const { email, password, portal } = req.body || {};
    const result = await adminAuthService.login({
      email,
      password,
      portal,
      ...clientMeta(req),
    });
    return res.status(200).json({
      success: true,
      message: "Admin login successful",
      data: {
        accessToken: result.accessToken,
        expiresAt: result.expiresAt,
        admin: result.admin,
      },
    });
  } catch (error) {
    const status =
      error.code === "INVALID_CREDENTIALS" || error.code === "WRONG_PORTAL" ? 401 : 500;
    return res.status(status).json({
      success: false,
      message: error.message || "Admin login failed",
      code: error.code,
    });
  }
}

async function refresh(req, res) {
  try {
    const token = extractBearerToken(req) || String(req.body?.accessToken || "").trim();
    const rotated = await adminAuthService.refresh({
      token,
      ...clientMeta(req),
    });
    return res.status(200).json({
      success: true,
      message: "Admin token refreshed",
      data: {
        accessToken: rotated.accessToken,
        expiresAt: rotated.expiresAt,
      },
    });
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: error.message || "Failed to refresh admin token",
      code: error.code || "REFRESH_FAILED",
    });
  }
}

async function logout(req, res) {
  try {
    if (req.admin?.sessionId) {
      await adminAuthService.logout({ sessionId: req.admin.sessionId });
    }
    return res.status(200).json({
      success: true,
      message: "Admin logged out",
      data: {},
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || "Admin logout failed",
    });
  }
}

module.exports = {
  login,
  refresh,
  logout,
};
