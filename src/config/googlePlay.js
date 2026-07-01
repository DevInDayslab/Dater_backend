const { google } = require("googleapis");

let androidPublisherClient = null;

function parseServiceAccountJson() {
  const raw = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
  if (!raw || !String(raw).trim()) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getPackageName() {
  return String(process.env.GOOGLE_PLAY_PACKAGE_NAME || "com.daterplat.app").trim();
}

function isPlayBillingConfigured() {
  return Boolean(parseServiceAccountJson());
}

function getAndroidPublisher() {
  if (androidPublisherClient) {
    return androidPublisherClient;
  }
  const credentials = parseServiceAccountJson();
  if (!credentials) {
    const err = new Error("Google Play service account is not configured");
    err.code = "PLAY_NOT_CONFIGURED";
    throw err;
  }
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/androidpublisher"],
  });
  androidPublisherClient = google.androidpublisher({
    version: "v3",
    auth,
  });
  return androidPublisherClient;
}

module.exports = {
  getAndroidPublisher,
  getPackageName,
  isPlayBillingConfigured,
  parseServiceAccountJson,
};
