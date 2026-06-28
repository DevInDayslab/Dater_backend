const adminAuthService = require("../services/admin/adminAuth.service");

function extractBearerToken(req) {
  const authHeader = req.headers.authorization || "";
  return authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
}

async function requireAdminAuth(req, res, next) {
  try {
    const configuredKey = process.env.ADMIN_API_KEY;
    const providedKey = String(req.headers["x-admin-api-key"] || "").trim();

    if (configuredKey && providedKey && providedKey === configuredKey) {
      req.admin = {
        adminId: "api-key",
        sessionId: null,
        jwtId: null,
        email: "api-key@admin",
        name: "API Key Admin",
        viaApiKey: true,
      };
      return next();
    }

    const token = extractBearerToken(req);
    req.admin = await adminAuthService.verifyAdminAccessToken(token);
    return next();
  } catch (error) {
    const code = error.code || "ADMIN_UNAUTHORIZED";
    const status =
      code === "SESSION_EXPIRED" || code === "SESSION_REVOKED" ? 401 : 401;
    return res.status(status).json({
      success: false,
      message: "Unauthorized admin access",
      code,
      error: error.message,
    });
  }
}

module.exports = {
  requireAdminAuth,
  extractBearerToken,
};
