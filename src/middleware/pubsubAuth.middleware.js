const { OAuth2Client } = require("google-auth-library");

const authClient = new OAuth2Client();

async function requirePubSubAuth(req, res, next) {
  const audience = String(process.env.GOOGLE_PLAY_RTDN_AUDIENCE || "").trim();
  if (!audience) {
    if (process.env.NODE_ENV === "production") {
      return res.status(503).json({
        success: false,
        code: "RTDN_NOT_CONFIGURED",
        message: "RTDN audience is not configured",
      });
    }
    return next();
  }

  const authHeader = String(req.headers.authorization || "");
  if (!authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      success: false,
      code: "UNAUTHORIZED",
      message: "Missing Pub/Sub authorization token",
    });
  }

  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) {
    return res.status(401).json({
      success: false,
      code: "UNAUTHORIZED",
      message: "Missing Pub/Sub authorization token",
    });
  }

  try {
    const ticket = await authClient.verifyIdToken({
      idToken: token,
      audience,
    });
    const payload = ticket.getPayload() || {};
    const email = String(payload.email || "");
    if (email && !email.endsWith("@gserviceaccount.com")) {
      return res.status(403).json({
        success: false,
        code: "FORBIDDEN",
        message: "Invalid Pub/Sub token issuer",
      });
    }
    req.pubsubAuth = payload;
    return next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      code: "UNAUTHORIZED",
      message: "Invalid Pub/Sub authorization token",
      error: error.message,
    });
  }
}

module.exports = {
  requirePubSubAuth,
};
