const fs = require("fs");
const readline = require("readline");

/**
 * Minimal RFC-style CSV row parser (handles quoted fields with commas).
 */
function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/**
 * Stream-parse a CSV file into row objects keyed by header.
 */
async function parseCsvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`CSV not found: ${filePath}`);
  }

  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let headers = null;
  const rows = [];

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const cols = parseCsvLine(trimmed);
    if (!headers) {
      headers = cols.map((h) => h.trim());
      continue;
    }
    const row = {};
    for (let i = 0; i < headers.length; i += 1) {
      row[headers[i]] = cols[i] != null ? cols[i].trim() : "";
    }
    rows.push(row);
  }

  return rows;
}

module.exports = {
  parseCsvLine,
  parseCsvFile,
};
