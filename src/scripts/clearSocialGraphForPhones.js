/**
 * Clears incoming/outgoing friend requests, friendships, direct chats, and related
 * social data for one or more viewer phone numbers (dev / QA reset).
 *
 * Does NOT delete user accounts or profile rows — only graph + chat + notifications
 * tied to these users (and threads they participate in; peers lose that chat row too).
 *
 * From backend/:
 *   npm run clear:social:for-phones -- 9811700705 9919792989
 */
require("dotenv").config();
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
      console.warn(`[clearSocialGraphForPhones] skip ${label}: table missing`);
      return 0;
    }
    throw e;
  }
}

async function main() {
  const rawPhones = process.argv.slice(2).filter(Boolean);
  if (rawPhones.length === 0) {
    console.error("Usage: npm run clear:social:for-phones -- <10-digit phone> [more phones...]");
    process.exitCode = 1;
    return;
  }

  const phonesE164 = rawPhones.map((p) => toE164(p));

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    await client.query("BEGIN");

    const idRes = await client.query(
      `SELECT id, phone_e164 FROM users
       WHERE phone_e164 = ANY($1::text[])
         AND deleted_at IS NULL`,
      [phonesE164]
    );

    if (idRes.rows.length === 0) {
      throw new Error(`No users found for phones: ${phonesE164.join(", ")}`);
    }

    const ids = idRes.rows.map((r) => r.id);
    const summary = { phones: idRes.rows, deleted: {} };

    const del = async (key, sql) => {
      const r = await client.query(sql, [ids]);
      const n = r.rowCount ?? 0;
      summary.deleted[key] = n;
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

    await del(
      "user_daily_profile_view_usage",
      `DELETE FROM user_daily_profile_view_usage WHERE user_id = ANY($1::uuid[])`
    );

    summary.deleted.story_activity_profile_seen = await runOptional(
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
    summary.deleted.chat_threads = threadDel.rowCount ?? 0;

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

    await client.query("COMMIT");

    console.log(JSON.stringify({ success: true, summary }, null, 2));
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {
      /* ignore */
    }
    console.error("clearSocialGraphForPhones failed:", e.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();
