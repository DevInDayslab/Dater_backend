/**
 * Runs the same feed engine as GET /feed for a user resolved by phone — prints pool sizes
 * so you can tell backend vs client issues before seeding.
 *
 * From backend/ (requires DATABASE_URL in .env):
 *   npm run inspect:feed:viewer
 *   npm run inspect:feed:viewer -- 9354120990
 *
 * If totalCandidatePool > 0 but the app shows no cards, suspect Android/UI/cache.
 * If totalCandidatePool === 0, seed candidates:
 *   npm run seed:feed:viewer -- 9354120990 200
 */
require("dotenv").config();
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const { Client } = require("pg");
const { getFeed } = require("../services/feed.service");
const { toE164 } = require("./seedFeedProfilesForViewerPhone");

async function main() {
  const rawPhone = process.argv[2] || "9354120990";
  const phoneE164 = toE164(rawPhone);

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  let viewerRow;
  try {
    const vRes = await client.query(
      `SELECT u.id,
              u.name,
              u.phone_e164,
              u.location_granted,
              (u.location IS NOT NULL) AS has_location_coords,
              u.living_in_city,
              u.gender_main,
              u.age_years
       FROM users u
       WHERE u.phone_e164 = $1
         AND u.deleted_at IS NULL
       LIMIT 1`,
      [phoneE164]
    );
    if (vRes.rows.length === 0) {
      console.error(JSON.stringify({ error: "NO_USER", phoneE164 }, null, 2));
      process.exitCode = 1;
      return;
    }
    viewerRow = vRes.rows[0];

    const gCount = await client.query(
      `SELECT COUNT(*)::int AS n FROM user_filter_preferred_genders WHERE user_id = $1`,
      [viewerRow.id]
    );
    viewerRow.preferred_genders_count = gCount.rows[0].n;
  } finally {
    await client.end();
  }

  const feed = await getFeed(viewerRow.id, { page: 1, pageSize: 20 });
  if (feed?.code) {
    console.log(
      JSON.stringify(
        {
          viewer: { id: viewerRow.id, phone_e164: viewerRow.phone_e164, name: viewerRow.name },
          feedError: feed,
        },
        null,
        2
      )
    );
    process.exitCode = 1;
    return;
  }

  const diagnosis =
    feed.totalCandidatePool > 0
      ? "Backend has candidates — if the app is empty, check client (location gate, filters UI, cache)."
      : "Backend reports zero candidates — run seed:feed:viewer for this phone or widen filters/location on the viewer.";

  console.log(
    JSON.stringify(
      {
        viewer: {
          id: viewerRow.id,
          name: viewerRow.name,
          phone_e164: viewerRow.phone_e164,
          gender_main: viewerRow.gender_main,
          age_years: viewerRow.age_years,
          location_granted: viewerRow.location_granted,
          has_location_coords: viewerRow.has_location_coords,
          living_in_city: viewerRow.living_in_city,
          preferred_genders_count: viewerRow.preferred_genders_count,
        },
        feed: {
          totalCandidatePool: feed.totalCandidatePool,
          totalRegularPool: feed.totalRegularPool,
          firstPageCardCount: feed.cards?.length ?? 0,
          hasMore: feed.hasMore,
          sectionKinds: (feed.sections || []).map((s) => s.kind),
        },
        diagnosis,
      },
      null,
      2
    )
  );
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
