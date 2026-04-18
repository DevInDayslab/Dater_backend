const express = require("express");
const { requireAuth } = require("../middleware/auth.middleware");
const feedController = require("../controllers/feed.controller");

const router = express.Router();

router.get("/", requireAuth, feedController.getFeed);

module.exports = router;
