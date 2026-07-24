const fs = require("fs");
const path = require("path");
const { SignedDataVerifier, Environment } = require("@apple/app-store-server-library");

const DEFAULT_BUNDLE_ID = "com.datify.ios";
const DEFAULT_CERT_DIR = path.join(__dirname, "../../certs/apple");

let verifierCache = null;

function loadAppleRootCertificates() {
  const certDir = String(process.env.APPLE_ROOT_CERT_DIR || DEFAULT_CERT_DIR).trim();
  const names = ["AppleRootCA-G3.cer", "AppleRootCA-G2.cer"];
  const buffers = [];
  for (const name of names) {
    const full = path.join(certDir, name);
    if (fs.existsSync(full)) {
      buffers.push(fs.readFileSync(full));
    }
  }
  if (!buffers.length) {
    const err = new Error(
      `Apple root certificates not found in ${certDir}. Place AppleRootCA-G3.cer (and optionally G2) there.`
    );
    err.code = "APPLE_NOT_CONFIGURED";
    throw err;
  }
  return buffers;
}

function resolveEnvironment() {
  const raw = String(process.env.APPLE_IAP_ENVIRONMENT || process.env.APP_STORE_ENVIRONMENT || "Sandbox")
    .trim()
    .toUpperCase();
  if (raw === "PRODUCTION" || raw === "PROD") return Environment.PRODUCTION;
  return Environment.SANDBOX;
}

function getBundleId() {
  return String(process.env.APPLE_BUNDLE_ID || process.env.APP_STORE_BUNDLE_ID || DEFAULT_BUNDLE_ID).trim();
}

function getAppAppleId() {
  const raw = process.env.APPLE_APP_APPLE_ID || process.env.APP_STORE_APP_APPLE_ID;
  if (raw == null || String(raw).trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function isAppleBillingConfigured() {
  try {
    loadAppleRootCertificates();
    return Boolean(getBundleId());
  } catch {
    return false;
  }
}

function getSignedDataVerifier() {
  if (verifierCache) return verifierCache;
  const roots = loadAppleRootCertificates();
  const environment = resolveEnvironment();
  const bundleId = getBundleId();
  const appAppleId = getAppAppleId();
  // appAppleId required for Production environment checks in the library.
  verifierCache = new SignedDataVerifier(
    roots,
    true,
    environment,
    bundleId,
    environment === Environment.PRODUCTION ? appAppleId : appAppleId
  );
  return verifierCache;
}

function resetAppleVerifierCache() {
  verifierCache = null;
}

module.exports = {
  isAppleBillingConfigured,
  getSignedDataVerifier,
  getBundleId,
  resetAppleVerifierCache,
  Environment,
};
