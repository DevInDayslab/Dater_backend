const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { query } = require("../../config/db");
const { verifyPassword } = require("../../utils/adminPassword");

const ADMIN_ACCESS_TOKEN_TTL_SECONDS = 60 * 60 * 8; // 8 hours

const ADMIN_ROLE_FULL = "FULL";
const ADMIN_ROLE_SEO = "SEO";

function adminJwtSecret() {
  const secret = process.env.ADMIN_JWT_SECRET || process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("ADMIN_JWT_SECRET or JWT_SECRET is required");
  }
  return secret;
}

function toAdminPublic(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role || ADMIN_ROLE_FULL,
  };
}

async function createAdminSession({ adminUserId, ipAddress, userAgent }) {
  const sessionId = crypto.randomUUID();
  const jwtId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + ADMIN_ACCESS_TOKEN_TTL_SECONDS * 1000);

  await query(
    `INSERT INTO admin_sessions (id, admin_user_id, jwt_id, ip_address, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [sessionId, adminUserId, jwtId, ipAddress || null, userAgent || null, expiresAt.toISOString()]
  );

  const accessToken = jwt.sign(
    {
      type: "admin_access",
      sub: adminUserId,
      sid: sessionId,
      jti: jwtId,
    },
    adminJwtSecret(),
    { expiresIn: ADMIN_ACCESS_TOKEN_TTL_SECONDS }
  );

  return {
    accessToken,
    expiresAt: expiresAt.toISOString(),
    sessionId,
    jwtId,
  };
}

function assertPortalAccess(role, portal) {
  const normalizedPortal = String(portal || "").trim().toLowerCase();
  if (!normalizedPortal) return;

  if (normalizedPortal === "full" && role !== ADMIN_ROLE_FULL) {
    const err = new Error("Invalid email or password");
    err.code = "WRONG_PORTAL";
    throw err;
  }
  if (normalizedPortal === "seo" && role !== ADMIN_ROLE_SEO) {
    const err = new Error("Invalid email or password");
    err.code = "WRONG_PORTAL";
    throw err;
  }
}

async function login({ email, password, portal, ipAddress, userAgent }) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!normalizedEmail || !password) {
    const err = new Error("Email and password are required");
    err.code = "INVALID_CREDENTIALS";
    throw err;
  }

  const res = await query(
    `SELECT id, email, name, password_hash, status, role
     FROM admin_users
     WHERE email = $1
     LIMIT 1`,
    [normalizedEmail]
  );
  const row = res.rows[0];
  if (!row || row.status !== "ACTIVE" || !verifyPassword(password, row.password_hash)) {
    const err = new Error("Invalid email or password");
    err.code = "INVALID_CREDENTIALS";
    throw err;
  }

  assertPortalAccess(row.role || ADMIN_ROLE_FULL, portal);

  await query(`UPDATE admin_users SET last_login_at = NOW() WHERE id = $1`, [row.id]);

  const session = await createAdminSession({
    adminUserId: row.id,
    ipAddress,
    userAgent,
  });

  return {
    ...session,
    admin: toAdminPublic(row),
  };
}

async function verifyAdminAccessToken(tokenInput) {
  const token = String(tokenInput || "").trim();
  if (!token) {
    const err = new Error("Missing bearer token");
    err.code = "MISSING_TOKEN";
    throw err;
  }

  const payload = jwt.verify(token, adminJwtSecret());
  if (payload?.type !== "admin_access" || !payload?.sub || !payload?.sid || !payload?.jti) {
    const err = new Error("Invalid admin token payload");
    err.code = "INVALID_TOKEN_PAYLOAD";
    throw err;
  }

  const sessionRes = await query(
    `SELECT s.id, s.admin_user_id, s.jwt_id, s.revoked_at, s.expires_at,
            u.email, u.name, u.status, u.role
     FROM admin_sessions s
     JOIN admin_users u ON u.id = s.admin_user_id
     WHERE s.id = $1
       AND s.admin_user_id = $2
       AND s.jwt_id = $3
     LIMIT 1`,
    [payload.sid, payload.sub, payload.jti]
  );
  const session = sessionRes.rows[0];
  if (!session) {
    const err = new Error("Admin session not found");
    err.code = "SESSION_NOT_FOUND";
    throw err;
  }
  if (session.status !== "ACTIVE") {
    const err = new Error("Admin account is not active");
    err.code = "ADMIN_SUSPENDED";
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
    adminId: session.admin_user_id,
    sessionId: session.id,
    jwtId: session.jwt_id,
    email: session.email,
    name: session.name,
    role: session.role || ADMIN_ROLE_FULL,
  };
}

async function revokeAllSessions(adminUserId, { exceptSessionId } = {}) {
  if (exceptSessionId) {
    await query(
      `UPDATE admin_sessions
       SET revoked_at = NOW()
       WHERE admin_user_id = $1
         AND revoked_at IS NULL
         AND id <> $2`,
      [adminUserId, exceptSessionId]
    );
    return;
  }

  await query(
    `UPDATE admin_sessions
     SET revoked_at = NOW()
     WHERE admin_user_id = $1
       AND revoked_at IS NULL`,
    [adminUserId]
  );
}

async function refresh({ token, ipAddress, userAgent }) {
  const current = await verifyAdminAccessToken(token);
  await query(`UPDATE admin_sessions SET revoked_at = NOW() WHERE id = $1`, [current.sessionId]);
  return createAdminSession({
    adminUserId: current.adminId,
    ipAddress,
    userAgent,
  });
}

async function logout({ sessionId }) {
  await query(
    `UPDATE admin_sessions
     SET revoked_at = NOW()
     WHERE id = $1
       AND revoked_at IS NULL`,
    [sessionId]
  );
}

module.exports = {
  login,
  refresh,
  logout,
  verifyAdminAccessToken,
  revokeAllSessions,
  toAdminPublic,
  ADMIN_ACCESS_TOKEN_TTL_SECONDS,
  ADMIN_ROLE_FULL,
  ADMIN_ROLE_SEO,
};
