const fs = require("fs");
const admin = require("firebase-admin");

let initialized = false;

function initFirebaseAdmin() {
  if (initialized) return true;
  const serviceAccountPath = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "").trim();
  if (!serviceAccountPath) {
    console.warn("[firebase] FIREBASE_SERVICE_ACCOUNT_JSON not set; push notifications disabled");
    return false;
  }
  try {
    const raw = fs.readFileSync(serviceAccountPath, "utf8");
    const creds = JSON.parse(raw);
    admin.initializeApp({
      credential: admin.credential.cert(creds),
    });
    initialized = true;
    console.log("[firebase] Admin SDK initialized");
    return true;
  } catch (error) {
    console.error("[firebase] Failed to initialize:", error?.message || error);
    return false;
  }
}

function getPushHealth() {
  const serviceAccountPath = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "").trim();
  const firebaseServiceAccountConfigured = Boolean(serviceAccountPath);
  let firebaseAdminReady = false;
  if (firebaseServiceAccountConfigured) {
    firebaseAdminReady = Boolean(getMessaging());
  }
  return {
    firebaseServiceAccountConfigured,
    firebaseAdminReady,
    // APNs production key must be configured manually in Firebase Console (TestFlight).
    apnsProductionKeyConfigured: null,
  };
}

function getMessaging() {
  if (!initialized && !initFirebaseAdmin()) return null;
  return admin.messaging();
}

module.exports = {
  initFirebaseAdmin,
  getMessaging,
  getPushHealth,
};

