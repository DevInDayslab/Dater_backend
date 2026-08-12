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
const configRoutes = require("./routes/config.routes");
const billingRoutes = require("./routes/billing.routes");
const paymentsRoutes = require("./routes/payments.routes");
const adminRoutes = require("./routes/admin/index");
const landingRoutes = require("./routes/landing.routes");
const {
  serveLandingWithDynamicSeo,
  resolveLandingDistPath,
} = require("./modules/seo/seo.middleware");

const app = express();

app.set("trust proxy", 1);

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "default-src": ["'self'"],
        "script-src": ["'self'"],
        "style-src": ["'self'", "https://fonts.googleapis.com", "'unsafe-inline'"],
        "font-src": ["'self'", "https://fonts.gstatic.com", "data:"],
        "img-src": ["'self'", "data:", "https:", "http:", "blob:"],
        "connect-src": ["'self'", "https:", "http:", "wss:", "ws:"],
        "frame-src": ["'self'"],
        "media-src": ["'self'", "https:", "http:", "blob:"],
      },
    },
  })
);
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
app.use("/api/v1/config", configRoutes);
app.use("/api/v1/billing", billingRoutes);
app.use("/api/v1/payments", paymentsRoutes);
app.use("/api/v1/admin", adminRoutes);
app.use("/api/v1/landing", landingRoutes);

const landingDistPath = resolveLandingDistPath();
app.use(express.static(landingDistPath, { index: false, fallthrough: true }));

app.get(/^\/(?!api(?:\/|$)|health(?:\/|$)).*/, serveLandingWithDynamicSeo);

app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }
  console.error("Unhandled Express error:", err);
  return res.status(500).json({
    success: false,
    message: "Internal server error",
    error: err.message,
  });
});

module.exports = app;
