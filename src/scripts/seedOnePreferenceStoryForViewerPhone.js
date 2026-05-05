/**
 * Creates exactly ONE feed/story-reel–compatible user (non-friend) with ONE active EVERYONE story
 * for a viewer phone — minimal reel smoke test (e.g. “one peer + three fillers”).
 *
 * Uses a dedicated phone range (+91988779xxxxx) so it won’t collide with feed seed (988770),
 * story repair prefs (988772), or reel-multi (98871).
 *
 * From backend/:
 *   npm run seed:story:one-pref:viewer -- 9354120990
 *   npm run seed:story:one-pref:viewer -- +919354120990
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

/** See upsertCompatibleCandidate: full phone is +91 + prefix + 5-digit padded index. */
const ONE_PREF_STORY_PREFIX = "988779";
/** Stable synthetic account for repeat runs (9198877900777 → depends on prefix+index math below). */
const ONE_PREF_STORY_INDEX = 777;

function mediaUrlOneStory(profile, seedIdx) {
  const folder = profile.genderMain === "Man" ? "men" : "women";
  const n = (seedIdx * 13 + 17) % 90;
  return `https://randomuser.me/api/portraits/${folder}/${n}.jpg`;
}

async function main() {
  const rawPhone = process.argv[2] || "9354120990";
  const phoneE164 = toE164(rawPhone);

  if (!process.env.DATABASE_URL || String(process.env.DATABASE_URL).trim() === "") {
    console.error("DATABASE_URL is missing (.env in repo root or backend/).");
    process.exitCode = 1;
    return;
  }

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
       FROM users u
       LEFT JOIN user_filters uf ON uf.user_id = u.id
       WHERE u.phone_e164 = $1
         AND u.deleted_at IS NULL
       LIMIT 1`,
      [phoneE164]
    );
    if (!viewerRes.rows[0]) {
      throw new Error(`Viewer not found for phone_e164=${phoneE164}`);
    }
    const viewer = viewerRes.rows[0];
    viewer.expand_age_range = viewer.expand_age_range === true;
    viewer.expand_distance = viewer.expand_distance === true;
    viewer.only_verified_profiles = viewer.only_verified_profiles === true;

    await ensureUserFiltersRow(client, viewer.id);
    await syncViewerInclusivePreferredGenders(client, viewer.id);

    const profile = await upsertCompatibleCandidate(client, viewer, ONE_PREF_STORY_INDEX, {
      phonePrefix: ONE_PREF_STORY_PREFIX,
    });

    await client.query(`DELETE FROM stories WHERE user_id = $1::uuid AND deleted_at IS NULL`, [profile.userId]);

    const ins = await client.query(
      `INSERT INTO stories (user_id, media_url, media_type, audience, created_at, expires_at)
       VALUES ($1::uuid, $2, 'IMAGE', 'EVERYONE',
               NOW() - INTERVAL '30 minutes',
               NOW() + INTERVAL '24 hours')
       RETURNING id`,
      [profile.userId, mediaUrlOneStory(profile, ONE_PREF_STORY_INDEX)]
    );

    await client.query("COMMIT");

    console.log(
      JSON.stringify(
        {
          success: true,
          viewerPhone: phoneE164,
          viewerId: viewer.id,
          posterUserId: profile.userId,
          posterPhone: profile.phone_e164,
          posterName: profile.name,
          storyId: ins.rows[0].id,
          note: "Non-friend EVERYONE story; eligible for home reel when viewer filters match.",
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
    console.error("seedOnePreferenceStoryForViewerPhone failed:", e.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();
