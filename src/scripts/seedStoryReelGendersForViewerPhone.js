/**
 * Seed active story posters across Man/Woman/Nonbinary for a specific viewer phone.
 *
 * Goal: make it easy to test story reel filtering after server-side changes:
 * - Friends should always show (FRIENDS_ONLY or EVERYONE).
 * - Non-friends should only show if audience=EVERYONE AND they pass feed eligibility.
 *
 * From backend/:
 *   npm run seed:story:reel:genders -- 9811700705
 *   npm run seed:story:reel:genders -- +919811700705
 *
 * Args:
 *   <viewer_phone> [perGenderNonFriend=3] [perGenderFriend=1]
 *
 * Notes:
 * - Does NOT modify viewer filter preferences (so you can test exclusions).
 * - Uses upsertCompatibleCandidate() to keep candidates feed-compatible by default.
 */
require("dotenv").config();
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const { Client } = require("pg");
const {
  toE164,
  ensureUserFiltersRow,
  upsertCompatibleCandidate,
  nextSeedIndexAfterPrefix,
} = require("./seedFeedProfilesForViewerPhone");

/** Distinct from feed (988770), repair (988772), multi reel (98871). */
const GENDER_REEL_PHONE_PREFIX = "988718";

function normalizedPair(a, b) {
  return a < b ? [a, b] : [b, a];
}

function mediaUrlForGender(genderMain, seed) {
  const folder = genderMain === "Man" ? "men" : "women";
  const n = ((seed * 13) % 90) + 1;
  return `https://randomuser.me/api/portraits/${folder}/${n}.jpg`;
}

function parseIntArg(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function remainderForGender(genderMain) {
  if (genderMain === "Woman") return 0;
  if (genderMain === "Man") return 1;
  return 2; // Nonbinary
}

function alignIndexToGender(index, genderMain) {
  const want = remainderForGender(genderMain);
  let i = index;
  while (i % 3 !== want) i += 1;
  return i;
}

async function main() {
  const rawPhone = process.argv[2] || "9811700705";
  const perGenderNonFriend = parseIntArg(process.argv[3], 3);
  const perGenderFriend = parseIntArg(process.argv[4], 1);
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
       WHERE u.phone_e164 = $1
         AND u.deleted_at IS NULL
       LIMIT 1`,
      [phoneE164]
    );
    if (!vRes.rows[0]) throw new Error(`No user found for phone_e164=${phoneE164}`);
    const viewer = vRes.rows[0];
    viewer.expand_age_range = viewer.expand_age_range === true;
    viewer.expand_distance = viewer.expand_distance === true;
    viewer.only_verified_profiles = viewer.only_verified_profiles === true;

    await ensureUserFiltersRow(client, viewer.id);

    const genders = ["Woman", "Man", "Nonbinary"];
    const createdUsers = [];
    const createdStories = [];

    let nextIdx = await nextSeedIndexAfterPrefix(client, GENDER_REEL_PHONE_PREFIX);
    // Ensure we create a predictable count per gender without relying on caller knowing modulo math.
    for (const genderMain of genders) {
      // Non-friends (EVERYONE)
      for (let i = 0; i < perGenderNonFriend; i += 1) {
        nextIdx = alignIndexToGender(nextIdx, genderMain);
        const profile = await upsertCompatibleCandidate(client, viewer, nextIdx, {
          phonePrefix: GENDER_REEL_PHONE_PREFIX,
        });
        createdUsers.push({ ...profile, seedIndex: nextIdx, kind: "NON_FRIEND" });
        nextIdx += 1;
      }
      // Friends (FRIENDS_ONLY)
      for (let i = 0; i < perGenderFriend; i += 1) {
        nextIdx = alignIndexToGender(nextIdx, genderMain);
        const profile = await upsertCompatibleCandidate(client, viewer, nextIdx, {
          phonePrefix: GENDER_REEL_PHONE_PREFIX,
        });
        const [u1, u2] = normalizedPair(viewer.id, profile.userId);
        await client.query(
          `INSERT INTO friendships (u1_id, u2_id) VALUES ($1, $2)
           ON CONFLICT (u1_id, u2_id) DO NOTHING`,
          [u1, u2]
        );
        createdUsers.push({ ...profile, seedIndex: nextIdx, kind: "FRIEND" });
        nextIdx += 1;
      }
    }

    const allIds = createdUsers.map((u) => u.userId);
    if (allIds.length > 0) {
      await client.query(`DELETE FROM stories WHERE user_id = ANY($1::uuid[])`, [allIds]);
    }

    for (const u of createdUsers) {
      const audience = u.kind === "FRIEND" ? "FRIENDS_ONLY" : "EVERYONE";
      const mediaUrl = mediaUrlForGender(u.genderMain, u.seedIndex);
      const ins = await client.query(
        `INSERT INTO stories (user_id, media_url, media_type, audience, expires_at)
         VALUES ($1::uuid, $2, 'IMAGE', $3, NOW() + INTERVAL '23 hours')
         RETURNING id`,
        [u.userId, mediaUrl, audience]
      );
      createdStories.push({
        storyId: ins.rows[0].id,
        userId: u.userId,
        name: u.name,
        genderMain: u.genderMain,
        kind: u.kind,
        audience,
        phone_e164: u.phone_e164,
      });
    }

    await client.query("COMMIT");

    console.log(
      JSON.stringify(
        {
          success: true,
          viewerPhone: phoneE164,
          viewerId: viewer.id,
          phonePrefix: `+91${GENDER_REEL_PHONE_PREFIX}`,
          summary: {
            perGenderNonFriend,
            perGenderFriend,
            totalUsers: createdUsers.length,
            totalStories: createdStories.length,
          },
          users: createdUsers.map((u) => ({
            userId: u.userId,
            phone_e164: u.phone_e164,
            name: u.name,
            genderMain: u.genderMain,
            kind: u.kind,
            seedIndex: u.seedIndex,
          })),
          stories: createdStories,
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
    console.error("seedStoryReelGendersForViewerPhone failed:", e.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();

