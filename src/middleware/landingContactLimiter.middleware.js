const rateLimit = require("express-rate-limit");

const landingContactLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({
      error: "Too many requests. Please try again tomorrow.",
    });
  },
});

module.exports = { landingContactLimiter };
