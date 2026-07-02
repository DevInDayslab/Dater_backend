/**
 * One-time helper: extracts multiline GOOGLE_PLAY_SERVICE_ACCOUNT_JSON from .env
 * into secrets/google-play-service-account.json (gitignored).
 */
const fs = require("fs");
const path = require("path");

const envPath = path.join(__dirname, "../../.env");
const outPath = path.join(__dirname, "../../secrets/google-play-service-account.json");

function main() {
  if (!fs.existsSync(envPath)) {
    console.error("No .env file found at", envPath);
    process.exit(1);
  }
  const text = fs.readFileSync(envPath, "utf8");
  const marker = "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON=";
  const start = text.indexOf(marker);
  if (start < 0) {
    console.error("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON not found in .env");
    process.exit(1);
  }
  const jsonStart = start + marker.length;
  const jsonEnd = text.indexOf("\n\n", jsonStart);
  const block = (jsonEnd >= 0 ? text.slice(jsonStart, jsonEnd) : text.slice(jsonStart)).trim();
  const parsed = JSON.parse(block);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(parsed, null, 2)}\n`);
  console.log("Wrote", outPath);
  console.log("Add to .env: GOOGLE_PLAY_SERVICE_ACCOUNT_PATH=./secrets/google-play-service-account.json");
  console.log("Then remove the multiline GOOGLE_PLAY_SERVICE_ACCOUNT_JSON block.");
}

main();
