/**
 * Soft-delete all active (non-deleted) stories in the database. Development / reset helper.
 *
 * Does not remove users or friendships. Re-seed with:
 *   npm run seed:friends:active:viewer -- <phone_e164_country_digits>   # if you need friends first
 *   npm run seed:story:repair:viewer -- <phone>
 *
 * From backend/:
 *   npm run dev:clear-stories
 */
require("dotenv").config();
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const { Client } = require("pg");

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    const r = await client.query(
      `UPDATE stories
       SET deleted_at = NOW(),
           media_purge_after = COALESCE(media_purge_after, NOW() + INTERVAL '6 months')
       WHERE deleted_at IS NULL`
    );
    console.log(
      JSON.stringify(
        { success: true, softDeletedStoryRows: r.rowCount },
        null,
        2
      )
    );
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error("clearAllActiveStories failed:", e.message);
  process.exitCode = 1;
});
