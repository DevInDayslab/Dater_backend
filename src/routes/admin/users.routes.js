const express = require("express");
const adminUsersController = require("../../controllers/admin/adminUsers.controller");

const router = express.Router();

router.get("/", adminUsersController.listUsers);

router.get("/:userId/profile", adminUsersController.getProfile);
router.get("/:userId/photos", adminUsersController.getPhotos);
router.get("/:userId/filters", adminUsersController.getFilters);
router.get("/:userId/verification", adminUsersController.getVerification);
router.get("/:userId/trust", adminUsersController.getTrust);
router.get("/:userId/content", adminUsersController.getContent);
router.get("/:userId/chat", adminUsersController.getChatThreads);
router.get("/:userId/chat/:threadId", adminUsersController.getChatMessages);
router.get("/:userId/social", adminUsersController.getSocial);
router.get("/:userId/revenue", adminUsersController.getRevenue);

module.exports = router;
