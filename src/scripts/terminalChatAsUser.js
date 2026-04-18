require("dotenv").config();

const readline = require("readline");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { query } = require("../config/db");
const chatService = require("../services/chat.service");

const DEFAULT_TARGET_PHONE = "9354120990";
const POLL_MS = 1200;
const PAGE_LIMIT = 80;
const BACKEND_BASE_URL = process.env.BACKEND_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`;

function toE164(phone) {
  const digits = String(phone || "").replace(/[^\d]/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `+91${digits}`;
  if (digits.startsWith("91") && digits.length === 12) return `+${digits}`;
  if (digits.startsWith("+")) return digits;
  return `+${digits}`;
}

async function getUserByPhone(phoneInput) {
  const phoneE164 = toE164(phoneInput);
  const res = await query(
    `SELECT id, name, phone_e164
     FROM users
     WHERE phone_e164 = $1
       AND deleted_at IS NULL
     LIMIT 1`,
    [phoneE164]
  );
  return res.rows[0] || null;
}

async function listSenderCandidates(targetUserId) {
  const res = await query(
    `SELECT u.id, u.name, u.phone_e164
     FROM users u
     WHERE u.id <> $1
       AND u.deleted_at IS NULL
       AND EXISTS (
         SELECT 1
         FROM friendships f
         WHERE (f.u1_id = LEAST($1, u.id) AND f.u2_id = GREATEST($1, u.id))
       )
     ORDER BY COALESCE(u.last_active_at, u.created_at) DESC, u.created_at DESC
     LIMIT 40`,
    [targetUserId]
  );
  return res.rows;
}

function createReadline() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
}

function ask(rl, prompt) {
  return new Promise((resolve) => rl.question(prompt, (answer) => resolve(answer)));
}

function ts() {
  const d = new Date();
  return d.toTimeString().slice(0, 8);
}

async function createAccessTokenForUser(userId) {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) throw new Error("JWT_SECRET is required");
  const jwtId = crypto.randomUUID();
  const ttlSeconds = 60 * 60 * 24 * 7;
  const sessionRes = await query(
    `INSERT INTO user_sessions (user_id, jwt_id, expires_at)
     VALUES ($1, $2::uuid, NOW() + ($3 || ' seconds')::interval)
     RETURNING id, jwt_id`,
    [userId, jwtId, ttlSeconds]
  );
  const session = sessionRes.rows[0];
  return jwt.sign(
    {
      sub: userId,
      sid: session.id,
      jti: session.jwt_id,
      type: "access",
    },
    jwtSecret,
    { expiresIn: ttlSeconds }
  );
}

async function sendViaHttpAsUser(accessToken, threadId, text) {
  const response = await fetch(`${BACKEND_BASE_URL}/api/v1/chat/threads/${threadId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ text }),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || !json.success) {
    const error = new Error(json.message || `HTTP ${response.status}`);
    error.code = json.code || String(response.status);
    throw error;
  }
  return json.data || {};
}

async function chooseSender(rl, targetUserId, senderArg) {
  if (senderArg) {
    const byPhone = await query(
      `SELECT u.id, u.name, u.phone_e164
       FROM users u
       WHERE u.phone_e164 = $1
         AND u.deleted_at IS NULL
         AND EXISTS (
           SELECT 1
           FROM friendships f
           WHERE (f.u1_id = LEAST($2, u.id) AND f.u2_id = GREATEST($2, u.id))
         )
       LIMIT 1`,
      [toE164(senderArg), targetUserId]
    );
    if (byPhone.rows[0]) return byPhone.rows[0];
    const byName = await query(
      `SELECT u.id, u.name, u.phone_e164
       FROM users u
       WHERE LOWER(u.name) = LOWER($1)
         AND u.deleted_at IS NULL
         AND EXISTS (
           SELECT 1
           FROM friendships f
           WHERE (f.u1_id = LEAST($2, u.id) AND f.u2_id = GREATEST($2, u.id))
         )
       LIMIT 1`,
      [String(senderArg).trim(), targetUserId]
    );
    if (byName.rows[0]) return byName.rows[0];
    console.log(`No friend matched "${senderArg}". Showing selectable friends list instead.`);
  }

  const candidates = await listSenderCandidates(targetUserId);
  if (!candidates.length) {
    throw new Error("No sender candidates found. Seed friends first.");
  }
  console.log("\nChoose sender user:");
  candidates.forEach((u, idx) => {
    console.log(`  [${idx + 1}] ${u.name} (${u.phone_e164})`);
  });
  while (true) {
    const raw = await ask(rl, "\nEnter number: ");
    const n = Number.parseInt(String(raw || "").trim(), 10);
    if (Number.isFinite(n) && n >= 1 && n <= candidates.length) return candidates[n - 1];
    console.log("Invalid choice. Try again.");
  }
}

function formatLine(msg, senderId, senderName, targetName) {
  const who = msg.senderUserId === senderId ? senderName : targetName;
  return `[${ts()}] ${who}: ${msg.text}`;
}

async function main() {
  const targetPhone = process.argv[2] || DEFAULT_TARGET_PHONE;
  const senderArg = process.argv[3] || "";
  const target = await getUserByPhone(targetPhone);
  if (!target) throw new Error(`Target not found for ${toE164(targetPhone)}`);

  const rl = createReadline();
  let pollTimer = null;
  let busy = false;
  let stopped = false;
  const seen = new Set();

  try {
    const sender = await chooseSender(rl, target.id, senderArg);
    const open = await chatService.getOrCreateDirectThread(target.id, sender.id);
    const threadId = open.threadId;
    const senderAccessToken = await createAccessTokenForUser(sender.id);

    console.log("\n--- Terminal Chat Bridge ---");
    console.log(`Target (mobile app): ${target.name} (${target.phone_e164})`);
    console.log(`Sender (terminal):   ${sender.name} (${sender.phone_e164})`);
    console.log(`Thread ID: ${threadId}`);
    console.log("\nType message and press Enter to send as sender.");
    console.log("Commands: /exit, /help, /refresh\n");

    const printNew = async (forcePrintAll = false) => {
      if (busy || stopped) return;
      busy = true;
      try {
        const items = await chatService.listThreadMessages(sender.id, threadId, { limit: PAGE_LIMIT });
        for (const m of items) {
          if (!m.id) continue;
          const isNew = !seen.has(m.id);
          if (isNew || forcePrintAll) {
            if (isNew) seen.add(m.id);
            if (isNew || forcePrintAll) {
              console.log(formatLine(m, sender.id, sender.name, target.name));
            }
          }
        }
      } finally {
        busy = false;
      }
    };

    await printNew(true);

    pollTimer = setInterval(() => {
      printNew(false).catch((error) => {
        console.error(`[${ts()}] Poll error: ${error.message}`);
      });
    }, POLL_MS);

    rl.on("line", async (line) => {
      const text = String(line || "").trim();
      if (!text) return;
      if (text === "/help") {
        console.log("Commands: /exit, /help, /refresh");
        return;
      }
      if (text === "/refresh") {
        await printNew(false);
        return;
      }
      if (text === "/exit") {
        stopped = true;
        if (pollTimer) clearInterval(pollTimer);
        rl.close();
        return;
      }
      try {
        await sendViaHttpAsUser(senderAccessToken, threadId, text);
        await printNew(false);
      } catch (error) {
        console.error(`[${ts()}] Send failed: ${error.code || ""} ${error.message}`);
      }
    });

    await new Promise((resolve) => rl.on("close", resolve));
  } finally {
    stopped = true;
    if (pollTimer) clearInterval(pollTimer);
    rl.close();
  }
}

main().catch((error) => {
  console.error(`terminalChatAsUser failed: ${error.message}`);
  process.exitCode = 1;
});

