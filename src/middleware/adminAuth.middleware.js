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
        role: adminAuthService.ADMIN_ROLE_FULL,
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

function requireFullAdmin(req, res, next) {
  if (req.admin?.viaApiKey || req.admin?.role === adminAuthService.ADMIN_ROLE_FULL) {
    return next();
  }
  return res.status(403).json({
    success: false,
    message: "Full admin access required",
    code: "FULL_ADMIN_REQUIRED",
  });
}

function requireSeoAccess(req, res, next) {
  const role = req.admin?.role;
  if (
    req.admin?.viaApiKey ||
    role === adminAuthService.ADMIN_ROLE_FULL ||
    role === adminAuthService.ADMIN_ROLE_SEO
  ) {
    return next();
  }
  return res.status(403).json({
    success: false,
    message: "SEO admin access required",
    code: "SEO_ACCESS_REQUIRED",
  });
}

module.exports = {
  requireAdminAuth,
  requireFullAdmin,
  requireSeoAccess,
  extractBearerToken,
};
