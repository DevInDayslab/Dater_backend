const jwt = require("jsonwebtoken");
const { query } = require("../config/db");

async function authenticateAccessToken(tokenInput) {
  const token = String(tokenInput || "").trim();
  if (!token) {
    const err = new Error("Missing bearer token");
    err.code = "MISSING_TOKEN";
    throw err;
  }
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    const err = new Error("JWT_SECRET is not configured");
    err.code = "JWT_SECRET_MISSING";
    throw err;
  }
  const payload = jwt.verify(token, jwtSecret);
  if (payload?.type !== "access" || !payload?.sub || !payload?.sid || !payload?.jti) {
    const err = new Error("Invalid token payload");
    err.code = "INVALID_TOKEN_PAYLOAD";
    throw err;
  }
  const sessionRes = await query(
    `SELECT id, user_id, jwt_id, revoked_at, expires_at
     FROM user_sessions
     WHERE id = $1
       AND user_id = $2
       AND jwt_id = $3
     LIMIT 1`,
    [payload.sid, payload.sub, payload.jti]
  );
  const session = sessionRes.rows[0];
  if (!session) {
    const err = new Error("Session not found");
    err.code = "SESSION_NOT_FOUND";
    throw err;
  }
  if (session.revoked_at) {
    const err = new Error("Session revoked");
    err.code = "SESSION_REVOKED";
    throw err;
  }
  if (new Date(session.expires_at).getTime() <= Date.now()) {
    const err = new Error("Session expired");
    err.code = "SESSION_EXPIRED";
    throw err;
  }
  return {
    userId: payload.sub,
    sessionId: payload.sid,
    jwtId: payload.jti,
  };
}

async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
    req.auth = await authenticateAccessToken(token);
    return next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized",
      error: error.message,
    });
  }
}

module.exports = {
  requireAuth,
  authenticateAccessToken,
};
