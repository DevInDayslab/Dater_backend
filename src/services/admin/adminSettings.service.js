const { query } = require("../../config/db");
const { hashPassword, verifyPassword } = require("../../utils/adminPassword");
const adminAuthService = require("./adminAuth.service");

const { ADMIN_ROLE_FULL, ADMIN_ROLE_SEO, revokeAllSessions } = adminAuthService;

const MIN_PASSWORD_LENGTH = 8;

function invalidInput(message, code = "INVALID_INPUT") {
  const err = new Error(message);
  err.code = code;
  return err;
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function assertPassword(password, label = "Password") {
  const value = String(password || "");
  if (value.length < MIN_PASSWORD_LENGTH) {
    throw invalidInput(`${label} must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  return value;
}

async function getAccount(adminId) {
  const res = await query(
    `SELECT id, email, name, role, status, last_login_at
     FROM admin_users
     WHERE id = $1
     LIMIT 1`,
    [adminId]
  );
  const row = res.rows[0];
  if (!row || row.status !== "ACTIVE") {
    throw invalidInput("Admin account not found", "NOT_FOUND");
  }
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role || ADMIN_ROLE_FULL,
    lastLoginAt: row.last_login_at,
  };
}

async function changePassword({ adminId, sessionId, currentPassword, newPassword }) {
  const current = String(currentPassword || "");
  const next = assertPassword(newPassword, "New password");

  const res = await query(
    `SELECT id, password_hash, role
     FROM admin_users
     WHERE id = $1 AND status = 'ACTIVE'
     LIMIT 1`,
    [adminId]
  );
  const row = res.rows[0];
  if (!row || row.role !== ADMIN_ROLE_FULL) {
    throw invalidInput("Admin account not found", "NOT_FOUND");
  }
  if (!verifyPassword(current, row.password_hash)) {
    throw invalidInput("Current password is incorrect", "INVALID_PASSWORD");
  }

  const passwordHash = hashPassword(next);
  await query(`UPDATE admin_users SET password_hash = $2 WHERE id = $1`, [adminId, passwordHash]);
  await revokeAllSessions(adminId, { exceptSessionId: sessionId });

  return { updated: true };
}

async function getSeoAdmin() {
  const res = await query(
    `SELECT u.id, u.email, u.name, u.last_login_at,
            (
              SELECT COUNT(*)::int
              FROM admin_sessions s
              WHERE s.admin_user_id = u.id
                AND s.revoked_at IS NULL
                AND s.expires_at > NOW()
            ) AS active_session_count
     FROM admin_users u
     WHERE u.role = $1
     LIMIT 1`,
    [ADMIN_ROLE_SEO]
  );
  const row = res.rows[0];
  if (!row) {
    return { configured: false };
  }
  return {
    configured: true,
    id: row.id,
    email: row.email,
    name: row.name,
    lastLoginAt: row.last_login_at,
    activeSessionCount: row.active_session_count,
  };
}

async function upsertSeoAdmin({ email, password, name }) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    throw invalidInput("Email is required");
  }

  const existingRes = await query(
    `SELECT id, email, password_hash
     FROM admin_users
     WHERE role = $1
     LIMIT 1`,
    [ADMIN_ROLE_SEO]
  );
  const existing = existingRes.rows[0];

  const nextPassword = password ? assertPassword(password) : null;
  if (!existing && !nextPassword) {
    throw invalidInput("Password is required when creating the SEO admin account");
  }

  if (existing) {
    const emailTakenRes = await query(
      `SELECT id FROM admin_users WHERE email = $1 AND id <> $2 LIMIT 1`,
      [normalizedEmail, existing.id]
    );
    if (emailTakenRes.rows[0]) {
      throw invalidInput("Email is already in use");
    }

    const displayName = String(name || "").trim() || "SEO Admin";
    const passwordHash = nextPassword ? hashPassword(nextPassword) : null;

    if (passwordHash) {
      await query(
        `UPDATE admin_users
         SET email = $2, name = $3, password_hash = $4, status = 'ACTIVE'
         WHERE id = $1`,
        [existing.id, normalizedEmail, displayName, passwordHash]
      );
    } else {
      await query(
        `UPDATE admin_users
         SET email = $2, name = $3, status = 'ACTIVE'
         WHERE id = $1`,
        [existing.id, normalizedEmail, displayName]
      );
    }

    if (passwordHash || normalizedEmail !== existing.email) {
      await revokeAllSessions(existing.id);
    }

    return getSeoAdmin();
  }

  const emailTakenRes = await query(`SELECT id FROM admin_users WHERE email = $1 LIMIT 1`, [
    normalizedEmail,
  ]);
  if (emailTakenRes.rows[0]) {
    throw invalidInput("Email is already in use");
  }

  const displayName = String(name || "").trim() || "SEO Admin";
  const passwordHash = hashPassword(nextPassword);

  await query(
    `INSERT INTO admin_users (email, name, password_hash, status, role)
     VALUES ($1, $2, $3, 'ACTIVE', $4)`,
    [normalizedEmail, displayName, passwordHash, ADMIN_ROLE_SEO]
  );

  return getSeoAdmin();
}

async function listSeoAdminSessions() {
  const seoAdmin = await getSeoAdmin();
  if (!seoAdmin.configured) {
    return { sessions: [] };
  }

  const res = await query(
    `SELECT id, ip_address, user_agent, created_at, expires_at
     FROM admin_sessions
     WHERE admin_user_id = $1
       AND revoked_at IS NULL
       AND expires_at > NOW()
     ORDER BY created_at DESC`,
    [seoAdmin.id]
  );

  return {
    sessions: res.rows.map((row) => ({
      id: row.id,
      ipAddress: row.ip_address,
      userAgent: row.user_agent,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    })),
  };
}

async function revokeSeoAdminSessions() {
  const seoAdmin = await getSeoAdmin();
  if (!seoAdmin.configured) {
    throw invalidInput("SEO admin is not configured", "NOT_FOUND");
  }
  await revokeAllSessions(seoAdmin.id);
  return { revoked: true };
}

module.exports = {
  getAccount,
  changePassword,
  getSeoAdmin,
  upsertSeoAdmin,
  listSeoAdminSessions,
  revokeSeoAdminSessions,
};
