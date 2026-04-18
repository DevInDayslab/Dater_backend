/**
 * Repairs home story reel seed data for a viewer phone:
 * - Deletes broken placeholder stories (images.dater.app/story-seed…).
 * - Inserts up to 5 friend stories (FRIENDS_ONLY) on existing friends, with real HTTPS image URLs.
 * - Inserts 10 feed-compatible non-friend stories (EVERYONE) for reel / comment / reply testing.
 * - Optionally seeds 12 incoming friend requests (6 plain + 6 comment) from a dedicated phone range.
 *
 * Reset all stories first (optional):
 *   npm run dev:clear-stories
 *
 * Ensure the viewer has friends (if you need friend stories):
 *   npm run seed:friends:active:viewer -- 9354120990
 *
 * From backend/:
 *   npm run seed:story:repair:viewer -- 9354120990
 *   npm run seed:story:repair:viewer -- 9354120990 1   # include friend requests (default 1)
 *   npm run seed:story:repair:viewer -- 9354120990 0   # stories only
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

/** Non-friend “preferences” story posters — distinct from feed 988770 and notif 988773. */
const PREF_STORY_PHONE_PREFIX = "988772";
/** Incoming request senders — distinct batch. */
const REQ_STORY_PHONE_PREFIX = "988776";

const COMMENT_SAMPLES = [
  "Loved your prompts — would love to chat sometime.",
  "Hey! We’re into the same music; mind connecting?",
  "Your photos made me smile. Coffee sometime?",
  "Hi — I’m new here and your profile stood out.",
  "That travel answer was great. Any tips for Goa?",
  "Sent you a request after reading your bio :)",
];

function buildCommentText(i) {
  return COMMENT_SAMPLES[(i - 1) % COMMENT_SAMPLES.length];
}

async function grantSenderCommentCredits(pool, userId) {
  await pool.query(
    `INSERT INTO user_comment_wallet (user_id, remaining_paid_comments, updated_at)
     VALUES ($1, 50, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       remaining_paid_comments = user_comment_wallet.remaining_paid_comments + 50,
       updated_at = NOW()`,
    [userId]
  );
}

async function main() {
  const rawPhone = process.argv[2] || "9354120990";
  const rawSeedRequests = process.argv[3];
  const seedRequests = rawSeedRequests == null ? true : String(rawSeedRequests).trim() !== "0";
  const phoneE164 = toE164(rawPhone);

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  let committed = false;
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
       FROM users u
       LEFT JOIN user_filters uf ON uf.user_id = u.id
       WHERE phone_e164 = $1
         AND deleted_at IS NULL
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

    const delBad = await client.query(
      `DELETE FROM stories
       WHERE media_url LIKE '%images.dater.app/story-seed%'
          OR media_url LIKE '%story-seed%'`
    );

    const friendsRes = await client.query(
      `SELECT CASE WHEN f.u1_id = $1::uuid THEN f.u2_id ELSE f.u1_id END AS friend_id
       FROM friendships f
       WHERE f.u1_id = $1::uuid OR f.u2_id = $1::uuid
       ORDER BY f.created_at ASC
       LIMIT 5`,
      [viewer.id]
    );
    const friendIds = friendsRes.rows.map((r) => r.friend_id);

    const friendStories = [];
    friendIds.forEach((fid, i) => {
      const idx = i + 1;
      const hoursAgo = 1 + (idx % 10);
      const mediaUrl = `https://picsum.photos/seed/dater-friend-${viewer.id.slice(0, 8)}-${idx}/1080/1920`;
      friendStories.push({ fid, idx, hoursAgo, mediaUrl });
    });

    for (const { fid, idx, hoursAgo, mediaUrl } of friendStories) {
      await client.query(`DELETE FROM stories WHERE user_id = $1::uuid AND deleted_at IS NULL`, [fid]);
      await client.query(
        `INSERT INTO stories (user_id, media_url, media_type, audience, created_at, expires_at)
         VALUES ($1::uuid, $2, 'IMAGE', 'FRIENDS_ONLY',
                 NOW() - ($3::int * INTERVAL '1 hour'),
                 NOW() + INTERVAL '24 hours')`,
        [fid, mediaUrl, hoursAgo]
      );
    }

    const prefProfiles = [];
    for (let i = 1; i <= 10; i += 1) {
      const profile = await upsertCompatibleCandidate(client, viewer, 500 + i, {
        phonePrefix: PREF_STORY_PHONE_PREFIX,
      });
      prefProfiles.push(profile);
    }

    for (let i = 0; i < prefProfiles.length; i += 1) {
      const p = prefProfiles[i];
      await client.query(`DELETE FROM stories WHERE user_id = $1::uuid AND deleted_at IS NULL`, [p.userId]);
      const hoursAgo = 1 + (i % 10);
      const portraitIdx = (500 + i) % 90;
      const folder = p.genderMain === "Man" ? "men" : "women";
      const mediaUrl = `https://randomuser.me/api/portraits/${folder}/${portraitIdx}.jpg`;
      await client.query(
        `INSERT INTO stories (user_id, media_url, media_type, audience, created_at, expires_at)
         VALUES ($1::uuid, $2, 'IMAGE', 'EVERYONE',
                 NOW() - ($3::int * INTERVAL '1 hour'),
                 NOW() + INTERVAL '24 hours')`,
        [p.userId, mediaUrl, hoursAgo]
      );
    }

    await client.query("COMMIT");
    committed = true;

    const out = {
      success: true,
      viewerPhone: phoneE164,
      viewerId: viewer.id,
      deletedPlaceholderStories: delBad.rowCount,
      friendStoryUserIds: friendIds,
      preferenceStoryUserIds: prefProfiles.map((p) => p.userId),
      seededRequests: 0,
    };

    if (seedRequests) {
      const { pool } = require("../config/db");
      const { sendFriendRequest, sendCommentRequest } = require("../services/social.service");
      const normalCount = 6;
      const staged = [];
      for (let i = 1; i <= 12; i += 1) {
        const profile = await upsertCompatibleCandidate(client, viewer, 100 + i, {
          phonePrefix: REQ_STORY_PHONE_PREFIX,
        });
        staged.push({ profile, index: i });
      }
      const created = [];
      for (const { profile, index } of staged) {
        const asComment = index > normalCount;
        const commentText = asComment ? buildCommentText(index) : null;
        if (asComment) {
          await grantSenderCommentCredits(pool, profile.userId);
          await sendCommentRequest(profile.userId, viewer.id, commentText);
        } else {
          await sendFriendRequest(profile.userId, viewer.id);
        }
        created.push({
          fromUserId: profile.userId,
          interactionType: asComment ? "COMMENT_REQUEST" : "REQUEST",
        });
      }
      out.seededRequests = created.length;
      out.requestSplit = { normal: normalCount, comment: 12 - normalCount };
      out.requestSenders = created;
    }

    console.log(JSON.stringify(out, null, 2));
  } catch (e) {
    if (!committed) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {
        /* ignore */
      }
    }
    console.error("seedStoryReelRepairForViewerPhone failed:", e.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();
