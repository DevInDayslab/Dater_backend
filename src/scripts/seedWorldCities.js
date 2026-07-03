require("dotenv").config();

const path = require("path");
const { pool } = require("../config/db");
const { parseCsvFile } = require("../utils/parseCsvRows");
const {
  buildCityLabel,
  stateCodeForIndianAdmin,
  stateNameForIndianAdmin,
  DEFAULT_CITY_LABEL_ALIASES,
  STATE_CODE_MAP,
  normalizeAdminName,
  INDIAN_CITY_OVERRIDES,
  normalizeCityAsciiKey,
} = require("../constants/indiaStateCodes");

const BATCH_SIZE = 1000;
const DEFAULT_CSV = path.join(__dirname, "..", "data", "Cities_world_coordinates.csv");

function generateCityData(row) {
  const lat = Number(row.lat);
  const lng = Number(row.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const iso2 = String(row.iso2 || "").trim().toUpperCase();
  const city = String(row.city || "").trim();
  const cityAscii = String(row.city_ascii || city).trim();
  const id = Number.parseInt(String(row.id || "").trim(), 10);
  if (!city || !iso2 || !Number.isFinite(id)) return null;

  const label = buildCityLabel(row);
  if (!label) return null;

  const stateCode = iso2 === "IN"
    ? stateCodeForIndianAdmin(row.admin_name) ||
      INDIAN_CITY_OVERRIDES[normalizeCityAsciiKey(row.city_ascii || city)]?.stateCode ||
      ""
    : null;
  const populationRaw = String(row.population || "").trim();
  const population = populationRaw ? Number.parseInt(populationRaw, 10) : null;

  return {
    id,
    city,
    city_ascii: cityAscii,
    lat,
    lng,
    country: String(row.country || "").trim(),
    iso2,
    iso3: String(row.iso3 || "").trim() || null,
    admin_name: String(row.admin_name || "").trim() || null,
    capital: String(row.capital || "").trim() || null,
    population: Number.isFinite(population) ? population : null,
    state_code: stateCode,
    label,
    label_norm: label.toLowerCase().trim(),
  };
}

async function insertBatch(batch) {
  if (batch.length === 0) return;

  const ids = [];
  const cities = [];
  const cityAscii = [];
  const lats = [];
  const lngs = [];
  const countries = [];
  const iso2s = [];
  const iso3s = [];
  const adminNames = [];
  const capitals = [];
  const populations = [];
  const stateCodes = [];
  const labels = [];
  const labelNorms = [];

  for (const row of batch) {
    ids.push(row.id);
    cities.push(row.city);
    cityAscii.push(row.city_ascii);
    lats.push(row.lat);
    lngs.push(row.lng);
    countries.push(row.country);
    iso2s.push(row.iso2);
    iso3s.push(row.iso3);
    adminNames.push(row.admin_name);
    capitals.push(row.capital);
    populations.push(row.population);
    stateCodes.push(row.state_code);
    labels.push(row.label);
    labelNorms.push(row.label_norm);
  }

  await pool.query(
    `INSERT INTO cities (
       id, city, city_ascii, lat, lng, country, iso2, iso3, admin_name, capital,
       population, state_code, label, label_norm, geom
     )
     SELECT
       u.id,
       u.city,
       u.city_ascii,
       u.lat,
       u.lng,
       u.country,
       u.iso2,
       u.iso3,
       u.admin_name,
       u.capital,
       u.population,
       u.state_code,
       u.label,
       u.label_norm,
       ST_SetSRID(ST_MakePoint(u.lng, u.lat), 4326)::geography
     FROM UNNEST(
       $1::int[],
       $2::text[],
       $3::text[],
       $4::double precision[],
       $5::double precision[],
       $6::text[],
       $7::char(2)[],
       $8::text[],
       $9::text[],
       $10::text[],
       $11::int[],
       $12::text[],
       $13::text[],
       $14::text[]
     ) AS u(
       id, city, city_ascii, lat, lng, country, iso2, iso3, admin_name, capital,
       population, state_code, label, label_norm
     )
     ON CONFLICT (id) DO UPDATE SET
       city = EXCLUDED.city,
       city_ascii = EXCLUDED.city_ascii,
       lat = EXCLUDED.lat,
       lng = EXCLUDED.lng,
       country = EXCLUDED.country,
       iso2 = EXCLUDED.iso2,
       iso3 = EXCLUDED.iso3,
       admin_name = EXCLUDED.admin_name,
       capital = EXCLUDED.capital,
       population = EXCLUDED.population,
       state_code = EXCLUDED.state_code,
       label = EXCLUDED.label,
       label_norm = EXCLUDED.label_norm,
       geom = EXCLUDED.geom`,
    [
      ids,
      cities,
      cityAscii,
      lats,
      lngs,
      countries,
      iso2s,
      iso3s,
      adminNames,
      capitals,
      populations,
      stateCodes,
      labels,
      labelNorms,
    ]
  );
}

async function seedLabelAliases() {
  const seen = new Set();
  for (const [oldNorm, newNorm] of DEFAULT_CITY_LABEL_ALIASES) {
    const key = String(oldNorm).trim().toLowerCase();
    const val = String(newNorm).trim().toLowerCase();
    if (!key || !val || seen.has(key)) continue;
    seen.add(key);
    await pool.query(
      `INSERT INTO city_label_aliases (old_label_norm, new_label_norm)
       VALUES ($1, $2)
       ON CONFLICT (old_label_norm) DO UPDATE SET new_label_norm = EXCLUDED.new_label_norm`,
      [key, val]
    );
  }
}

async function main() {
  const csvPath = process.env.WORLDCITIES_CSV || DEFAULT_CSV;
  console.log(`Reading cities from ${csvPath}`);

  const rawRows = await parseCsvFile(csvPath);
  const prepared = [];
  const skipped = [];
  const unknownIndianAdmins = new Map();

  for (const row of rawRows) {
    const data = generateCityData(row);
    if (!data) {
      skipped.push(row);
      continue;
    }
    if (data.iso2 === "IN") {
      const normalized = stateNameForIndianAdmin(row.admin_name);
      if (!STATE_CODE_MAP[normalized] && normalized) {
        unknownIndianAdmins.set(normalized, (unknownIndianAdmins.get(normalized) || 0) + 1);
      }
    }
    prepared.push(data);
  }

  console.log(`Parsed ${rawRows.length} CSV rows → ${prepared.length} valid, ${skipped.length} skipped`);

  for (let i = 0; i < prepared.length; i += BATCH_SIZE) {
    const batch = prepared.slice(i, i + BATCH_SIZE);
    await insertBatch(batch);
    console.log(`Inserted batch ${Math.floor(i / BATCH_SIZE) + 1} (${Math.min(i + BATCH_SIZE, prepared.length)}/${prepared.length})`);
  }

  await seedLabelAliases();

  const countRes = await pool.query("SELECT COUNT(*)::int AS n FROM cities");
  const indiaRes = await pool.query("SELECT COUNT(*)::int AS n FROM cities WHERE iso2 = 'IN'");
  console.log(`cities table: ${countRes.rows[0].n} total, ${indiaRes.rows[0].n} India`);

  if (unknownIndianAdmins.size > 0) {
    console.warn("Indian admin_name values without STATE_CODE_MAP entry:");
    for (const [name, n] of [...unknownIndianAdmins.entries()].sort((a, b) => b[1] - a[1])) {
      console.warn(`  ${name}: ${n} rows (normalized from CSV diacritics)`);
    }
  }

  const unmappedIndia = await pool.query(
    `SELECT COUNT(*)::int AS n FROM cities WHERE iso2 = 'IN' AND (state_code IS NULL OR state_code = '')`
  );
  if (unmappedIndia.rows[0].n > 0) {
    console.warn(`${unmappedIndia.rows[0].n} India rows have no state_code (label falls back to ", IN")`);
  }
}

main()
  .catch((err) => {
    console.error("seedWorldCities failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
