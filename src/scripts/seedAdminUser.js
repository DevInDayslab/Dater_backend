require("dotenv").config({ path: require("path").join(__dirname, "..", "..", ".env") });

const { query, pool } = require("../config/db");
const { hashPassword } = require("../utils/adminPassword");

async function main() {
  const email = String(process.env.ADMIN_SEED_EMAIL || "birsingh@dater.app")
    .trim()
    .toLowerCase();
  const password = String(process.env.ADMIN_SEED_PASSWORD || "");
  const name = String(process.env.ADMIN_SEED_NAME || "Admin").trim() || "Admin";

  if (!password) {
    console.error("Set ADMIN_SEED_PASSWORD in backend/.env");
    process.exit(2);
  }

  if (password.length < 8) {
    console.error("ADMIN_SEED_PASSWORD must be at least 8 characters");
    process.exit(2);
  }

  const passwordHash = hashPassword(password);

  const result = await query(
    `INSERT INTO admin_users (email, name, password_hash, status, role)
     VALUES ($1, $2, $3, 'ACTIVE', 'FULL')
     ON CONFLICT (email) DO UPDATE
       SET name = EXCLUDED.name,
           password_hash = EXCLUDED.password_hash,
           status = 'ACTIVE',
           role = 'FULL'
     RETURNING id, email, name, status, role, created_at`,
    [email, name, passwordHash]
  );

  const row = result.rows[0];
  console.log("Admin user ready:", {
    id: row.id,
    email: row.email,
    name: row.name,
    status: row.status,
    role: row.role,
    createdAt: row.created_at,
  });
}

main()
  .catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
