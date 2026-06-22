/**
 * For a viewer phone (default 9354120990):
 * - Adds active EVERYONE stories to feed-seeded profiles (+91988770xxxxx from seed:feed:viewer).
 * - Refreshes active FRIENDS_ONLY stories on the viewer's existing friends (up to a cap).
 * - If the viewer has fewer than --min-friends friends, creates additional feed-compatible friends
 *   with active stories (same pattern as seed:friends:active:viewer).
 *
 * Prereq: run `npm run seed:feed:viewer -- <phone>` first so +91988770… users exist (optional but
 * recommended for “people in feed with stories”).
 *
 * From backend/:
 *   npm run seed:stories:feed-friends:viewer
 *   npm run seed:stories:feed-friends:viewer -- 9354120990
 *   npm run seed:stories:feed-friends:viewer -- 9354120990 20 12
 *     # args: phone, feedUserStoryCount (default 18), maxFriendsToGiveStories (default 12)
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

const FEED_SEED_PHONE_PATTERN = "^\\+91988770[0-9]{5}$";
const DEFAULT_VIEWER_PHONE = "9354120990";

function normalizedPair(a, b) {
  return a < b ? [a, b] : [b, a];
}

async function ensureFriendshipAndThread(client, viewerId, friendId, messageSeedIndex) {
  const { sendFriendRequest, respondToRequest } = require("../services/social.service");
  const chatService = require("../services/chat.service");
  const [u1, u2] = normalizedPair(viewerId, friendId);
  const alreadyFriendsRes = await client.query(
    `SELECT 1 FROM friendships WHERE u1_id = $1 AND u2_id = $2 LIMIT 1`,
    [u1, u2]
  );
  const friendRequestRes = await client.query(
    `SELECT id FROM user_interactions
     WHERE user_id = $1 AND target_id = $2
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
    `UPDATE users SET last_active_at = NOW() - (($2::int % 18) * INTERVAL '1 minute') WHERE id = $1`,
    [friendId, messageSeedIndex]
  );
  const thread = await chatService.getOrCreateDirectThread(viewerId, friendId);
  const threadId = thread.threadId;
  const texts = ["Hey! good to connect here.", "Sounds great, how's your day?", "Absolutely, let's chat more."];
  await chatService.sendMessage(friendId, threadId, texts[messageSeedIndex % texts.length]);
  await chatService.sendMessage(viewerId, threadId, "Doing good, you?");
}

async function replaceUserStoryEveryone(client, userId, seedTag, seq) {
  await client.query(`DELETE FROM stories WHERE user_id = $1::uuid AND deleted_at IS NULL`, [userId]);
  const mediaUrl = `https://picsum.photos/seed/${seedTag}-${seq}/1080/1920`;
  const ins = await client.query(
    `INSERT INTO stories (user_id, media_url, media_type, audience, created_at, expires_at)
     VALUES ($1::uuid, $2, 'IMAGE', 'EVERYONE', NOW() - (($3::int % 6) * INTERVAL '1 hour'), NOW() + INTERVAL '23 hours')
     RETURNING id`,
    [userId, mediaUrl, seq]
  );
  return ins.rows[0].id;
}

async function replaceUserStoryFriendsOnly(client, userId, seedTag, seq) {
  await client.query(`DELETE FROM stories WHERE user_id = $1::uuid AND deleted_at IS NULL`, [userId]);
  const mediaUrl = `https://picsum.photos/seed/${seedTag}-fr-${seq}/1080/1920`;
  const ins = await client.query(
    `INSERT INTO stories (user_id, media_url, media_type, audience, created_at, expires_at)
     VALUES ($1::uuid, $2, 'IMAGE', 'FRIENDS_ONLY', NOW() - (($3::int % 8) * INTERVAL '1 hour'), NOW() + INTERVAL '23 hours')
     RETURNING id`,
    [userId, mediaUrl, seq]
  );
  return ins.rows[0].id;
}

function parseIntArg(v, fallback) {
  const n = Number.parseInt(String(v ?? "").trim(), 10);
  return Number.isFinite(n) ? n : fallback;
}

async function main() {
  const rawPhone = process.argv[2] || DEFAULT_VIEWER_PHONE;
  const feedStoryCount = Math.min(80, Math.max(0, parseIntArg(process.argv[3], 18)));
  const maxFriendsWithStories = Math.min(40, Math.max(0, parseIntArg(process.argv[4], 12)));
  const minFriends = Math.min(25, Math.max(0, parseIntArg(process.argv[5], 6)));

  const phoneE164 = toE164(rawPhone);

  if (!process.env.DATABASE_URL || String(process.env.DATABASE_URL).trim() === "") {
    console.error("DATABASE_URL missing (.env)");
    process.exitCode = 1;
    return;
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15_000,
  });
  await client.connect();

  try {
    await client.query("BEGIN");
    await client.query("SET statement_timeout = '120000'");

    const viewerRes = await client.query(
      `SELECT u.id, u.phone_e164, u.name, u.age_years, u.gender_main, u.living_in_city, u.living_in_city_mode,
              u.is_verified, (u.location IS NOT NULL) AS has_location,
              ST_X(u.location::geometry) AS lng, ST_Y(u.location::geometry) AS lat,
              uf.distance_pref_km, uf.age_min, uf.age_max, uf.expand_age_range, uf.expand_distance,
              uf.only_verified_profiles, uf.preferred_location_city
       FROM users u
       LEFT JOIN user_filters uf ON uf.user_id = u.id
       WHERE u.phone_e164 = $1 AND u.deleted_at IS NULL
       LIMIT 1`,
      [phoneE164]
    );
    if (!viewerRes.rows[0]) throw new Error(`Viewer not found for ${phoneE164}`);
    const viewer = viewerRes.rows[0];
    viewer.expand_age_range = viewer.expand_age_range === true;
    viewer.expand_distance = viewer.expand_distance === true;
    viewer.only_verified_profiles = viewer.only_verified_profiles === true;

    await ensureUserFiltersRow(client, viewer.id);
    await syncViewerInclusivePreferredGenders(client, viewer.id);

    const ufRes = await client.query(
      `SELECT distance_pref_km, age_min, age_max, expand_age_range, expand_distance,
              only_verified_profiles, preferred_location_city
       FROM user_filters WHERE user_id = $1 LIMIT 1`,
      [viewer.id]
    );
    if (ufRes.rows[0]) {
      Object.assign(viewer, ufRes.rows[0]);
      viewer.expand_age_range = viewer.expand_age_range === true;
      viewer.expand_distance = viewer.expand_distance === true;
      viewer.only_verified_profiles = viewer.only_verified_profiles === true;
    }

    const viewerId = viewer.id;
    const viewerTag = String(viewerId).replace(/-/g, "").slice(0, 8);

    const feedUsersRes = await client.query(
      `SELECT id, phone_e164, name
       FROM users
       WHERE phone_e164 ~ $1
         AND id <> $2::uuid
         AND deleted_at IS NULL
       ORDER BY phone_e164
       LIMIT $3`,
      [FEED_SEED_PHONE_PATTERN, viewerId, feedStoryCount]
    );

    const feedStoryIds = [];
    let fi = 0;
    for (const row of feedUsersRes.rows) {
      fi += 1;
      const sid = await replaceUserStoryEveryone(client, row.id, `dater-feed-${viewerTag}`, fi);
      feedStoryIds.push({ userId: row.id, storyId: sid, phone: row.phone_e164, name: row.name });
    }

    const friendsRes = await client.query(
      `SELECT CASE WHEN f.u1_id = $1::uuid THEN f.u2_id ELSE f.u1_id END AS friend_id,
              u.name, u.phone_e164
       FROM friendships f
       JOIN users u ON u.id = CASE WHEN f.u1_id = $1::uuid THEN f.u2_id ELSE f.u1_id END
       WHERE f.u1_id = $1::uuid OR f.u2_id = $1::uuid
       ORDER BY f.created_at ASC
       LIMIT $2`,
      [viewerId, maxFriendsWithStories]
    );

    const friendStoryIds = [];
    let j = 0;
    for (const row of friendsRes.rows) {
      j += 1;
      const sid = await replaceUserStoryFriendsOnly(client, row.friend_id, `dater-friend-${viewerTag}`, j);
      friendStoryIds.push({
        userId: row.friend_id,
        storyId: sid,
        phone: row.phone_e164,
        name: row.name,
      });
    }

    const friendCountAfterExisting = friendsRes.rows.length;
    await client.query("COMMIT");

    /** New users must be committed before social.service / chat (pool) runs — FK on user_interactions. */
    const createdFriends = [];
    let friendCount = friendCountAfterExisting;
    if (friendCount < minFriends && String(viewer.gender_main || "").trim().length > 0) {
      const need = minFriends - friendCount;
      for (let k = 1; k <= need; k += 1) {
        const idx = 910 + k;
        let candidate;
        try {
          await client.query("BEGIN");
          candidate = await upsertCompatibleCandidate(client, viewer, idx, {
            phonePrefix: "988789",
          });
          await client.query("COMMIT");
        } catch (e) {
          try {
            await client.query("ROLLBACK");
          } catch (_) {
            /* ignore */
          }
          throw e;
        }
        await ensureFriendshipAndThread(client, viewerId, candidate.userId, idx);
        try {
          await client.query("BEGIN");
          const sid = await replaceUserStoryFriendsOnly(
            client,
            candidate.userId,
            `dater-newfr-${viewerTag}`,
            idx
          );
          await client.query("COMMIT");
          createdFriends.push({
            userId: candidate.userId,
            storyId: sid,
            phone: candidate.phone_e164,
            name: candidate.name,
          });
          friendCount += 1;
        } catch (e) {
          try {
            await client.query("ROLLBACK");
          } catch (_) {
            /* ignore */
          }
          throw e;
        }
      }
    }

    console.log(
      JSON.stringify(
        {
          success: true,
          viewerPhone: phoneE164,
          viewerId,
          feedSeedPhonePattern: FEED_SEED_PHONE_PATTERN,
          feedUsersGivenStories: feedStoryIds.length,
          feedStories: feedStoryIds,
          friendsGivenStories: friendStoryIds.length,
          friendStories: friendStoryIds,
          newFriendsCreatedWithStories: createdFriends.length,
          newFriends: createdFriends,
          note:
            "EVERYONE stories on +91988770… feed seed users appear in home reel for the viewer; " +
            "FRIENDS_ONLY on friends for friend-ring testing. Run seed:feed:viewer first if feedStories is 0.",
        },
        null,
        2
      )
    );
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {
      /* ignore */
    }
    console.error("seedFeedAndFriendStoriesForViewerPhone failed:", e.message);
    process.exitCode = 1;
  } finally {
    try {
      await client.end();
    } catch (_) {
      /* ignore */
    }
  }
}

if (require.main === module) {
  main();
}
