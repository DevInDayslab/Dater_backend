/**
 * Adds VIEW / LIKE / COMMENT rows on the owner's latest active story (one story only).
 * Picks random other users from the DB (no friendship requirement).
 *
 * From backend/:
 *   npm run seed:story:interactions -- 9354120990
 *   npm run seed:story:interactions -- 9354120990 1   # clear interactions on that story first
 */
require("dotenv").config();
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const { Client } = require("pg");

function toE164(raw) {
  const s = String(raw || "").trim().replace(/\s/g, "");
  if (s.startsWith("+")) return s;
  const digits = s.replace(/\D/g, "");
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  if (digits.length > 0) return `+${digits}`;
  return s;
}

const COMMENT_TEXTS = [
  "Love this 🔥",
  "So good!",
  "Haha yes",
  "Beautiful",
  "Made me smile",
  "This is a vibe",
];

async function batchViews(client, storyId, ownerId, actorIds) {
  if (actorIds.length === 0) return 0;
  const r = await client.query(
    `INSERT INTO story_interactions (story_id, actor_user_id, story_owner_id, interaction_type)
     SELECT $1::uuid, x.uid::uuid, $2::uuid, 'VIEW'::story_interaction_type_enum
     FROM unnest($3::uuid[]) AS x(uid)
     WHERE NOT EXISTS (
       SELECT 1 FROM story_interactions si
       WHERE si.story_id = $1::uuid
         AND si.actor_user_id = x.uid::uuid
         AND si.interaction_type = 'VIEW'
     )`,
    [storyId, ownerId, actorIds]
  );
  return r.rowCount ?? 0;
}

async function batchLikes(client, storyId, ownerId, actorIds) {
  if (actorIds.length === 0) return 0;
  const r = await client.query(
    `INSERT INTO story_interactions (story_id, actor_user_id, story_owner_id, interaction_type)
     SELECT $1::uuid, x.uid::uuid, $2::uuid, 'LIKE'::story_interaction_type_enum
     FROM unnest($3::uuid[]) AS x(uid)
     WHERE NOT EXISTS (
       SELECT 1 FROM story_interactions si
       WHERE si.story_id = $1::uuid
         AND si.actor_user_id = x.uid::uuid
         AND si.interaction_type = 'LIKE'
     )`,
    [storyId, ownerId, actorIds]
  );
  return r.rowCount ?? 0;
}

async function batchComments(client, storyId, ownerId, pairs) {
  let n = 0;
  for (const { id, text } of pairs) {
    const r = await client.query(
      `INSERT INTO story_interactions (story_id, actor_user_id, story_owner_id, interaction_type, comment_text)
       SELECT $1::uuid, $2::uuid, $3::uuid, 'COMMENT'::story_interaction_type_enum, $4
       WHERE NOT EXISTS (
         SELECT 1 FROM story_interactions si
         WHERE si.story_id = $1::uuid
           AND si.actor_user_id = $2::uuid
           AND si.interaction_type = 'COMMENT'
       )`,
      [storyId, id, ownerId, text]
    );
    n += r.rowCount ?? 0;
  }
  return n;
}

async function main() {
  const rawPhone = process.argv[2] || "";
  const doClear = String(process.argv[3] || "").trim() === "1";
  if (!rawPhone.trim()) {
    console.error("Usage: npm run seed:story:interactions -- <phone> [1=clear story interactions first]");
    process.exit(1);
  }
  const phoneE164 = toE164(rawPhone);

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    await client.query("BEGIN");

    const ownerRes = await client.query(
      `SELECT id FROM users WHERE phone_e164 = $1 AND deleted_at IS NULL LIMIT 1`,
      [phoneE164]
    );
    if (!ownerRes.rows[0]) {
      throw new Error(`Owner not found for ${phoneE164}`);
    }
    const ownerId = ownerRes.rows[0].id;

    const storyRes = await client.query(
      `SELECT id FROM stories
       WHERE user_id = $1::uuid
         AND deleted_at IS NULL
         AND expires_at > NOW()
       ORDER BY created_at DESC
       LIMIT 1`,
      [ownerId]
    );
    if (!storyRes.rows[0]) {
      throw new Error("No active (non-expired) story for this user. Post a story first.");
    }
    const storyId = storyRes.rows[0].id;

    if (doClear) {
      await client.query(`DELETE FROM story_interactions WHERE story_id = $1::uuid`, [storyId]);
    }

    const actorsRes = await client.query(
      `SELECT id FROM users
       WHERE id <> $1::uuid
         AND deleted_at IS NULL
       ORDER BY random()
       LIMIT 60`,
      [ownerId]
    );
    const actors = actorsRes.rows.map((r) => r.id);
    if (actors.length < 25) {
      throw new Error(
        `Need at least 25 other users in the database; found ${actors.length}. Run a feed seed first.`
      );
    }

    const nView = 18;
    const nLike = 8;
    const nComment = 6;
    const viewIds = actors.slice(0, nView);
    const likeIds = actors.slice(nView, nView + nLike);
    const commentIds = actors.slice(nView + nLike, nView + nLike + nComment);

    const insertedViews = await batchViews(client, storyId, ownerId, viewIds);
    const insertedLikes = await batchLikes(client, storyId, ownerId, likeIds);
    const insertedComments = await batchComments(
      client,
      storyId,
      ownerId,
      commentIds.map((id, i) => ({ id, text: COMMENT_TEXTS[i % COMMENT_TEXTS.length] }))
    );

    const cnt = await client.query(
      `SELECT
         (SELECT COUNT(*)::int FROM story_interactions WHERE story_id = $1::uuid AND interaction_type = 'VIEW') AS v,
         (SELECT COUNT(*)::int FROM story_interactions WHERE story_id = $1::uuid AND interaction_type = 'LIKE') AS l,
         (SELECT COUNT(*)::int FROM story_interactions WHERE story_id = $1::uuid AND interaction_type = 'COMMENT') AS c`,
      [storyId]
    );

    await client.query("COMMIT");

    console.log(
      JSON.stringify(
        {
          success: true,
          ownerPhone: phoneE164,
          storyId,
          insertedThisRun: {
            views: insertedViews,
            likes: insertedLikes,
            comments: insertedComments,
          },
          totalsOnStory: cnt.rows[0],
        },
        null,
        2
      )
    );
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("seedStoryInteractionsForOwnerPhone failed:", e.message || e);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();
