/**
 * Prints notification preferences for a viewer phone.
 *
 * From backend/:
 *   node src/scripts/checkNotificationPrefsForPhone.js 9015161889
 *   npm run inspect:notifications:viewer -- 9015161889
 */
require("dotenv").config();
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const { Client } = require("pg");

function toDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

async function main() {
  const rawPhone = process.argv[2] || "";
  const digits = toDigits(rawPhone);
  if (!digits) {
    console.error("Usage: node src/scripts/checkNotificationPrefsForPhone.js <phone>");
    process.exitCode = 1;
    return;
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    const usersRes = await client.query(
      `SELECT id, phone_e164, created_at
       FROM users
       WHERE regexp_replace(phone_e164, '[^0-9]', '', 'g') LIKE $1
       ORDER BY created_at DESC
       LIMIT 10`,
      [`%${digits}`]
    );

    if (usersRes.rowCount === 0) {
      console.log(JSON.stringify({ success: false, message: "No user found", digits }, null, 2));
      return;
    }

    const out = [];
    for (const u of usersRes.rows) {
      const prefRes = await client.query(
        `SELECT push_friend_request_received,
                push_friend_request_accepted,
                push_chat_dm,
                push_comment,
                inapp_friend_request_received,
                inapp_friend_request_accepted,
                inapp_chat_dm,
                inapp_comment,
                updated_at
         FROM user_notification_preferences
         WHERE user_id = $1
         LIMIT 1`,
        [u.id]
      );
      out.push({
        userId: u.id,
        phone: u.phone_e164,
        createdAt: u.created_at,
        preferences: prefRes.rows[0] || null,
      });
    }

    console.log(
      JSON.stringify(
        {
          success: true,
          digits,
          matchedUsers: out.length,
          users: out,
        },
        null,
        2
      )
    );
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error("checkNotificationPrefsForPhone failed:", e.message);
    process.exitCode = 1;
  });
}

