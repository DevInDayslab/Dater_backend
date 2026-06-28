const express = require("express");
const cors = require("cors");
const helmet = require("helmet");

const authRoutes = require("./routes/auth.routes");
const { requireAuth } = require("./middleware/auth.middleware");
const storyController = require("./controllers/story.controller");
const usersRoutes = require("./routes/users.routes");
const entitlementsRoutes = require("./routes/entitlements.routes");
const feedRoutes = require("./routes/feed.routes");
const chatRoutes = require("./routes/chat.routes");
const storyRoutes = require("./routes/story.routes");
const adminRoutes = require("./routes/admin/index");

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json());

app.get("/health", (req, res) => {
  res.status(200).json({ status: "API is running fast" });
});

// Mirrors GET /api/v1/stories/notification-peer/:peerUserId under /users/me/notifications for restrictive gateways.
app.get(
  "/api/v1/users/me/notifications/story-reel/:peerUserId",
  requireAuth,
  storyController.listNotificationPeerReel
);

app.use("/api/v1/auth", authRoutes);
app.use("/api/v1/users", usersRoutes);
app.use("/api/v1/entitlements", entitlementsRoutes);
app.use("/api/v1/feed", feedRoutes);
app.use("/api/v1/chat", chatRoutes);
app.use("/api/v1/stories", storyRoutes);
app.use("/api/v1/admin", adminRoutes);

module.exports = app;
