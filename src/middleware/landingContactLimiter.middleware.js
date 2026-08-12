const rateLimit = require("express-rate-limit");

const RATE_LIMIT_MESSAGE = "Too many requests. Please try again tomorrow.";
const COOLDOWN_MESSAGE = "Please wait a minute before submitting another request.";

function buildLimiter({ windowMs, max, message }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({
        success: false,
        error: message,
        message,
      });
    },
  });
}

const landingContactBurstLimiter = buildLimiter({
  windowMs: 60 * 1000,
  max: 1,
  message: COOLDOWN_MESSAGE,
});

const landingContactDailyLimiter = buildLimiter({
  windowMs: 24 * 60 * 60 * 1000,
  max: 3,
  message: RATE_LIMIT_MESSAGE,
});

const landingContactPresignLimiter = buildLimiter({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: RATE_LIMIT_MESSAGE,
});

module.exports = {
  landingContactBurstLimiter,
  landingContactDailyLimiter,
  landingContactPresignLimiter,
};
