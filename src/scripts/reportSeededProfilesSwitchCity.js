/**
 * Read-only: report whether seeded / synthetic users have `user_filters.preferred_location_city`
 * set (same signal as API `browseUsingSwitchCity` and feed `using_switch_city`).
 *
 * Seed scripts generally set preferred_location_city to anchor bots near a city — so they
 * appear as "using switch city" in the app even though that is not "premium user turned on
 * Switch city" in a product sense.
 *
 * Usage (from backend/, DATABASE_URL in .env):
 *   npm run report:seed:switch-city
 *   npm run report:seed:switch-city -- --detail 30
 *   npm run report:seed:switch-city -- --name "Ari Singh"
 */
require("dotenv").config();
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const { Client } = require("pg");

function seedBucket(phoneE164) {
  const p = String(phoneE164 || "");
  if (p.startsWith("+91988770")) return "feed-viewer-seed (988770…)";
  if (p.startsWith("+91988730")) return "notifications-bot-pool (98873…)";
  if (p.startsWith("+91988710")) return "story-reel-posters (98871…)";
  if (p.startsWith("+91988779")) return "story-one-pref (988779…)";
  if (p.startsWith("+919770")) return "delhi-gurugram-rich-mock (+919770…)";
  if (p.startsWith("+91888")) return "delhi-ggn-noida-rich (+91888…)";
  if (p.startsWith("+91999")) return "delhi-ncr-feed (+91999…)";
  if (p.startsWith("+91977440")) return "gurugram-rich (977440…)";
  return "matched-other";
}

async function main() {
  const args = process.argv.slice(2);
  const detailIdx = args.indexOf("--detail");
  const detailLimit = detailIdx >= 0 ? Math.min(500, Math.max(1, Number(args[detailIdx + 1]) || 25)) : 0;
  const nameIdx = args.indexOf("--name");
  const nameFilter = nameIdx >= 0 ? String(args[nameIdx + 1] || "").trim() : "";

  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is missing (.env at repo root or backend/).");
    process.exitCode = 1;
    return;
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    const params = nameFilter ? [`%${nameFilter}%`] : [];

    const summarySql = `
      SELECT
        CASE
          WHEN u.phone_e164 LIKE '+91988770%' THEN 'feed-viewer-seed (988770…)'
          WHEN u.phone_e164 LIKE '+91988730%' THEN 'notifications-bot-pool (98873…)'
          WHEN u.phone_e164 LIKE '+91988710%' THEN 'story-reel-posters (98871…)'
          WHEN u.phone_e164 LIKE '+91988779%' THEN 'story-one-pref (988779…)'
          WHEN u.phone_e164 LIKE '+919770%' THEN 'delhi-gurugram-rich-mock (+919770…)'
          WHEN u.phone_e164 LIKE '+91888%' THEN 'delhi-ggn-noida-rich (+91888…)'
          WHEN u.phone_e164 LIKE '+91999%' THEN 'delhi-ncr-feed (+91999…)'
          WHEN u.phone_e164 LIKE '+91977440%' THEN 'gurugram-rich (977440…)'
          ELSE 'other'
        END AS seed_bucket,
        COUNT(*)::int AS users,
        COUNT(*) FILTER (WHERE NULLIF(TRIM(uf.preferred_location_city), '') IS NOT NULL)::int AS with_pref_city,
        COUNT(*) FILTER (WHERE NULLIF(TRIM(uf.preferred_location_city), '') IS NULL)::int AS without_pref_city
      FROM users u
      JOIN user_filters uf ON uf.user_id = u.id
      WHERE ${nameFilter ? "u.name ILIKE $1 AND" : ""}
        u.deleted_at IS NULL
        AND (
          u.phone_e164 LIKE '+91988770%'
          OR u.phone_e164 LIKE '+91988730%'
          OR u.phone_e164 LIKE '+91988710%'
          OR u.phone_e164 LIKE '+91988779%'
          OR u.phone_e164 LIKE '+919770%'
          OR u.phone_e164 LIKE '+91888%'
          OR u.phone_e164 LIKE '+91999%'
          OR u.phone_e164 LIKE '+91977440%'
          ${nameFilter ? "OR u.name ILIKE $1" : ""}
        )
      GROUP BY 1
      ORDER BY 1;
    `;

    const { rows: sums } = await client.query(summarySql, params);
    console.log(JSON.stringify({ summaryBySeedBucket: sums }, null, 2));

    if (nameFilter) {
      const { rows: nameHits } = await client.query(
        `SELECT u.name, u.phone_e164,
                NULLIF(TRIM(uf.preferred_location_city), '') AS preferred_location_city,
                (NULLIF(TRIM(uf.preferred_location_city), '') IS NOT NULL) AS browse_using_switch_city,
                u.living_in_city, u.living_in_city_mode, u.is_premium
         FROM users u
         JOIN user_filters uf ON uf.user_id = u.id
         WHERE u.deleted_at IS NULL AND u.name ILIKE $1
         ORDER BY u.phone_e164
         LIMIT 50`,
        [`%${nameFilter}%`]
      );
      console.log(JSON.stringify({ nameSearch: nameHits }, null, 2));
    }

    if (detailLimit > 0) {
      const { rows: detail } = await client.query(
        `SELECT u.name, u.phone_e164,
                NULLIF(TRIM(uf.preferred_location_city), '') AS preferred_location_city,
                (NULLIF(TRIM(uf.preferred_location_city), '') IS NOT NULL) AS browse_using_switch_city,
                u.living_in_city, u.living_in_city_mode, u.is_premium
         FROM users u
         JOIN user_filters uf ON uf.user_id = u.id
         WHERE u.deleted_at IS NULL
           AND (
             u.phone_e164 LIKE '+91988770%'
             OR u.phone_e164 LIKE '+91988730%'
             OR u.phone_e164 LIKE '+91988710%'
             OR u.phone_e164 LIKE '+91988779%'
             OR u.phone_e164 LIKE '+919770%'
             OR u.phone_e164 LIKE '+91888%'
             OR u.phone_e164 LIKE '+91999%'
             OR u.phone_e164 LIKE '+91977440%'
           )
         ORDER BY u.phone_e164
         LIMIT $1`,
        [detailLimit]
      );
      const enriched = detail.map((r) => ({
        ...r,
        seed_bucket: seedBucket(r.phone_e164),
      }));
      console.log(JSON.stringify({ detailSample: enriched }, null, 2));
    }
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
