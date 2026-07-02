const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

let androidPublisherClient = null;

function parseJsonCredentials(raw) {
  if (!raw || !String(raw).trim()) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function loadCredentialsFromFile(filePath) {
  const resolved = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolved)) {
    return null;
  }
  return parseJsonCredentials(fs.readFileSync(resolved, "utf8"));
}

function parseServiceAccountJson() {
  const filePath = String(process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_PATH || "").trim();
  if (filePath) {
    const fromFile = loadCredentialsFromFile(filePath);
    if (fromFile) return fromFile;
  }

  const raw = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
  const fromEnv = parseJsonCredentials(raw);
  if (fromEnv) return fromEnv;

  // Multiline JSON in .env is truncated to "{" by dotenv — detect and warn.
  if (raw === "{") {
    console.warn(
      "[googlePlay] GOOGLE_PLAY_SERVICE_ACCOUNT_JSON looks truncated. " +
        "Use GOOGLE_PLAY_SERVICE_ACCOUNT_PATH=./secrets/google-play-service-account.json " +
        "or a single-line minified JSON string."
    );
  }

  return null;
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
