const storyService = require("../services/story.service");
const { emitThreadMessageToParticipants } = require("../services/websocket.service");

async function presignUpload(req, res) {
  try {
    const userId = req.auth.userId;
    const data = await storyService.presignStoryUpload(userId);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || "Presign failed",
    });
  }
}

async function createStory(req, res) {
  try {
    const userId = req.auth.userId;
    const { mediaUrl, mediaType, audience } = req.body || {};
    const data = await storyService.createStoryFromUpload(userId, { mediaUrl, mediaType, audience });
    return res.status(200).json({ success: true, data });
  } catch (error) {
    const code = error.code || "STORY_CREATE_FAILED";
    const status =
      code === "STORY_MEDIA_REQUIRED"
        ? 400
        : code === "STORY_LIMIT_REACHED"
          ? 409
          : 500;
    return res.status(status).json({ success: false, code, message: error.message });
  }
}

async function listReel(req, res) {
  try {
    const userId = req.auth.userId;
    const data = await storyService.listStoryReelForViewer(userId);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to load story reel",
    });
  }
}

async function recordView(req, res) {
  try {
    const userId = req.auth.userId;
    const { storyId } = req.params;
    const data = await storyService.recordStoryView(userId, storyId);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    const status =
      error.code === "STORY_NOT_FOUND" || error.code === "STORY_EXPIRED" || error.code === "STORY_NOT_VISIBLE"
        ? 404
        : 500;
    return res.status(status).json({
      success: false,
      code: error.code || "STORY_VIEW_FAILED",
      message: error.message || "Failed to record view",
    });
  }
}

async function setLike(req, res) {
  try {
    const userId = req.auth.userId;
    const { storyId } = req.params;
    const wantLike = req.body?.liked !== false;
    const data = await storyService.toggleStoryLike(userId, storyId, wantLike);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    const status =
      error.code === "STORY_NOT_FOUND" || error.code === "STORY_EXPIRED" || error.code === "STORY_NOT_VISIBLE"
        ? 404
        : error.code === "STORY_SELF_ACTION"
          ? 400
          : 500;
    return res.status(status).json({
      success: false,
      code: error.code || "STORY_LIKE_FAILED",
      message: error.message || "Failed to update like",
    });
  }
}

async function postComment(req, res) {
  try {
    const userId = req.auth.userId;
    const { storyId } = req.params;
    const text = req.body?.text;
    await storyService.addStoryComment(userId, storyId, text);
    return res.status(200).json({ success: true, message: "Comment posted" });
  } catch (error) {
    const code = error.code || "STORY_COMMENT_FAILED";
    const status =
      code === "INSUFFICIENT_COMMENT_CREDITS"
        ? 409
        : code === "USE_STORY_REPLY_FOR_FRIEND"
          ? 400
          : code === "STORY_NOT_FOUND" || code === "STORY_NOT_VISIBLE" || code === "STORY_EXPIRED"
            ? 404
            : code === "INVALID_STORY_COMMENT"
              ? 400
              : 500;
    return res.status(status).json({
      success: false,
      code,
      message: error.message || "Failed to comment",
    });
  }
}

async function postReply(req, res) {
  try {
    const userId = req.auth.userId;
    const { storyId } = req.params;
    const text = req.body?.text;
    const data = await storyService.addStoryReplyToChat(userId, storyId, text);
    await emitThreadMessageToParticipants(data.threadId, data.messageId);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    const code = error.code || "STORY_REPLY_FAILED";
    const status =
      code === "CHAT_LOCKED_PAYWALL"
        ? 403
        : code === "STORY_NOT_FOUND" || code === "STORY_NOT_VISIBLE" || code === "STORY_EXPIRED"
          ? 404
          : code === "STORY_REPLY_NOT_FRIEND" || code === "INVALID_STORY_REPLY" || code === "STORY_SELF_ACTION"
            ? 400
            : code === "CHAT_UNAVAILABLE" || code === "NOT_FRIENDS"
              ? 403
              : 500;
    return res.status(status).json({
      success: false,
      code,
      message: error.message || "Failed to send reply",
      data: code === "CHAT_LOCKED_PAYWALL" ? { unlocksAt: error.unlocksAt || null } : undefined,
    });
  }
}

async function getActivity(req, res) {
  try {
    const userId = req.auth.userId;
    const { storyId } = req.params;
    const data = await storyService.listStoryActivity(userId, storyId);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    const status = error.code === "STORY_NOT_FOUND" ? 404 : 500;
    return res.status(status).json({
      success: false,
      code: error.code || "STORY_ACTIVITY_FAILED",
      message: error.message || "Failed to load activity",
    });
  }
}

async function getViewerState(req, res) {
  try {
    const userId = req.auth.userId;
    const { storyId } = req.params;
    const data = await storyService.getViewerStoryState(userId, storyId);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    const status =
      error.code === "STORY_NOT_FOUND" || error.code === "STORY_EXPIRED" || error.code === "STORY_NOT_VISIBLE"
        ? 404
        : 500;
    return res.status(status).json({
      success: false,
      code: error.code || "STORY_STATE_FAILED",
      message: error.message || "Failed",
    });
  }
}

async function deleteStory(req, res) {
  try {
    const userId = req.auth.userId;
    const { storyId } = req.params;
    await storyService.softDeleteStory(userId, storyId);
    return res.status(200).json({ success: true, message: "Story deleted" });
  } catch (error) {
    const status = error.code === "STORY_NOT_FOUND" ? 404 : 500;
    return res.status(status).json({
      success: false,
      code: error.code || "STORY_DELETE_FAILED",
      message: error.message || "Failed to delete",
    });
  }
}

async function listMine(req, res) {
  try {
    const userId = req.auth.userId;
    const data = await storyService.listMyStories(userId);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return res.status(500).json({
      success: false,
      code: error.code || "STORY_MINE_FAILED",
      message: error.message || "Failed to load stories",
    });
  }
}

async function getMeSummary(req, res) {
  try {
    const userId = req.auth.userId;
    const data = await storyService.getMeStorySummary(userId);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return res.status(500).json({
      success: false,
      code: error.code || "STORY_SUMMARY_FAILED",
      message: error.message || "Failed",
    });
  }
}

async function markActivitySeen(req, res) {
  try {
    const userId = req.auth.userId;
    await storyService.markStoryActivitySeen(userId);
    return res.status(200).json({ success: true, message: "OK" });
  } catch (error) {
    return res.status(500).json({
      success: false,
      code: error.code || "STORY_MARK_SEEN_FAILED",
      message: error.message || "Failed",
    });
  }
}

async function markActivityProfileOpened(req, res) {
  try {
    const ownerId = req.auth.userId;
    const { storyId } = req.params;
    const actorUserId = String(req.body?.actorUserId || "").trim();
    if (!actorUserId) {
      return res.status(400).json({
        success: false,
        code: "ACTOR_REQUIRED",
        message: "actorUserId is required",
      });
    }
    await storyService.markStoryActivityProfileOpened(ownerId, storyId, actorUserId);
    return res.status(200).json({ success: true });
  } catch (error) {
    const code = error.code || "STORY_ACTIVITY_PROFILE_MARK_FAILED";
    const status =
      code === "STORY_NOT_FOUND" ? 404 : code === "ACTOR_REQUIRED" ? 400 : 500;
    return res.status(status).json({
      success: false,
      code,
      message: error.message || "Failed",
    });
  }
}

async function reportStory(req, res) {
  try {
    const userId = req.auth.userId;
    const { storyId } = req.params;
    const reason = req.body?.reason || "";
    const data = await storyService.reportStory(userId, storyId, reason);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    const code = error.code || "STORY_REPORT_FAILED";
    const status =
      code === "REPORT_REASON_REQUIRED" || code === "STORY_SELF_REPORT"
        ? 400
        : code === "STORY_NOT_FOUND" || code === "STORY_EXPIRED" || code === "STORY_NOT_VISIBLE"
          ? 404
          : 500;
    return res.status(status).json({
      success: false,
      code,
      message: error.message || "Failed to report",
    });
  }
}

module.exports = {
  presignUpload,
  createStory,
  listReel,
  listMine,
  getMeSummary,
  markActivitySeen,
  markActivityProfileOpened,
  recordView,
  setLike,
  postComment,
  postReply,
  getActivity,
  getViewerState,
  deleteStory,
  reportStory,
};
