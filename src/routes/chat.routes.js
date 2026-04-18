const express = require("express");
const { requireAuth } = require("../middleware/auth.middleware");
const chatController = require("../controllers/chat.controller");

const router = express.Router();

router.get("/threads", requireAuth, chatController.listThreads);
router.post("/threads/with-user/:userId", requireAuth, chatController.openThreadWithUser);
router.get("/threads/:threadId/messages", requireAuth, chatController.listThreadMessages);
router.post("/threads/:threadId/messages", requireAuth, chatController.sendMessage);
router.post("/threads/:threadId/unlock-local", requireAuth, chatController.unlockThreadLocally);
router.post("/threads/:threadId/read", requireAuth, chatController.markThreadRead);
router.post("/threads/:threadId/mute", requireAuth, chatController.setThreadMuted);
router.post("/threads/:threadId/delete", requireAuth, chatController.deleteThreadFromInbox);
router.post("/threads/:threadId/unfriend", requireAuth, chatController.unfriendThread);
router.post("/threads/:threadId/block", requireAuth, chatController.blockThread);
router.post("/threads/:threadId/report", requireAuth, chatController.reportThread);

module.exports = router;
