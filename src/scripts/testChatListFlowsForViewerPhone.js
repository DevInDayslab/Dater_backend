require("dotenv").config();

const { query } = require("../config/db");
const chatService = require("../services/chat.service");
const socialService = require("../services/social.service");

function assertTrue(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const phone = process.argv[2] || "9354120990";
  const phoneE164 = phone.startsWith("+") ? phone : `+91${phone}`;
  const viewerRes = await query(
    `SELECT id FROM users WHERE phone_e164 = $1 AND deleted_at IS NULL LIMIT 1`,
    [phoneE164]
  );
  const viewerId = viewerRes.rows[0]?.id;
  if (!viewerId) throw new Error(`Viewer not found for ${phoneE164}`);

  const friends = await socialService.listFriends(viewerId, { sort: "NEARBY" });
  assertTrue(friends.length > 0, "Expected at least one friend for viewer");
  const onlineFriends = friends.filter((f) => f.isOnline);
  assertTrue(onlineFriends.length > 0, "Expected online friends for green activity dot");

  const recent = await chatService.listThreads(viewerId, { sort: "RECENT", search: "" });
  const nearby = await chatService.listThreads(viewerId, { sort: "NEARBY", search: "" });
  const unread = await chatService.listThreads(viewerId, { sort: "UNREAD", search: "" });
  const unanswered = await chatService.listThreads(viewerId, { sort: "UNANSWERED", search: "" });
  assertTrue(recent.length > 0, "Expected chat threads for viewer");
  assertTrue(nearby.length > 0 && unread.length > 0 && unanswered.length > 0, "Expected all sort variants to return");

  const probeName = recent[0].name;
  const searchHit = await chatService.listThreads(viewerId, { sort: "RECENT", search: probeName.slice(0, 3) });
  assertTrue(searchHit.some((t) => t.name === probeName), "Expected search to match probe thread");

  const onlineThreads = recent.filter((t) => t.isOnline);
  assertTrue(onlineThreads.length > 0, "Expected online chat threads for green activity dot");

  console.log(
    JSON.stringify(
      {
        success: true,
        viewer: phoneE164,
        totals: {
          friends: friends.length,
          onlineFriends: onlineFriends.length,
          threads: recent.length,
          onlineThreads: onlineThreads.length,
        },
        tested: ["messages-sort-recent", "messages-sort-nearby", "messages-sort-unread", "messages-sort-unanswered", "messages-search", "active-status-friends", "active-status-messages"],
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error("testChatListFlowsForViewerPhone failed:", error.message);
  process.exitCode = 1;
});
