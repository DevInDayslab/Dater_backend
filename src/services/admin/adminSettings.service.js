const { query } = require("../../config/db");
const { hashPassword } = require("../../utils/adminPassword");

function toIso(value) {
  return value ? new Date(value).toISOString() : null;
}

async function listAdmins() {
  const res = await query(
    `SELECT id, name, email, status, created_at, last_login_at
     FROM admin_users
     ORDER BY created_at ASC`
  );
  return res.rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    status: r.status,
    createdAt: toIso(r.created_at),
    lastLoginAt: toIso(r.last_login_at),
  }));
}

async function createAdmin({ email, name, password }) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const adminName = String(name || "").trim();
  const pwd = String(password || "");

  if (!normalizedEmail || !adminName || !pwd) {
    const err = new Error("email, name, and password are required");
    err.code = "INVALID_INPUT";
    throw err;
  }
  if (pwd.length < 8) {
    const err = new Error("password must be at least 8 characters");
    err.code = "WEAK_PASSWORD";
    throw err;
  }

  const passwordHash = hashPassword(pwd);
  try {
    const res = await query(
      `INSERT INTO admin_users (email, name, password_hash, status)
       VALUES ($1, $2, $3, 'ACTIVE')
       RETURNING id, name, email, status, created_at, last_login_at`,
      [normalizedEmail, adminName, passwordHash]
    );
    const row = res.rows[0];
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      status: row.status,
      createdAt: toIso(row.created_at),
      lastLoginAt: toIso(row.last_login_at),
    };
  } catch (error) {
    if (error.code === "23505") {
      const err = new Error("An admin with this email already exists");
      err.code = "EMAIL_EXISTS";
      throw err;
    }
    throw error;
  }
}

async function updateAdminStatus(adminId, { status }) {
  const nextStatus = String(status || "").trim().toUpperCase();
  if (!["ACTIVE", "SUSPENDED"].includes(nextStatus)) {
    const err = new Error("status must be ACTIVE or SUSPENDED");
    err.code = "INVALID_STATUS";
    throw err;
  }

  const res = await query(
    `UPDATE admin_users
     SET status = $2
     WHERE id = $1::uuid
     RETURNING id, name, email, status, created_at, last_login_at`,
    [adminId, nextStatus]
  );
  if (!res.rows[0]) return { notFound: true };

  if (nextStatus === "SUSPENDED") {
    await query(
      `UPDATE admin_sessions
       SET revoked_at = NOW()
       WHERE admin_user_id = $1::uuid
         AND revoked_at IS NULL`,
      [adminId]
    );
  }

  const row = res.rows[0];
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    status: row.status,
    createdAt: toIso(row.created_at),
    lastLoginAt: toIso(row.last_login_at),
  };
}

module.exports = {
  listAdmins,
  createAdmin,
  updateAdminStatus,
};
