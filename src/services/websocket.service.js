const { Server } = require("socket.io");
const { query } = require("../config/db");
const { authenticateAccessToken } = require("../middleware/auth.middleware");
const chatService = require("./chat.service");
const s3Media = require("./s3Media.service");
let ioRef = null;
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function resolveTokenFromHandshake(socket) {
  const headerAuth = String(socket.handshake?.headers?.authorization || "");
  const bearer = headerAuth.startsWith("Bearer ") ? headerAuth.slice(7).trim() : "";
  if (bearer) return bearer;
  const authToken = String(socket.handshake?.auth?.token || "").trim();
  return authToken;
}

async function loadMessagePayloadForUser(userId, threadId, messageId) {
  const rowRes = await query(
    `SELECT m.id,
            m.thread_id,
            m.sender_user_id,
            m.message_text,
            m.message_type::text AS message_type,
            m.referenced_story_id,
            m.created_at,
            COALESCE(m.reply_to_message_id::text, '') AS reply_to_message_id,
            COALESCE(r.sender_user_id::text, '') AS reply_sender_user_id,
            COALESCE(r.message_text, '') AS reply_message_text,
            COALESCE(st.user_id::text, '') AS referenced_story_owner_id,
            st.media_url AS referenced_story_media_url
     FROM chat_messages m
     LEFT JOIN chat_messages r ON r.id = m.reply_to_message_id
     LEFT JOIN stories st ON st.id = m.referenced_story_id
     WHERE m.id = $1
       AND m.thread_id = $2
       AND m.deleted_at IS NULL
     LIMIT 1`,
    [messageId, threadId]
  );
  const row = rowRes.rows[0];
  if (!row) return null;
  const storyPreviewUrl = await s3Media.presignReadIfOurS3Object(row.referenced_story_media_url || "");
  return {
    id: row.id,
    threadId: row.thread_id,
    senderUserId: row.sender_user_id || "",
    text: row.message_text || "",
    messageType: row.message_type || "TEXT",
    storyId: row.referenced_story_id || "",
    storyOwnerUserId: row.referenced_story_owner_id || "",
    storyPreviewUrl,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    isFromMe: (row.sender_user_id || "") === userId,
    replyToMessageId: row.reply_to_message_id || "",
    replySenderUserId: row.reply_sender_user_id || "",
    replyMessageText: row.reply_message_text || "",
  };
}

async function getThreadParticipantIds(threadId) {
  const pRes = await query(
    `SELECT user_id
     FROM chat_thread_participants
     WHERE thread_id = $1`,
    [threadId]
  );
  return pRes.rows.map((r) => String(r.user_id || "").trim()).filter(Boolean);
}

async function emitThreadMessageToParticipants(threadId, messageId) {
  if (!ioRef) return false;
  const tid = String(threadId || "").trim();
  const mid = String(messageId || "").trim();
  if (!tid || !mid) return false;
  const participants = await getThreadParticipantIds(tid);
  for (const uid of participants) {
    const msg = await loadMessagePayloadForUser(uid, tid, mid);
    if (!msg) continue;
    ioRef.to(`user:${uid}`).emit("receive_message", msg);
  }
  return true;
}

function initWebsocket(server) {
  const io = new Server(server, {
    cors: { origin: "*" },
    path: "/socket.io",
    pingTimeout: 60000,
    pingInterval: 25000,
  });

  io.use(async (socket, next) => {
    try {
      const token = resolveTokenFromHandshake(socket);
      const auth = await authenticateAccessToken(token);
      socket.data.auth = auth;
      socket.join(`user:${auth.userId}`);
      next();
    } catch (error) {
      next(new Error(error.message || "Unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    const viewerId = socket.data?.auth?.userId;
    if (!viewerId) {
      socket.disconnect(true);
      return;
    }
    socket.join(`user:${viewerId}`);
    console.log(`✅ Socket joined room: user:${viewerId} socketId=${socket.id}`);
    console.log(`New socket connected, userId: ${viewerId}`);

    socket.on("send_message", async (payload = {}, ack) => {
      const done = typeof ack === "function" ? ack : () => {};
      try {
        const threadId = String(payload.threadId || "").trim();
        const text = String(payload.text || "");
        let replyToMessageId = String(payload.replyToMessageId || "").trim();
        if (!UUID_REGEX.test(replyToMessageId)) {
          replyToMessageId = "";
        }
        console.log(
          `[ws.send_message] user=${viewerId} thread=${threadId} replyTo=${replyToMessageId || "<none>"} rawReply=${String(
            payload.replyToMessageId ?? ""
          )}`
        );
        if (!threadId) {
          done({ success: false, code: "THREAD_NOT_FOUND", message: "Thread not found" });
          return;
        }
        let result;
        try {
          result = await chatService.sendMessage(viewerId, threadId, text, replyToMessageId);
        } catch (error) {
          // Last-mile guard: if any UUID parse slips through, retry without reply target.
          if (error?.code === "22P02" || /invalid input syntax for type uuid/i.test(String(error?.message || ""))) {
            console.warn(
              `[ws.send_message] uuid parse failure, retrying without replyTo. user=${viewerId} thread=${threadId}`
            );
            result = await chatService.sendMessage(viewerId, threadId, text, "");
          } else {
            throw error;
          }
        }
        await emitThreadMessageToParticipants(threadId, result.id);
        done({
          success: true,
          message: {
            id: result.id,
            createdAt: result.createdAt,
            threadId,
          },
          data: { id: result.id, createdAt: result.createdAt },
        });
      } catch (error) {
        if (error.code === "CHAT_LOCKED_PAYWALL") {
          socket.emit("chat_locked_paywall", {
            threadId: String(payload.threadId || "").trim(),
            unlocksAt: error.unlocksAt || null,
          });
          done({
            success: false,
            code: "CHAT_LOCKED_PAYWALL",
            message: error.message || "Chat is temporarily locked",
            data: { unlocksAt: error.unlocksAt || null },
          });
          return;
        }
        done({
          success: false,
          code: error.code || "CHAT_SEND_FAILED",
          message: error.message || "Could not send message",
        });
      }
    });
  });
  ioRef = io;
  return io;
}

module.exports = {
  initWebsocket,
  emitThreadMessageToParticipants,
};

