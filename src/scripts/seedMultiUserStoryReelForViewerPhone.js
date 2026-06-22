/**
 * Seeds ~15 active stories from multiple synthetic poster accounts for a viewer phone,
 * mixing friends (FRIENDS_ONLY + EVERYONE) and non-friends (EVERYONE only — required
 * for reel visibility per listStoryReelForViewer).
 *
 * Layout (default):
 * - 6 “friend” posters (friendship row with viewer) + 7 non-friends = 13 people.
 * - 1 friend has 3 stories; everyone else has 1 → 15 story rows total.
 *
 * From backend/:
 *   npm run seed:story:reel:multi -- 9354120990
 *   npm run seed:story:reel:multi -- +919354120990
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

/** 5-digit prefix: +91 + prefix + 5-digit index (distinct from feed 988770, notif bots 98873). */
const STORY_POSTER_PHONE_PREFIX = "98871";

function normalizedPair(a, b) {
  return a < b ? [a, b] : [b, a];
}

function mediaUrlForStory(posterIndex, storySeq) {
  const folder = posterIndex % 2 === 0 ? "men" : "women";
  const n = ((posterIndex * 7 + storySeq * 11) % 60) + 1;
  return `https://randomuser.me/api/portraits/${folder}/${n}.jpg`;
}

async function main() {
  const rawPhone = process.argv[2] || "9354120990";
  const phoneE164 = toE164(rawPhone);

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    await client.query("BEGIN");

    const vRes = await client.query(
      `SELECT u.id,
              u.name,
              u.age_years,
              u.gender_main,
              u.living_in_city,
              u.living_in_city_mode,
              u.is_verified,
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
       WHERE u.phone_e164 = $1
         AND u.deleted_at IS NULL
       LIMIT 1`,
      [phoneE164]
    );

    if (vRes.rows.length === 0) {
      throw new Error(`No user found for phone_e164=${phoneE164}`);
    }

    const viewer = vRes.rows[0];
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

    const posterSlots = 13;
    const posters = [];
    for (let i = 1; i <= posterSlots; i += 1) {
      const profile = await upsertCompatibleCandidate(client, viewer, i, {
        phonePrefix: STORY_POSTER_PHONE_PREFIX,
      });
      posters.push({ index: i, userId: profile.userId, name: profile.name, phone: profile.phone_e164 });
    }

    const posterIds = posters.map((p) => p.userId);
    await client.query(`DELETE FROM stories WHERE user_id = ANY($1::uuid[])`, [posterIds]);

    const friendIndices = new Set([1, 2, 3, 4, 5, 6]);
    for (const p of posters) {
      if (!friendIndices.has(p.index)) continue;
      const [u1, u2] = normalizedPair(viewer.id, p.userId);
      await client.query(
        `INSERT INTO friendships (u1_id, u2_id) VALUES ($1, $2)
         ON CONFLICT (u1_id, u2_id) DO NOTHING`,
        [u1, u2]
      );
    }

    const insertedStories = [];

    const multi = posters[0];
    for (let s = 1; s <= 3; s += 1) {
      const aud = s === 2 ? "EVERYONE" : "FRIENDS_ONLY";
      const ins = await client.query(
        `INSERT INTO stories (user_id, media_url, media_type, audience, expires_at)
         VALUES ($1::uuid, $2, 'IMAGE', $3, NOW() + INTERVAL '23 hours')
         RETURNING id`,
        [multi.userId, mediaUrlForStory(multi.index, s), aud]
      );
      insertedStories.push({
        storyId: ins.rows[0].id,
        posterIndex: multi.index,
        posterName: multi.name,
        audience: aud,
        isFriend: true,
        label: s === 1 ? "friend_multi_1" : s === 2 ? "friend_multi_everyone" : "friend_multi_3",
      });
    }

    for (let i = 1; i <= 5; i += 1) {
      const p = posters[i];
      const ins = await client.query(
        `INSERT INTO stories (user_id, media_url, media_type, audience, expires_at)
         VALUES ($1::uuid, $2, 'IMAGE', 'FRIENDS_ONLY', NOW() + INTERVAL '23 hours')
         RETURNING id`,
        [p.userId, mediaUrlForStory(p.index, 10)]
      );
      insertedStories.push({
        storyId: ins.rows[0].id,
        posterIndex: p.index,
        posterName: p.name,
        audience: "FRIENDS_ONLY",
        isFriend: true,
        label: "friend_single",
      });
    }

    for (let j = 6; j < 13; j += 1) {
      const p = posters[j];
      const ins = await client.query(
        `INSERT INTO stories (user_id, media_url, media_type, audience, expires_at)
         VALUES ($1::uuid, $2, 'IMAGE', 'EVERYONE', NOW() + INTERVAL '23 hours')
         RETURNING id`,
        [p.userId, mediaUrlForStory(p.index, 20)]
      );
      insertedStories.push({
        storyId: ins.rows[0].id,
        posterIndex: p.index,
        posterName: p.name,
        audience: "EVERYONE",
        isFriend: false,
        label: "non_friend_everyone",
      });
    }

    await client.query("COMMIT");

    console.log(
      JSON.stringify(
        {
          success: true,
          viewerPhone: phoneE164,
          viewerId: viewer.id,
          storyPosterPrefix: `+91${STORY_POSTER_PHONE_PREFIX}`,
          summary: {
            totalStories: insertedStories.length,
            friendPosters: 6,
            nonFriendPosters: 7,
            storiesFromMultiPoster: 3,
            note: "Poster 1 (first upsert index) has 3 slides; friends see FRIENDS_ONLY + EVERYONE; non-friends only EVERYONE.",
          },
          stories: insertedStories,
          posters,
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
    console.error("seedMultiUserStoryReelForViewerPhone failed:", e.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();
