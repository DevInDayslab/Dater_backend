const chatService = require("../services/chat.service");
const { emitThreadMessageToParticipants, emitUnreadCountsUpdated } = require("../services/websocket.service");

async function listThreads(req, res) {
  try {
    const viewerId = req.auth.userId;
    const items = await chatService.listThreads(viewerId, {
      sort: req.query.sort,
      search: req.query.search,
    });
    return res.status(200).json({ success: true, data: { items } });
  } catch (error) {
    return res.status(500).json({
      success: false,
      code: error.code || "CHAT_THREADS_LIST_FAILED",
      message: error.message || "Failed to load chat threads",
    });
  }
}

async function listThreadMessages(req, res) {
  try {
    const viewerId = req.auth.userId;
    const threadId = req.params.threadId;
    const items = await chatService.listThreadMessages(viewerId, threadId, {
      limit: req.query.limit,
      before: req.query.before,
    });
    return res.status(200).json({ success: true, data: { items } });
  } catch (error) {
    const status = error.code === "THREAD_NOT_FOUND" ? 404 : 500;
    return res.status(status).json({
      success: false,
      code: error.code || "CHAT_MESSAGES_LIST_FAILED",
      message: error.message || "Failed to load messages",
    });
  }
}

async function sendMessage(req, res) {
  try {
    const viewerId = req.auth.userId;
    const threadId = req.params.threadId;
    const result = await chatService.sendMessage(
      viewerId,
      threadId,
      req.body?.text,
      req.body?.replyToMessageId
    );
    await emitThreadMessageToParticipants(threadId, result.id);
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    const status =
      error.code === "THREAD_NOT_FOUND"
        ? 404
        : error.code === "MESSAGE_TEXT_REQUIRED"
          ? 400
          : error.code === "CHAT_UNAVAILABLE" || error.code === "NOT_FRIENDS"
            ? 403
          : error.code === "CHAT_LOCKED_PAYWALL"
            ? 403
            : 500;
    return res.status(status).json({
      success: false,
      code: error.code || "CHAT_SEND_FAILED",
      message: error.message || "Could not send message",
      data:
        error.code === "CHAT_LOCKED_PAYWALL"
          ? { unlocksAt: error.unlocksAt || null }
          : undefined,
    });
  }
}

async function getThreadLockStatus(req, res) {
  try {
    const viewerId = req.auth.userId;
    const threadId = req.params.threadId;
    const lock = await chatService.evaluateChatLock({ threadId, senderId: viewerId });
    return res.status(200).json({
      success: true,
      data: {
        isLocked: lock.isLocked === true,
        unlocksAt: lock.unlocksAt || null,
        reason: lock.reason || "",
      },
    });
  } catch (error) {
    const status =
      error.code === "THREAD_PEER_NOT_FOUND" || error.code === "THREAD_NOT_FOUND" ? 404 : 500;
    return res.status(status).json({
      success: false,
      code: error.code || "CHAT_LOCK_STATUS_FAILED",
      message: error.message || "Could not load chat lock status",
    });
  }
}

async function unlockThreadLocally(req, res) {
  if (process.env.NODE_ENV === "production") {
    return res.status(403).json({
      success: false,
      code: "CHAT_UNLOCK_LOCAL_DISABLED",
      message: "Use chat unlock purchase instead",
    });
  }
  try {
    const viewerId = req.auth.userId;
    const threadId = req.params.threadId;
    await chatService.unlockThreadLocally(viewerId, threadId);
    return res.status(200).json({ success: true });
  } catch (error) {
    const status = error.code === "THREAD_NOT_FOUND" ? 404 : 500;
    return res.status(status).json({
      success: false,
      code: error.code || "CHAT_UNLOCK_LOCAL_FAILED",
      message: error.message || "Could not unlock chat",
    });
  }
}

async function markThreadRead(req, res) {
  try {
    const viewerId = req.auth.userId;
    const threadId = req.params.threadId;
    await chatService.markThreadRead(viewerId, threadId);
    emitUnreadCountsUpdated(viewerId).catch(() => {});
    return res.status(200).json({ success: true });
  } catch (error) {
    const status = error.code === "THREAD_NOT_FOUND" ? 404 : 500;
    return res.status(status).json({
      success: false,
      code: error.code || "CHAT_MARK_READ_FAILED",
      message: error.message || "Could not mark read",
    });
  }
}

async function setThreadMuted(req, res) {
  try {
    const viewerId = req.auth.userId;
    const threadId = req.params.threadId;
    await chatService.setThreadMuted(viewerId, threadId, req.body?.muted === true);
    return res.status(200).json({ success: true });
  } catch (error) {
    const status = error.code === "THREAD_NOT_FOUND" ? 404 : 500;
    return res.status(status).json({
      success: false,
      code: error.code || "CHAT_SET_MUTED_FAILED",
      message: error.message || "Could not update mute state",
    });
  }
}

async function deleteThreadFromInbox(req, res) {
  try {
    const viewerId = req.auth.userId;
    const threadId = req.params.threadId;
    await chatService.deleteThreadFromInbox(viewerId, threadId);
    emitUnreadCountsUpdated(viewerId).catch(() => {});
    return res.status(200).json({ success: true, message: "Thread deleted" });
  } catch (error) {
    const status = error.code === "THREAD_NOT_FOUND" ? 404 : 500;
    return res.status(status).json({
      success: false,
      code: error.code || "CHAT_DELETE_FAILED",
      message: error.message || "Could not delete thread",
    });
  }
}

async function unfriendThread(req, res) {
  try {
    const viewerId = req.auth.userId;
    const threadId = req.params.threadId;
    await chatService.unfriendByThread(viewerId, threadId);
    return res.status(200).json({ success: true, message: "Unfriended" });
  } catch (error) {
    const status = error.code === "THREAD_NOT_FOUND" ? 404 : 500;
    return res.status(status).json({
      success: false,
      code: error.code || "CHAT_UNFRIEND_FAILED",
      message: error.message || "Could not unfriend",
    });
  }
}

async function blockThread(req, res) {
  try {
    const viewerId = req.auth.userId;
    const threadId = req.params.threadId;
    await chatService.blockByThread(viewerId, threadId, req.body?.reason || "");
    return res.status(200).json({ success: true, message: "Blocked" });
  } catch (error) {
    const status = error.code === "THREAD_NOT_FOUND" ? 404 : 500;
    return res.status(status).json({
      success: false,
      code: error.code || "CHAT_BLOCK_FAILED",
      message: error.message || "Could not block user",
    });
  }
}

async function reportThread(req, res) {
  try {
    const viewerId = req.auth.userId;
    const threadId = req.params.threadId;
    const data = await chatService.reportByThread(viewerId, threadId, req.body?.reason || "");
    return res.status(200).json({ success: true, message: "Reported", data });
  } catch (error) {
    const status =
      error.code === "THREAD_NOT_FOUND" || error.code === "REPORT_REASON_REQUIRED" ? 400 : 500;
    return res.status(status).json({
      success: false,
      code: error.code || "CHAT_REPORT_FAILED",
      message: error.message || "Could not report user",
    });
  }
}

async function openThreadWithUser(req, res) {
  try {
    const viewerId = req.auth.userId;
    const targetUserId = req.params.userId;
    const data = await chatService.getOrCreateDirectThread(viewerId, targetUserId);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    const status =
      error.code === "INVALID_TARGET_USER"
        ? 400
        : error.code === "CHAT_UNAVAILABLE" || error.code === "NOT_FRIENDS"
          ? 403
        : error.code === "TARGET_USER_NOT_FOUND"
          ? 404
          : 500;
    return res.status(status).json({
      success: false,
      code: error.code || "CHAT_OPEN_WITH_USER_FAILED",
      message: error.message || "Could not open chat",
    });
  }
}

module.exports = {
  listThreads,
  listThreadMessages,
  sendMessage,
  getThreadLockStatus,
  unlockThreadLocally,
  markThreadRead,
  setThreadMuted,
  deleteThreadFromInbox,
  unfriendThread,
  blockThread,
  reportThread,
  openThreadWithUser,
};
