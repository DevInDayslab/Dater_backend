const express = require("express");
const usersController = require("../controllers/users.controller");
const photosController = require("../controllers/photos.controller");
const { requireAuth } = require("../middleware/auth.middleware");

const router = express.Router();

router.get("/me", requireAuth, usersController.getMe);
router.post("/me/moderation-warning-ack", requireAuth, usersController.ackModerationWarning);
router.patch("/me/account-settings", requireAuth, usersController.patchAccountSettings);
router.get("/me/notification-preferences", requireAuth, usersController.getNotificationPreferences);
router.patch("/me/notification-preferences", requireAuth, usersController.patchNotificationPreferences);
router.post("/me/push-tokens", requireAuth, usersController.registerPushToken);
router.post("/me/delete-account", requireAuth, usersController.deleteAccount);
router.post("/me/heartbeat", requireAuth, usersController.pingHeartbeat);
router.get("/me/cities", requireAuth, usersController.listIndianCities);
router.get("/me/filters", requireAuth, usersController.getMyFilters);
router.get("/profiles/:userId", requireAuth, usersController.getPublicProfile);
router.patch("/me/onboarding-step", requireAuth, usersController.updateOnboardingStep);
router.patch("/me/profile-core", requireAuth, usersController.updateProfileCore);
router.patch("/me/onboarding-data", requireAuth, usersController.updateOnboardingData);
router.patch("/me/filters", requireAuth, usersController.updateMyFilters);
router.post("/me/reverse-geocode", requireAuth, usersController.reverseGeocodeLocation);
router.post("/me/interactions/request", requireAuth, usersController.sendFriendRequest);
router.post("/me/interactions/comment-request", requireAuth, usersController.sendCommentRequest);
router.post("/me/interactions/ignore", requireAuth, usersController.ignoreProfile);
router.post("/:userId/unfriend", requireAuth, usersController.unfriendUser);
router.post("/:userId/block", requireAuth, usersController.blockUser);
router.post("/:userId/report", requireAuth, usersController.reportUser);
router.get("/me/notifications/friend-requests", requireAuth, usersController.listIncomingFriendRequests);
router.get("/me/friends", requireAuth, usersController.listFriends);
router.post(
  "/me/interactions/requests/:fromUserId/undo-ignore",
  requireAuth,
  usersController.undoIncomingFriendRequestIgnore
);
router.post("/me/interactions/requests/:fromUserId/respond", requireAuth, usersController.respondToRequest);

router.post("/me/verify-liveness/session", requireAuth, usersController.createVerifyLivenessSession);
router.post("/me/verify-liveness/preview", requireAuth, usersController.previewVerifyLiveness);
router.post("/me/verify-liveness/complete", requireAuth, usersController.completeVerifyLiveness);

router.post("/me/photos/presign", requireAuth, photosController.presignPhotoUpload);
router.post("/me/photos/:photoId/confirm", requireAuth, photosController.confirmPhotoUpload);
router.post("/me/photos/delete", requireAuth, photosController.deletePhotoByOrder);

module.exports = router;
