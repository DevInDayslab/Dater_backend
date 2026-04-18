/**
 * Seeds story_interactions for two of the owner's stories (demo / QA):
 * - Story A (newer): ~20 VIEW-only rows + a few LIKE/COMMENT + optional friend VIEW/LIKE.
 * - Story B (older): ~80 VIEW-only rows + a few LIKE/COMMENT + optional friend VIEW/LIKE.
 *
 * Needs ~130+ other users (excluding owner). If you have fewer, run a feed seed first (e.g. npm run seed:feed:ncr).
 *
 * From backend/:
 *   npm run seed:story:activity:demo -- 9354120990
 *   npm run seed:story:activity:demo -- 9354120990 1   # clear existing interactions on those stories first
 */
require("dotenv").config();
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const { Client } = require("pg");

function toE164(raw) {
  const d = String(raw || "").replace(/\D/g, "");
  if (d.length === 10) return `+91${d}`;
  if (d.startsWith("91") && d.length === 12) return `+${d}`;
  if (raw && String(raw).trim().startsWith("+")) return String(raw).trim();
  return `+${d}`;
}

async function batchInsertViews(client, storyId, ownerId, actorIds) {
  if (actorIds.length === 0) return 0;
  const res = await client.query(
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
  return res.rowCount;
}

async function batchInsertLikes(client, storyId, ownerId, actorIds) {
  if (actorIds.length === 0) return 0;
  const res = await client.query(
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
  return res.rowCount;
}

async function batchInsertComments(client, storyId, ownerId, pairs) {
  if (pairs.length === 0) return 0;
  let n = 0;
  for (const { id, text } of pairs) {
    const r = await client.query(
      `INSERT INTO story_interactions (story_id, actor_user_id, story_owner_id, interaction_type, comment_text)
       SELECT $1::uuid, $2::uuid, $3::uuid, 'COMMENT', $4
       WHERE NOT EXISTS (
         SELECT 1 FROM story_interactions si
         WHERE si.story_id = $1::uuid
           AND si.actor_user_id = $2::uuid
           AND si.interaction_type = 'COMMENT'
       )`,
      [storyId, id, ownerId, text]
    );
    n += r.rowCount;
  }
  return n;
}

const COMMENT_TEXTS = [
  "This is such a good vibe 🔥",
  "Love this — made me smile",
  "Haha yes, same here",
  "Beautiful shot",
  "Need tips on this sometime",
];

/** Distinct actors needed: 20+6+5 + 80+12+8 (friends may reuse IDs not in these slices). */
const MIN_OTHER_USERS = 131;
const VIEWS_STORY_NEWER = 20;
const VIEWS_STORY_OLDER = 80;

async function main() {
  const rawPhone = process.argv[2] || "";
  const doClear = String(process.argv[3] || "").trim() === "1";
  if (!rawPhone.trim()) {
    console.error("Usage: node src/scripts/seedStoryActivityDemo.js <ownerPhone> [1=clear interactions first]");
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

    const storiesRes = await client.query(
      `SELECT id FROM stories
       WHERE user_id = $1::uuid AND deleted_at IS NULL
       ORDER BY created_at DESC
       LIMIT 2`,
      [ownerId]
    );
    if (storiesRes.rows.length < 2) {
      throw new Error("Need at least 2 active stories for this owner. Post two stories first.");
    }
    const storySmall = storiesRes.rows[0].id;
    const storyLarge = storiesRes.rows[1].id;

    if (doClear) {
      await client.query(`DELETE FROM story_interactions WHERE story_id = ANY($1::uuid[])`, [
        [storySmall, storyLarge],
      ]);
      console.log("Cleared story_interactions for the two target stories.");
    }

    const actorsRes = await client.query(
      `SELECT id FROM users
       WHERE id <> $1::uuid
         AND deleted_at IS NULL
       ORDER BY created_at DESC
       LIMIT 500`,
      [ownerId]
    );
    const allActors = actorsRes.rows.map((r) => r.id);
    if (allActors.length < MIN_OTHER_USERS) {
      throw new Error(
        `Need at least ${MIN_OTHER_USERS} other users; found ${allActors.length}. Run e.g. npm run seed:feed:ncr, or lower VIEWS_STORY_* / like/comment counts in this script.`
      );
    }

    let offset = 0;
    const take = (n) => {
      const slice = allActors.slice(offset, offset + n);
      offset += n;
      return slice;
    };

    const friendsRes = await client.query(
      `SELECT CASE WHEN f.u1_id = $1::uuid THEN f.u2_id ELSE f.u1_id END AS fid
       FROM friendships f
       WHERE f.u1_id = $1::uuid OR f.u2_id = $1::uuid
       ORDER BY f.created_at ASC
       LIMIT 40`,
      [ownerId]
    );
    const friendIds = friendsRes.rows.map((r) => r.fid);

    // --- Story A (newer): smaller view count
    const aView = take(VIEWS_STORY_NEWER);
    const aLike = take(6);
    const aComment = take(5);
    const fViewA = friendIds.slice(0, 3).filter((id) => !aView.includes(id) && !aLike.includes(id) && !aComment.includes(id));
    const fLikeA = friendIds.slice(3, 6).filter((id) => !aView.includes(id) && !aLike.includes(id) && !aComment.includes(id));

    await batchInsertViews(client, storySmall, ownerId, aView);
    await batchInsertLikes(client, storySmall, ownerId, aLike);
    await batchInsertComments(
      client,
      storySmall,
      ownerId,
      aComment.map((id, i) => ({ id, text: COMMENT_TEXTS[i % COMMENT_TEXTS.length] }))
    );
    if (fViewA.length) await batchInsertViews(client, storySmall, ownerId, fViewA);
    if (fLikeA.length) await batchInsertLikes(client, storySmall, ownerId, fLikeA);

    // --- Story B (older): larger view count
    const bView = take(VIEWS_STORY_OLDER);
    const bLike = take(12);
    const bComment = take(8);
    const fViewB = friendIds.slice(6, 11).filter((id) => !bView.includes(id) && !bLike.includes(id) && !bComment.includes(id));
    const fLikeB = friendIds.slice(11, 16).filter((id) => !bView.includes(id) && !bLike.includes(id) && !bComment.includes(id));

    await batchInsertViews(client, storyLarge, ownerId, bView);
    await batchInsertLikes(client, storyLarge, ownerId, bLike);
    await batchInsertComments(
      client,
      storyLarge,
      ownerId,
      bComment.map((id, i) => ({ id, text: COMMENT_TEXTS[(i + 2) % COMMENT_TEXTS.length] }))
    );
    if (fViewB.length) await batchInsertViews(client, storyLarge, ownerId, fViewB);
    if (fLikeB.length) await batchInsertLikes(client, storyLarge, ownerId, fLikeB);

    const cnt = async (sid) => {
      const r = await client.query(
        `SELECT
           (SELECT COUNT(*)::int FROM story_interactions WHERE story_id = $1::uuid AND interaction_type = 'VIEW') AS v,
           (SELECT COUNT(*)::int FROM story_interactions WHERE story_id = $1::uuid AND interaction_type = 'LIKE') AS l,
           (SELECT COUNT(*)::int FROM story_interactions WHERE story_id = $1::uuid AND interaction_type = 'COMMENT') AS c`,
        [sid]
      );
      return r.rows[0];
    };

    await client.query("COMMIT");

    const s = await cnt(storySmall);
    const l = await cnt(storyLarge);
    console.log("Done.");
    console.log(`Story A (${storySmall}): VIEW=${s.v} LIKE=${s.l} COMMENT=${s.c}`);
    console.log(`Story B (${storyLarge}): VIEW=${l.v} LIKE=${l.l} COMMENT=${l.c}`);
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e.message || e);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();
