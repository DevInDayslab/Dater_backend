/**
 * Sends one incoming friend request to a viewer phone (uses production service logic).
 *
 * From backend/:
 *   node src/scripts/sendFriendRequestToPhone.js 9015161889
 *   npm run send:friend-request:test -- 9015161889
 */
require("dotenv").config();
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const { Client } = require("pg");
const {
  toE164,
  ensureUserFiltersRow,
  syncViewerInclusivePreferredGenders,
  upsertCompatibleCandidate,
} = require("./seedFeedProfilesForViewerPhone");

async function hasPendingOutgoingRequest(client, senderId, targetId) {
  const r = await client.query(
    `SELECT 1
     FROM user_interactions
     WHERE user_id = $1
       AND target_id = $2
       AND interaction_type IN ('REQUEST', 'COMMENT_REQUEST')
       AND request_status = 'PENDING'
     LIMIT 1`,
    [senderId, targetId]
  );
  return r.rowCount > 0;
}

async function areFriends(client, a, b) {
  const [u1, u2] = a < b ? [a, b] : [b, a];
  const r = await client.query(
    `SELECT 1 FROM friendships WHERE u1_id = $1 AND u2_id = $2 LIMIT 1`,
    [u1, u2]
  );
  return r.rowCount > 0;
}

async function main() {
  const rawPhone = process.argv[2];
  const rawSeed = process.argv[3] || "991";
  const seed = Number.parseInt(String(rawSeed), 10);
  if (!rawPhone) {
    console.error("Usage: node src/scripts/sendFriendRequestToPhone.js <phone> [seed]");
    process.exitCode = 1;
    return;
  }
  const phoneE164 = toE164(rawPhone);

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    await client.query("BEGIN");
    const viewerRes = await client.query(
      `SELECT u.id, u.phone_e164, u.name, u.age_years, u.gender_main, u.living_in_city, u.living_in_city_mode,
              (u.location IS NOT NULL) AS has_location,
              ST_X(u.location::geometry) AS lng, ST_Y(u.location::geometry) AS lat,
              uf.distance_pref_km, uf.age_min, uf.age_max, uf.expand_age_range, uf.expand_distance,
              uf.only_verified_profiles, uf.preferred_location_city
       FROM users u
       LEFT JOIN user_filters uf ON uf.user_id = u.id
       WHERE u.phone_e164 = $1
         AND u.deleted_at IS NULL
       LIMIT 1`,
      [phoneE164]
    );
    if (!viewerRes.rows[0]) throw new Error(`Viewer not found for ${phoneE164}`);
    const viewer = viewerRes.rows[0];

    await ensureUserFiltersRow(client, viewer.id);
    await syncViewerInclusivePreferredGenders(client, viewer.id);
    const sender = await upsertCompatibleCandidate(
      client,
      viewer,
      Number.isFinite(seed) ? seed : 991,
      { phonePrefix: "notifbot" }
    );

    await client.query("COMMIT");

    const pending = await hasPendingOutgoingRequest(client, sender.userId, viewer.id);
    const friends = await areFriends(client, sender.userId, viewer.id);
    if (pending) {
      console.log(JSON.stringify({ success: true, skipped: true, reason: "PENDING_EXISTS", viewer: phoneE164, senderUserId: sender.userId }, null, 2));
      return;
    }
    if (friends) {
      console.log(JSON.stringify({ success: true, skipped: true, reason: "ALREADY_FRIENDS", viewer: phoneE164, senderUserId: sender.userId }, null, 2));
      return;
    }

    const { sendFriendRequest } = require("../services/social.service");
    await sendFriendRequest(sender.userId, viewer.id);
    console.log(
      JSON.stringify(
        {
          success: true,
          viewer: phoneE164,
          viewerUserId: viewer.id,
          senderUserId: sender.userId,
          senderName: sender.name,
          action: "REQUEST_SENT",
        },
        null,
        2
      )
    );
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}
    console.error("sendFriendRequestToPhone failed:", error.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main();
}

