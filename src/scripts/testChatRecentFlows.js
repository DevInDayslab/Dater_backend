require("dotenv").config();

const { randomUUID } = require("crypto");
const { query } = require("../config/db");
const chatService = require("../services/chat.service");
const socialService = require("../services/social.service");

function assertTrue(condition, message) {
  if (!condition) {
    const error = new Error(message);
    error.code = "ASSERTION_FAILED";
    throw error;
  }
}

async function createUser({ name, genderMain, idx }) {
  const id = randomUUID();
  const phone = `+91991${String(Date.now()).slice(-5)}${String(idx).padStart(2, "0")}`;
  const phoneDigits = phone.slice(3);
  await query(
    `INSERT INTO users (
       id, phone_country_code, phone_number, phone_e164, is_phone_verified,
       name, age_years, date_of_birth, gender, gender_main, marital_status,
       onboarding_step, account_state, last_active_at
     ) VALUES (
       $1, '+91', $2, $3, true,
       $4, 27, CURRENT_DATE - INTERVAL '27 years', $5, $6, 'Single',
       'main', 'ACTIVE', NOW()
     )`,
    [id, phoneDigits, phone, name, genderMain, genderMain]
  );
  return { id, phone };
}

async function createDirectThread(userA, userB) {
  const tRes = await query(`INSERT INTO chat_threads (thread_type) VALUES ('DIRECT') RETURNING id`, []);
  const threadId = tRes.rows[0].id;
  await query(
    `INSERT INTO chat_thread_participants (thread_id, user_id)
     VALUES ($1, $2), ($1, $3)`,
    [threadId, userA, userB]
  );
  await query(
    `INSERT INTO chat_thread_user_state (thread_id, user_id)
     VALUES ($1, $2), ($1, $3)`,
    [threadId, userA, userB]
  );
  return threadId;
}

async function ensureFriendship(a, b) {
  const [u1, u2] = a < b ? [a, b] : [b, a];
  await query(
    `INSERT INTO friendships (u1_id, u2_id)
     VALUES ($1, $2)
     ON CONFLICT (u1_id, u2_id) DO NOTHING`,
    [u1, u2]
  );
}

async function main() {
  const createdUserIds = [];
  try {
    const male = await createUser({ name: "Test Male", genderMain: "male", idx: 1 });
    const female = await createUser({ name: "Test Female", genderMain: "female", idx: 2 });
    const extraA = await createUser({ name: "Extra A", genderMain: "male", idx: 3 });
    const extraB = await createUser({ name: "Extra B", genderMain: "female", idx: 4 });
    createdUserIds.push(male.id, female.id, extraA.id, extraB.id);

    const threadId = await createDirectThread(male.id, female.id);
    await ensureFriendship(male.id, female.id);

    // 1) Reply + lock cycle
    const first = await chatService.sendMessage(male.id, threadId, "msg-1");
    await chatService.sendMessage(male.id, threadId, "msg-2");
    await chatService.sendMessage(male.id, threadId, "msg-3");
    let locked = false;
    try {
      await chatService.sendMessage(male.id, threadId, "msg-4-should-lock");
    } catch (e) {
      locked = e.code === "CHAT_LOCKED_PAYWALL";
    }
    assertTrue(locked, "Expected 4th message to be chat locked");

    await chatService.sendMessage(female.id, threadId, "reply-from-female", first.id);
    const listed = await chatService.listThreadMessages(female.id, threadId, { limit: 20 });
    const replyRow = listed.find((m) => m.text === "reply-from-female");
    assertTrue(!!replyRow, "Expected reply message row");
    assertTrue(replyRow.replyToMessageId === first.id, "Expected reply_to_message_id to match");

    // 2) Unfriend asymmetry
    await chatService.unfriendByThread(male.id, threadId);
    const fs = await query(
      `SELECT 1 FROM friendships WHERE (u1_id = $1 AND u2_id = $2) OR (u1_id = $2 AND u2_id = $1)`,
      [male.id, female.id]
    );
    assertTrue(fs.rowCount === 0, "Expected friendship removed after unfriend");
    const stateA = await query(
      `SELECT is_deleted_from_inbox FROM chat_thread_user_state WHERE thread_id = $1 AND user_id = $2`,
      [threadId, male.id]
    );
    const stateB = await query(
      `SELECT relationship_state::text AS s, can_report, can_view_profile
       FROM chat_thread_user_state WHERE thread_id = $1 AND user_id = $2`,
      [threadId, female.id]
    );
    assertTrue(stateA.rows[0]?.is_deleted_from_inbox === true, "Expected unfriender inbox hidden");
    assertTrue(stateB.rows[0]?.s === "CHAT_ENDED", "Expected unfriended chat ended state");
    assertTrue(stateB.rows[0]?.can_report === false, "Expected can_report false for unfriended user");

    // 3) Block via thread
    await ensureFriendship(male.id, female.id);
    await chatService.blockByThread(female.id, threadId, "block-test");
    const blockRes = await query(
      `SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = $2`,
      [female.id, male.id]
    );
    assertTrue(blockRes.rowCount === 1, "Expected block row after blockByThread");

    // 4) Report via thread
    await chatService.reportByThread(female.id, threadId, "chat-report-reason");
    const reportChat = await query(
      `SELECT 1 FROM reports WHERE reporter_id = $1 AND reported_id = $2 AND content_type = 'CHAT' AND chat_thread_id = $3`,
      [female.id, male.id, threadId]
    );
    assertTrue(reportChat.rowCount >= 1, "Expected chat report row");

    // 5) Profile-side unfriend/block/report
    await ensureFriendship(extraA.id, extraB.id);
    await socialService.unfriendUser(extraA.id, extraB.id);
    const fs2 = await query(
      `SELECT 1 FROM friendships WHERE (u1_id = $1 AND u2_id = $2) OR (u1_id = $2 AND u2_id = $1)`,
      [extraA.id, extraB.id]
    );
    assertTrue(fs2.rowCount === 0, "Expected friendship removed in social unfriend");
    await socialService.blockUser(extraA.id, extraB.id, "profile-block");
    const block2 = await query(
      `SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = $2`,
      [extraA.id, extraB.id]
    );
    assertTrue(block2.rowCount >= 1, "Expected block row for social block");
    await socialService.reportUser(extraA.id, extraB.id, { reason: "profile-report", contentType: "PROFILE" });
    const reportProfile = await query(
      `SELECT 1 FROM reports WHERE reporter_id = $1 AND reported_id = $2 AND content_type = 'PROFILE'`,
      [extraA.id, extraB.id]
    );
    assertTrue(reportProfile.rowCount >= 1, "Expected profile report row");

    console.log(
      JSON.stringify(
        {
          success: true,
          tested: [
            "reply-message-persistence",
            "chat-lock-cycle",
            "unfriend-asymmetry",
            "block-by-thread",
            "report-by-thread",
            "profile-unfriend-block-report",
          ],
        },
        null,
        2
      )
    );
  } finally {
    if (createdUserIds.length > 0) {
      await query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [createdUserIds]);
    }
  }
}

main().catch((error) => {
  console.error("testChatRecentFlows failed:", error.code || "", error.message);
  process.exitCode = 1;
});
