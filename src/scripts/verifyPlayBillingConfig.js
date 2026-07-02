/**
 * Verifies Google Play billing credentials load correctly from env.
 * Run on the server after setting GOOGLE_PLAY_SERVICE_ACCOUNT_* vars.
 */
require("dotenv").config();
const {
  isPlayBillingConfigured,
  parseServiceAccountJson,
  getPackageName,
} = require("../config/googlePlay");

function main() {
  const configured = isPlayBillingConfigured();
  const credentials = parseServiceAccountJson();
  console.log("GOOGLE_PLAY_PACKAGE_NAME:", getPackageName());
  console.log("Play billing configured:", configured);
  if (credentials) {
    console.log("Service account email:", credentials.client_email || "(missing)");
    console.log("GCP project:", credentials.project_id || "(missing)");
  } else {
    console.error(
      "\nFAIL: Could not load service account credentials.\n" +
        "Set GOOGLE_PLAY_SERVICE_ACCOUNT_PATH to a JSON file, or\n" +
        "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON as a single-line minified JSON string.\n" +
        "Multiline JSON in .env does NOT work (dotenv truncates at the first newline)."
    );
    process.exit(1);
  }
  console.log("\nOK: Google Play billing credentials loaded.");
}

main();
