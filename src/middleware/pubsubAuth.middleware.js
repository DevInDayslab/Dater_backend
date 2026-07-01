function requirePubSubAuth(req, res, next) {
  const audience = String(process.env.GOOGLE_PLAY_RTDN_AUDIENCE || "").trim();
  if (!audience) {
  // Allow webhook in dev when audience is unset; production should always configure this.
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

  // Full OIDC JWT verification can be added with google-auth-library when production RTDN is wired.
  // For now we require the bearer token header and configured audience env in production.
  return next();
}

module.exports = {
  requirePubSubAuth,
};
