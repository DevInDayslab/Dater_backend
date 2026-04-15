const jwt = require("jsonwebtoken");
const { query } = require("../config/db");

async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Missing bearer token",
      });
    }

    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
      return res.status(500).json({
        success: false,
        message: "JWT_SECRET is not configured",
      });
    }

    const payload = jwt.verify(token, jwtSecret);
    if (payload?.type !== "access" || !payload?.sub || !payload?.sid || !payload?.jti) {
      return res.status(401).json({
        success: false,
        message: "Invalid token payload",
      });
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
      return res.status(401).json({
        success: false,
        message: "Session not found",
      });
    }
    if (session.revoked_at) {
      return res.status(401).json({
        success: false,
        message: "Session revoked",
      });
    }
    if (new Date(session.expires_at).getTime() <= Date.now()) {
      return res.status(401).json({
        success: false,
        message: "Session expired",
      });
    }

    req.auth = {
      userId: payload.sub,
      sessionId: payload.sid,
      jwtId: payload.jti,
    };
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
};
