/**
 * Seeds story-reply chat messages (friends replying to YOUR story) and active stories on friends.
 *
 * Usage:
 *   node src/scripts/seedStoryRepliesAndStoriesForViewer.js [viewerPhoneE164Digits]
 *   Default phone: 9354120990
 *
 * Expects users named like "Dev Malik" and "Sia Reddy" (case-insensitive, flexible match).
 *
 * How to verify FRIENDS_ONLY vs EVERYONE (manual QA):
 * 1) As this viewer: you should see friends' stories in the reel; replies appear in DMs as STORY_REPLY bubbles.
 * 2) FRIENDS_ONLY: only accounts that are friends with the poster should see the story (use a second test
 *    account that is NOT friends — story should not appear for them).
 * 3) EVERYONE: a non-friend who is not blocked can see the story in discovery/reel (per your app rules).
 */

require("dotenv").config();

const { pool } = require("../config/db");
const chatService = require("../services/chat.service");
const { toE164 } = require("./seedFeedProfilesForViewerPhone");

function normalizedPair(a, b) {
  return a < b ? [a, b] : [b, a];
}

async function findViewer(client, phoneE164) {
  const r = await client.query(
    `SELECT id, name, phone_e164
     FROM users
     WHERE phone_e164 = $1
       AND deleted_at IS NULL
     LIMIT 1`,
    [phoneE164]
  );
  return r.rows[0] || null;
}

/** Match "Dev Malik", "dev malik", etc. */
async function findUserByNameHints(client, hints) {
  if (!hints.length) return null;
  const r = await client.query(
    `SELECT id, name
     FROM users
     WHERE deleted_at IS NULL
       AND (${hints
         .map(
           (_, i) =>
             `(LOWER(name) LIKE $${i * 2 + 1} AND LOWER(name) LIKE $${i * 2 + 2})`
         )
         .join(" OR ")})
     LIMIT 1`,
    hints.flatMap(([a, b]) => [`%${a}%`, `%${b}%`])
  );
  return r.rows[0] || null;
}

async function findUserByExactName(client, fullName) {
  const r = await client.query(
    `SELECT id, name
     FROM users
     WHERE deleted_at IS NULL
       AND lower(trim(name)) = lower(trim($1))
     LIMIT 1`,
    [fullName]
  );
  return r.rows[0] || null;
}

async function ensureFriendship(client, viewerId, friendId) {
  const [u1, u2] = normalizedPair(viewerId, friendId);
  const ex = await client.query(
    `SELECT 1 FROM friendships WHERE u1_id = $1 AND u2_id = $2 LIMIT 1`,
    [u1, u2]
  );
  if (ex.rowCount > 0) return;
  await client.query(
    `INSERT INTO friendships (u1_id, u2_id)
     VALUES ($1, $2)
     ON CONFLICT (u1_id, u2_id) DO NOTHING`,
    [u1, u2]
  );
}

/**
 * Latest non-expired story for this user + audience, or insert one.
 */
async function ensureActiveStory(client, userId, { audience, mediaUrl }) {
  const existing = await client.query(
    `SELECT id, audience::text AS audience
     FROM stories
     WHERE user_id = $1::uuid
       AND deleted_at IS NULL
       AND expires_at > NOW()
       AND COALESCE(audience::text, 'EVERYONE') = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId, audience]
  );
  if (existing.rows[0]) {
    return { id: existing.rows[0].id, audience: existing.rows[0].audience, reused: true };
  }
  const ins = await client.query(
    `INSERT INTO stories (user_id, media_url, media_type, audience, expires_at)
     VALUES ($1::uuid, $2, 'IMAGE', $3, NOW() + INTERVAL '23 hours')
     RETURNING id, audience::text AS audience`,
    [userId, mediaUrl, audience]
  );
  return { id: ins.rows[0].id, audience: ins.rows[0].audience, reused: false };
}

/**
 * Friend replies to viewer's story → chat message from friend (inbound for viewer).
 * Mirrors story.service addStoryReplyToChat inserts.
 */
async function insertStoryReplyFromFriendToViewerStory(friendId, viewerId, storyId, replyText) {
  const threadInfo = await chatService.getOrCreateDirectThread(friendId, viewerId);
  const threadId = threadInfo.threadId;

  const conn = await pool.connect();
  try {
    await conn.query("BEGIN");

    const srRes = await conn.query(
      `INSERT INTO story_replies (story_id, replier_user_id, story_owner_id, reply_text)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4)
       RETURNING id`,
      [storyId, friendId, viewerId, replyText]
    );
    const storyReplyId = srRes.rows[0].id;

    const msgRes = await conn.query(
      `INSERT INTO chat_messages (
         thread_id, sender_type, sender_user_id, message_type, message_text,
         referenced_story_id, referenced_story_reply_id
       )
       VALUES ($1::uuid, 'USER', $2::uuid, 'STORY_REPLY_REFERENCE', $3, $4::uuid, $5::uuid)
       RETURNING id`,
      [threadId, friendId, replyText, storyId, storyReplyId]
    );
    const msgId = msgRes.rows[0].id;

    await conn.query(`UPDATE story_replies SET chat_message_id = $2::uuid WHERE id = $1::uuid`, [
      storyReplyId,
      msgId,
    ]);

    await conn.query(`UPDATE chat_threads SET last_message_at = NOW() WHERE id = $1::uuid`, [threadId]);

    await conn.query(
      `UPDATE chat_thread_user_state
       SET unread_count_cache = 0,
           has_reply_badge = false,
           last_outbound_message_at = NOW(),
           updated_at = NOW()
       WHERE thread_id = $1::uuid AND user_id = $2::uuid`,
      [threadId, friendId]
    );
    await conn.query(
      `UPDATE chat_thread_user_state
       SET unread_count_cache = unread_count_cache + 1,
           has_reply_badge = true,
           last_inbound_message_at = NOW(),
           is_deleted_from_inbox = false,
           deleted_from_inbox_at = NULL,
           updated_at = NOW()
       WHERE thread_id = $1::uuid AND user_id = $2::uuid`,
      [threadId, viewerId]
    );

    await conn.query("COMMIT");
    return { storyReplyId, messageId: msgId, threadId };
  } catch (err) {
    await conn.query("ROLLBACK");
    throw err;
  } finally {
    conn.release();
  }
}

async function listFriendIds(client, viewerId, limit) {
  const r = await client.query(
    `SELECT CASE WHEN f.u1_id = $1::uuid THEN f.u2_id ELSE f.u1_id END AS friend_id,
            u.name
     FROM friendships f
     JOIN users u ON u.id = CASE WHEN f.u1_id = $1::uuid THEN f.u2_id ELSE f.u1_id END
     WHERE f.u1_id = $1::uuid OR f.u2_id = $1::uuid
     ORDER BY u.name ASC
     LIMIT $2`,
    [viewerId, limit]
  );
  return r.rows;
}

async function main() {
  const rawPhone = process.argv[2] || "9354120990";
  const phoneE164 = toE164(rawPhone);
  const client = await pool.connect();
  try {
    const viewer = await findViewer(client, phoneE164);
    if (!viewer) {
      console.error(`Viewer not found for phone ${phoneE164}`);
      process.exitCode = 1;
      return;
    }

    const viewerId = viewer.id;
    const viewerStoryUrl = `https://picsum.photos/seed/dater-viewer-story-${String(viewerId).slice(0, 8)}/1080/1920`;

    const viewerStoryFriends = await ensureActiveStory(client, viewerId, {
      audience: "FRIENDS_ONLY",
      mediaUrl: viewerStoryUrl,
    });

    const viewerStoryEveryone = await ensureActiveStory(client, viewerId, {
      audience: "EVERYONE",
      mediaUrl: `https://picsum.photos/seed/dater-viewer-everyone-${String(viewerId).slice(0, 8)}/1080/1920`,
    });

    let dev =
      (await findUserByNameHints(client, [["dev", "malik"]])) ||
      (await findUserByExactName(client, "Dev Malik"));
    let sia =
      (await findUserByNameHints(client, [["sia", "reddy"]])) ||
      (await findUserByExactName(client, "Sia Reddy"));

    const storyReplies = [];
    if (dev) {
      await ensureFriendship(client, viewerId, dev.id);
      const r = await insertStoryReplyFromFriendToViewerStory(
        dev.id,
        viewerId,
        viewerStoryFriends.id,
        "Loving this — had to drop a story reply here 🔥"
      );
      storyReplies.push({ friend: dev.name, ...r });
    } else {
      console.warn("No user matched for Dev Malik (hints: dev + malik). Skip story reply.");
    }

    if (sia) {
      await ensureFriendship(client, viewerId, sia.id);
      const r = await insertStoryReplyFromFriendToViewerStory(
        sia.id,
        viewerId,
        viewerStoryFriends.id,
        "Haha this is so good! Replying from your story 😂"
      );
      storyReplies.push({ friend: sia.name, ...r });
    } else {
      console.warn("No user matched for Sia Reddy (hints: sia + reddy). Skip story reply.");
    }

    const friends = await listFriendIds(client, viewerId, 16);
    const storySeeds = [];
    for (let i = 0; i < friends.length; i += 1) {
      const { friend_id: friendId, name } = friends[i];
      const audience = i % 2 === 0 ? "FRIENDS_ONLY" : "EVERYONE";
      const url = `https://picsum.photos/seed/dater-friend-${i}-${String(friendId).slice(0, 8)}/1080/1920`;
      const st = await ensureActiveStory(client, friendId, {
        audience,
        mediaUrl: url,
      });
      storySeeds.push({
        name,
        friendId,
        storyId: st.id,
        audience: st.audience,
        reused: st.reused,
      });
    }

    console.log(
      JSON.stringify(
        {
          success: true,
          viewer: { phoneE164, id: viewerId, name: viewer.name },
          viewerStories: {
            friendsOnly: { id: viewerStoryFriends.id, reused: viewerStoryFriends.reused },
            everyone: { id: viewerStoryEveryone.id, reused: viewerStoryEveryone.reused },
          },
          storyRepliesFromFriends: storyReplies,
          friendStoriesSeeded: storySeeds,
          qa: {
            friendsOnlyVsEveryone:
              "FRIENDS_ONLY: only friends of the poster should see it. EVERYONE: non-friends can see if your feed rules allow discovery.",
            howToTest:
              "Use a second account that is not friends with a FRIENDS_ONLY poster — that story should be hidden. EVERYONE should still be visible where your app shows non-friend stories.",
          },
        },
        null,
        2
      )
    );
  } catch (err) {
    console.error("seedStoryRepliesAndStoriesForViewer failed:", err.message);
    process.exitCode = 1;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };
