const express = require("express");
const { requireAuth } = require("../middleware/auth.middleware");
const storyController = require("../controllers/story.controller");

const router = express.Router();

router.post("/presign-upload", requireAuth, storyController.presignUpload);
router.post("/", requireAuth, storyController.createStory);
router.get("/reel", requireAuth, storyController.listReel);
router.get("/mine", requireAuth, storyController.listMine);
router.get("/me/summary", requireAuth, storyController.getMeSummary);
router.post("/me/mark-activity-seen", requireAuth, storyController.markActivitySeen);
router.post("/:storyId/view", requireAuth, storyController.recordView);
router.post("/:storyId/like", requireAuth, storyController.setLike);
router.post("/:storyId/comment", requireAuth, storyController.postComment);
router.post("/:storyId/reply", requireAuth, storyController.postReply);
router.post("/:storyId/report", requireAuth, storyController.reportStory);
router.post("/:storyId/activity/profile-opened", requireAuth, storyController.markActivityProfileOpened);
router.get("/:storyId/activity", requireAuth, storyController.getActivity);
router.get("/:storyId/viewer-state", requireAuth, storyController.getViewerState);
router.delete("/:storyId", requireAuth, storyController.deleteStory);

module.exports = router;
