require("dotenv").config();

const { Client } = require("pg");
const {
  toE164,
  ensureUserFiltersRow,
  syncViewerInclusivePreferredGenders,
  upsertCompatibleCandidate,
} = require("./seedFeedProfilesForViewerPhone");

function normalizedPair(a, b) {
  return a < b ? [a, b] : [b, a];
}

async function ensureFriendshipAndThread(client, viewerId, friendId, messageSeedIndex) {
  const { sendFriendRequest, respondToRequest } = require("../services/social.service");
  const chatService = require("../services/chat.service");
  const [u1, u2] = normalizedPair(viewerId, friendId);
  const alreadyFriendsRes = await client.query(
    `SELECT 1
     FROM friendships
     WHERE u1_id = $1 AND u2_id = $2
     LIMIT 1`,
    [u1, u2]
  );
  const friendRequestRes = await client.query(
    `SELECT id
     FROM user_interactions
     WHERE user_id = $1
       AND target_id = $2
       AND interaction_type IN ('REQUEST', 'COMMENT_REQUEST')
       AND request_status = 'PENDING'
     LIMIT 1`,
    [friendId, viewerId]
  );
  if (!alreadyFriendsRes.rows[0] && !friendRequestRes.rows[0]) {
    await sendFriendRequest(friendId, viewerId);
  }
  if (!alreadyFriendsRes.rows[0]) {
    await respondToRequest(viewerId, friendId, "ACCEPTED");
  }
  await client.query(
    `UPDATE users
     SET last_active_at = NOW() - (($2::int % 18) * INTERVAL '1 minute')
     WHERE id = $1`,
    [friendId, messageSeedIndex]
  );
  const thread = await chatService.getOrCreateDirectThread(viewerId, friendId);
  const threadId = thread.threadId;
  const texts = [
    "Hey! good to connect here.",
    "Absolutely, let's chat more.",
    "Sounds great, how's your day?",
  ];
  await chatService.sendMessage(friendId, threadId, texts[messageSeedIndex % texts.length]);
  await chatService.sendMessage(viewerId, threadId, "Doing good, you?");
}

async function seedActiveStories(client, friendId, idx) {
  const mediaUrl = `https://picsum.photos/seed/dater-active-${idx}/1080/1920`;
  await client.query(
    `INSERT INTO stories (user_id, media_url, media_type, audience, expires_at)
     VALUES ($1, $2, 'IMAGE', 'FRIENDS_ONLY', NOW() + INTERVAL '23 hours')`,
    [friendId, mediaUrl]
  );
}

async function main() {
  const rawPhone = process.argv[2] || "9354120990";
  const rawCount = Number.parseInt(String(process.argv[3] || "8"), 10);
  const total = Number.isFinite(rawCount) ? Math.max(1, Math.min(20, rawCount)) : 8;
  const phoneE164 = toE164(rawPhone);
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await client.query("BEGIN");
    const viewerRes = await client.query(
      `SELECT u.id,
              u.phone_e164,
              u.name,
              u.age_years,
              u.gender_main,
              u.living_in_city,
              u.living_in_city_mode,
              (u.location IS NOT NULL) AS has_location,
              ST_X(u.location::geometry) AS lng,
              ST_Y(u.location::geometry) AS lat,
              uf.distance_pref_km,
              uf.age_min,
              uf.age_max,
              uf.expand_age_range,
              uf.expand_distance,
              uf.only_verified_profiles,
              uf.preferred_location_city
       FROM users
       u LEFT JOIN user_filters uf ON uf.user_id = u.id
       WHERE phone_e164 = $1
         AND deleted_at IS NULL
       LIMIT 1`,
      [phoneE164]
    );
    if (!viewerRes.rows[0]) throw new Error(`Viewer not found for ${phoneE164}`);
    const viewer = viewerRes.rows[0];
    await ensureUserFiltersRow(client, viewer.id);
    await syncViewerInclusivePreferredGenders(client, viewer.id);
    const created = [];
    const viewerHasGender = String(viewer.gender_main || "").trim().length > 0;
    if (viewerHasGender) {
      for (let i = 1; i <= total; i += 1) {
        const candidate = await upsertCompatibleCandidate(client, viewer, 700 + i, {
          phonePrefix: "activefriend",
        });
        await ensureFriendshipAndThread(client, viewer.id, candidate.userId, i);
        if (i % 3 === 0) {
          await client.query(`UPDATE users SET hide_my_name = TRUE WHERE id = $1::uuid`, [candidate.userId]);
        }
        await seedActiveStories(client, candidate.userId, i);
        created.push({ userId: candidate.userId, name: candidate.name });
      }
    } else {
      const existingFriendsRes = await client.query(
        `SELECT CASE WHEN f.u1_id = $1 THEN f.u2_id ELSE f.u1_id END AS friend_id
         FROM friendships f
         WHERE f.u1_id = $1 OR f.u2_id = $1
         LIMIT $2`,
        [viewer.id, total]
      );
      let i = 1;
      for (const row of existingFriendsRes.rows) {
        await ensureFriendshipAndThread(client, viewer.id, row.friend_id, i);
        await seedActiveStories(client, row.friend_id, i);
        created.push({ userId: row.friend_id, name: "" });
        i += 1;
      }
    }
    await client.query("COMMIT");
    console.log(JSON.stringify({ success: true, viewer: phoneE164, total: created.length, created }, null, 2));
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("seedActiveFriendsForViewerPhone failed:", error.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main();
}
