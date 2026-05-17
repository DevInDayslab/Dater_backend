/**
 * Permanently removes all DB rows tied to a phone number: auth challenges/attempts,
 * social graph + chats (same scope as clear:social:for-phones), then the user row(s).
 * Child rows on users CASCADE (photos, prefs, sessions, etc.).
 *
 * Does not delete S3 objects.
 *
 * From backend/:
 *   npm run db:delete-all-for-phone -- 9015161889
 *   npm run db:delete-all-for-phone -- +919015161889
 *
 * Optional: --dry-run (no writes; prints matched users and counts only)
 *
 * Requires DATABASE_URL in .env
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const { Client } = require("pg");
const { toE164 } = require("./seedFeedProfilesForViewerPhone");

async function runOptional(client, label, sql, params) {
  try {
    const r = await client.query(sql, params);
    return r.rowCount ?? 0;
  } catch (e) {
    if (String(e.message || "").includes("does not exist")) {
      console.warn(`[deleteAllDbDataForPhone] skip ${label}: table missing`);
      return 0;
    }
    throw e;
  }
}

async function clearSocialGraphForUserIds(client, ids) {
  if (!ids.length) return {};

  const summary = {};
  const del = async (key, sql) => {
    const r = await client.query(sql, [ids]);
    const n = r.rowCount ?? 0;
    summary[key] = n;
    return n;
  };

  await del(
    "notification_events",
    `DELETE FROM notification_events
     WHERE recipient_user_id = ANY($1::uuid[])
        OR actor_user_id = ANY($1::uuid[])`
  );

  await del(
    "profile_view_events",
    `DELETE FROM profile_view_events
     WHERE viewer_user_id = ANY($1::uuid[])
        OR viewed_user_id = ANY($1::uuid[])`
  );

  await del("user_daily_profile_view_usage", `DELETE FROM user_daily_profile_view_usage WHERE user_id = ANY($1::uuid[])`);

  summary.story_activity_profile_seen = await runOptional(
    client,
    "story_activity_profile_seen",
    `DELETE FROM story_activity_profile_seen
     WHERE owner_user_id = ANY($1::uuid[])
        OR actor_user_id = ANY($1::uuid[])`,
    [ids]
  );

  await del(
    "story_interactions",
    `DELETE FROM story_interactions
     WHERE actor_user_id = ANY($1::uuid[])
        OR story_owner_id = ANY($1::uuid[])`
  );

  await del(
    "story_replies",
    `DELETE FROM story_replies
     WHERE replier_user_id = ANY($1::uuid[])
        OR story_owner_id = ANY($1::uuid[])`
  );

  await del("stories", `DELETE FROM stories WHERE user_id = ANY($1::uuid[])`);

  const threadDel = await client.query(
    `DELETE FROM chat_threads
     WHERE id IN (
       SELECT thread_id FROM chat_thread_participants WHERE user_id = ANY($1::uuid[])
     )`,
    [ids]
  );
  summary.chat_threads = threadDel.rowCount ?? 0;

  await del(
    "user_interactions",
    `DELETE FROM user_interactions
     WHERE user_id = ANY($1::uuid[])
        OR target_id = ANY($1::uuid[])`
  );

  await del(
    "friendships",
    `DELETE FROM friendships
     WHERE u1_id = ANY($1::uuid[])
        OR u2_id = ANY($1::uuid[])`
  );

  await del(
    "blocks",
    `DELETE FROM blocks
     WHERE blocker_id = ANY($1::uuid[])
        OR blocked_id = ANY($1::uuid[])`
  );

  await del(
    "reports",
    `DELETE FROM reports
     WHERE reporter_id = ANY($1::uuid[])
        OR reported_id = ANY($1::uuid[])`
  );

  await del(
    "chat_unlock_events",
    `DELETE FROM chat_unlock_events
     WHERE user_id = ANY($1::uuid[])
        OR target_id = ANY($1::uuid[])`
  );

  await del(
    "chat_user_pair_preferences",
    `DELETE FROM chat_user_pair_preferences
     WHERE user_id = ANY($1::uuid[])
        OR target_id = ANY($1::uuid[])`
  );

  await del(
    "chat_restrictions",
    `DELETE FROM chat_restrictions
     WHERE user_id = ANY($1::uuid[])
        OR target_id = ANY($1::uuid[])`
  );

  return summary;
}

async function countAuthRows(client, phoneE164) {
  const out = {};
  for (const [table, col] of [
    ["auth_otp_challenges", "phone_e164"],
    ["auth_captcha_challenges", "phone_e164"],
    ["auth_login_attempts", "phone_e164"],
  ]) {
    try {
      const r = await client.query(`SELECT COUNT(*)::int AS c FROM ${table} WHERE ${col} = $1`, [phoneE164]);
      out[table] = r.rows[0].c;
    } catch (e) {
      if (String(e.message || "").includes("does not exist")) out[table] = "n/a";
      else throw e;
    }
  }
  return out;
}

async function deleteAuthForPhone(client, phoneE164) {
  const deleted = {};
  deleted.auth_otp_challenges = await runOptional(
    client,
    "auth_otp_challenges",
    `DELETE FROM auth_otp_challenges WHERE phone_e164 = $1`,
    [phoneE164]
  );
  deleted.auth_captcha_challenges = await runOptional(
    client,
    "auth_captcha_challenges",
    `DELETE FROM auth_captcha_challenges WHERE phone_e164 = $1`,
    [phoneE164]
  );
  deleted.auth_login_attempts = await runOptional(
    client,
    "auth_login_attempts",
    `DELETE FROM auth_login_attempts WHERE phone_e164 = $1`,
    [phoneE164]
  );
  return deleted;
}

async function main() {
  const args = process.argv.slice(2).filter(Boolean);
  const dryRun = args.includes("--dry-run");
  const raw = args.find((a) => a !== "--dry-run");
  if (!raw) {
    console.error("Usage: npm run db:delete-all-for-phone -- <10-digit or +E164> [--dry-run]");
    process.exit(1);
  }

  const phoneE164 = toE164(raw);
  const digitsOnly = phoneE164.replace(/\D/g, "");
  const last10 = digitsOnly.length >= 10 ? digitsOnly.slice(-10) : digitsOnly;

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    const idRes = await client.query(
      `SELECT id, phone_e164, phone_number, deleted_at
       FROM users
       WHERE phone_e164 = $1
          OR regexp_replace(COALESCE(phone_e164, ''), '[^0-9]', '', 'g') = $2
          OR (
            phone_country_code = '+91'
            AND regexp_replace(COALESCE(phone_number, ''), '[^0-9]', '', 'g') = $3
          )`,
      [phoneE164, digitsOnly, last10]
    );

    const authCounts = await countAuthRows(client, phoneE164);

    console.log(
      JSON.stringify(
        {
          phoneE164,
          dryRun,
          matchedUsers: idRes.rows,
          authRowCounts: authCounts,
        },
        null,
        2
      )
    );

    if (dryRun) {
      console.log("Dry run: no changes made.");
      return;
    }

    await client.query("BEGIN");
    const ids = idRes.rows.map((r) => r.id);
    const summary = { social: {}, auth: {}, users: 0 };

    if (ids.length) {
      summary.social = await clearSocialGraphForUserIds(client, ids);
      const delUsers = await client.query(`DELETE FROM users WHERE id = ANY($1::uuid[]) RETURNING id, phone_e164`, [ids]);
      summary.users = delUsers.rowCount ?? 0;
    }

    summary.auth = await deleteAuthForPhone(client, phoneE164);

    await client.query("COMMIT");
    console.log(JSON.stringify({ success: true, summary }, null, 2));
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {
      /* ignore */
    }
    console.error("deleteAllDbDataForPhone failed:", e.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();
