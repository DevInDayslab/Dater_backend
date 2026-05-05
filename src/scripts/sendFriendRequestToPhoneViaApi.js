/**
 * Sends one incoming friend request to a viewer phone through backend HTTP API.
 *
 * This validates auth middleware + controller route path:
 *   POST /api/v1/users/me/interactions/request
 *
 * From backend/:
 *   node src/scripts/sendFriendRequestToPhoneViaApi.js 9015161889
 *   npm run send:friend-request:api:test -- 9015161889 995
 *   npm run send:friend-request:api:test -- 9015161889 995 5
 */
require("dotenv").config();
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { Client } = require("pg");
const {
  toE164,
  ensureUserFiltersRow,
  syncViewerInclusivePreferredGenders,
  upsertCompatibleCandidate,
} = require("./seedFeedProfilesForViewerPhone");

const BACKEND_BASE_URL = process.env.BACKEND_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`;

async function createAccessTokenForUser(client, userId) {
  const jwtSecret = String(process.env.JWT_SECRET || "").trim();
  if (!jwtSecret) throw new Error("JWT_SECRET is required for API auth script");
  const jwtId = crypto.randomUUID();
  const ttlSeconds = 60 * 60 * 24 * 7;
  const sessionRes = await client.query(
    `INSERT INTO user_sessions (user_id, jwt_id, expires_at)
     VALUES ($1, $2::uuid, NOW() + ($3 || ' seconds')::interval)
     RETURNING id, jwt_id`,
    [userId, jwtId, ttlSeconds]
  );
  const session = sessionRes.rows[0];
  return jwt.sign(
    {
      sub: userId,
      sid: session.id,
      jti: session.jwt_id,
      type: "access",
    },
    jwtSecret,
    { expiresIn: ttlSeconds }
  );
}

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
  const rawSeed = process.argv[3] || `${Date.now() % 100000}`;
  const rawCount = process.argv[4] || "1";
  const seed = Number.parseInt(String(rawSeed), 10);
  const desiredCount = Number.parseInt(String(rawCount), 10);
  const count = Number.isFinite(desiredCount) ? Math.max(1, Math.min(30, desiredCount)) : 1;
  if (!rawPhone) {
    console.error("Usage: node src/scripts/sendFriendRequestToPhoneViaApi.js <phone> [seed] [count]");
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

    const sent = [];
    const skipped = [];
    const failures = [];
    const baseSeed = Number.isFinite(seed) ? seed : Date.now() % 100000;
    const maxAttempts = count + 60;

    for (let i = 0; i < maxAttempts && sent.length < count; i += 1) {
      const currentSeed = baseSeed + i;
      const sender = await upsertCompatibleCandidate(client, viewer, currentSeed, { phonePrefix: "notifbotapi" });
      const pending = await hasPendingOutgoingRequest(client, sender.userId, viewer.id);
      const friends = await areFriends(client, sender.userId, viewer.id);
      if (pending) {
        skipped.push({ seed: currentSeed, reason: "PENDING_EXISTS", senderUserId: sender.userId, senderName: sender.name });
        continue;
      }
      if (friends) {
        skipped.push({ seed: currentSeed, reason: "ALREADY_FRIENDS", senderUserId: sender.userId, senderName: sender.name });
        continue;
      }

      try {
        const accessToken = await createAccessTokenForUser(client, sender.userId);
        const response = await fetch(`${BACKEND_BASE_URL}/api/v1/users/me/interactions/request`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ targetUserId: viewer.id }),
        });
        const json = await response.json().catch(() => ({}));
        if (!response.ok || !json.success) {
          failures.push({
            seed: currentSeed,
            senderUserId: sender.userId,
            senderName: sender.name,
            status: response.status,
            message: json.message || `HTTP ${response.status}`,
          });
          continue;
        }
        sent.push({
          seed: currentSeed,
          senderUserId: sender.userId,
          senderName: sender.name,
          apiMessage: json.message || "Friend request sent",
        });
      } catch (e) {
        failures.push({
          seed: currentSeed,
          senderUserId: sender.userId,
          senderName: sender.name,
          message: e.message || "Unknown error",
        });
      }
    }

    console.log(
      JSON.stringify(
        {
          success: sent.length > 0,
          path: "API",
          endpoint: `${BACKEND_BASE_URL}/api/v1/users/me/interactions/request`,
          viewer: phoneE164,
          viewerUserId: viewer.id,
          requestedCount: count,
          sentCount: sent.length,
          sent,
          skippedCount: skipped.length,
          skipped,
          failureCount: failures.length,
          failures,
        },
        null,
        2
      )
    );
  } catch (error) {
    console.error("sendFriendRequestToPhoneViaApi failed:", error.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main();
}

