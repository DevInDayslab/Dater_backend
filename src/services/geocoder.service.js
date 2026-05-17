const cities = require("../data/india_cities.json");

const EARTH_RADIUS_KM = 6371;

const STATE_CODE_MAP = {
  "Andaman and Nicobar Islands": "AN",
  "Andhra Pradesh": "AP",
  "Arunachal Pradesh": "AR",
  Assam: "AS",
  Bihar: "BR",
  Chandigarh: "CH",
  Chhattisgarh: "CG",
  "Dadra and Nagar Haveli": "DN",
  "Daman and Diu": "DD",
  Delhi: "DL",
  Goa: "GA",
  Gujarat: "GJ",
  Haryana: "HR",
  "Himachal Pradesh": "HP",
  "Jammu and Kashmir": "JK",
  Jharkhand: "JH",
  Karnataka: "KA",
  Kerala: "KL",
  Lakshadweep: "LD",
  "Madhya Pradesh": "MP",
  Maharashtra: "MH",
  Manipur: "MN",
  Meghalaya: "ML",
  Mizoram: "MZ",
  Nagaland: "NL",
  Odisha: "OD",
  Puducherry: "PY",
  Punjab: "PB",
  Rajasthan: "RJ",
  Sikkim: "SK",
  "Tamil Nadu": "TN",
  Telangana: "TS",
  Tripura: "TR",
  "Uttar Pradesh": "UP",
  Uttarakhand: "UK",
  "West Bengal": "WB",
};

function toRadians(value) {
  return (value * Math.PI) / 180;
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}

function getCityAndState(lat, lng) {
  const latitude = Number(lat);
  const longitude = Number(lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }

  let nearest = null;
  let minDistance = Number.POSITIVE_INFINITY;
  for (const city of cities) {
    const cityLat = Number(city.lat);
    const cityLng = Number(city.lng);
    if (!Number.isFinite(cityLat) || !Number.isFinite(cityLng)) continue;
    const dist = haversineKm(latitude, longitude, cityLat, cityLng);
    if (dist < minDistance) {
      minDistance = dist;
      nearest = city;
    }
  }

  if (!nearest) return null;
  const stateCode = STATE_CODE_MAP[nearest.state] || nearest.state;
  return {
    city: nearest.city,
    state: stateCode,
    cityStateLabel: `${nearest.city}, ${stateCode}`,
  };
}

function getAllIndianCities() {
  const unique = new Map();
  for (const row of cities) {
    const city = String(row.city || "").trim();
    const stateName = String(row.state || "").trim();
    if (!city || !stateName) continue;
    const stateCode = STATE_CODE_MAP[stateName] || stateName;
    const key = `${city.toLowerCase()}|${stateName.toLowerCase()}`;
    if (unique.has(key)) continue;
    unique.set(key, {
      city,
      state: stateName,
      stateCode,
      cityStateLabel: `${city}, ${stateCode}`,
    });
  }
  return Array.from(unique.values()).sort((a, b) => {
    const cityCmp = a.city.localeCompare(b.city, "en", { sensitivity: "base" });
    if (cityCmp !== 0) return cityCmp;
    return a.state.localeCompare(b.state, "en", { sensitivity: "base" });
  });
}

const normCityKey = (s) => String(s || "").trim().toLowerCase();

/**
 * Resolve an app "switch city" label (e.g. "New Delhi, DL") to lat/lng from india_cities.json.
 * Used when the viewer browses by manual city but is physically elsewhere.
 */
function resolveIndiaBrowseAnchor(preferredLocationCityRaw) {
  const label = String(preferredLocationCityRaw || "").trim();
  if (!label) return null;

  const all = getAllIndianCities();
  const byLabel = new Map();
  for (const row of all) {
    byLabel.set(normCityKey(row.cityStateLabel), row);
  }

  const exact = byLabel.get(normCityKey(label));
  if (exact) {
    const entry = cities.find(
      (c) => normCityKey(c.city) === normCityKey(exact.city) && normCityKey(c.state) === normCityKey(exact.state)
    );
    if (entry && Number.isFinite(Number(entry.lat)) && Number.isFinite(Number(entry.lng))) {
      return { lat: Number(entry.lat), lng: Number(entry.lng) };
    }
  }

  const part0 = normCityKey(label.split(",")[0]);
  const part1 = normCityKey(label.split(",")[1] || "");
  if (part0) {
    const stateMatch = part1
      ? all.find(
          (r) => normCityKey(r.city) === part0 && (normCityKey(r.stateCode) === part1 || normCityKey(r.state) === part1)
        )
      : null;
    const candidates = stateMatch
      ? [stateMatch]
      : all.filter((r) => normCityKey(r.city) === part0);
    if (candidates.length === 1) {
      const row = candidates[0];
      const entry = cities.find(
        (c) => normCityKey(c.city) === normCityKey(row.city) && normCityKey(c.state) === normCityKey(row.state)
      );
      if (entry && Number.isFinite(Number(entry.lat)) && Number.isFinite(Number(entry.lng))) {
        return { lat: Number(entry.lat), lng: Number(entry.lng) };
      }
    }
  }

  // Delhi NCT: list may show both "Delhi, DL" and "New Delhi, DL" as separate picks; anchor should work for either.
  const cityKey = normCityKey(label.split(",")[0]);
  const stateKey = normCityKey(label.split(",")[1] || "");
  if (
    (cityKey === "delhi" || cityKey === "new delhi") &&
    (!stateKey || stateKey === "dl" || stateKey === "delhi")
  ) {
    const entry =
      cities.find((row) => normCityKey(row.city) === "new delhi" && normCityKey(row.state) === "delhi") ||
      cities.find((row) => normCityKey(row.city) === "delhi" && normCityKey(row.state) === "delhi");
    if (entry && Number.isFinite(Number(entry.lat)) && Number.isFinite(Number(entry.lng))) {
      return { lat: Number(entry.lat), lng: Number(entry.lng) };
    }
  }

  return null;
}

/** Cached parallel arrays for SQL `unnest(labels, lats, lngs)` (feed/story traveler injection). */
let cachedIndiaBrowseAnchorUnnest = null;

/**
 * Builds normalized "City, ST" labels → coordinates from india_cities.json so Postgres can join
 * `user_filters.preferred_location_city` to an anchor without calling Node geocoder per row.
 */
function getIndiaBrowseAnchorUnnestArrays() {
  if (cachedIndiaBrowseAnchorUnnest) return cachedIndiaBrowseAnchorUnnest;

  const norm = (s) => String(s || "").trim().toLowerCase();
  const rows = [];
  const seen = new Set();

  function addRow(label, lat, lng) {
    const key = norm(label);
    if (!key || seen.has(key)) return;
    const la = Number(lat);
    const ln = Number(lng);
    if (!Number.isFinite(la) || !Number.isFinite(ln)) return;
    seen.add(key);
    rows.push({ labelNorm: key, lat: la, lng: ln });
  }

  for (const row of cities) {
    const city = String(row.city || "").trim();
    const stateName = String(row.state || "").trim();
    if (!city || !stateName) continue;
    const stateCode = STATE_CODE_MAP[stateName] || stateName;
    addRow(`${city}, ${stateCode}`, row.lat, row.lng);
  }

  const delhiEntry =
    cities.find((r) => norm(r.city) === "new delhi" && norm(r.state) === "delhi") ||
    cities.find((r) => norm(r.city) === "delhi" && norm(r.state) === "delhi");
  if (delhiEntry) {
    addRow("Delhi, DL", delhiEntry.lat, delhiEntry.lng);
    addRow("New Delhi, DL", delhiEntry.lat, delhiEntry.lng);
    addRow("delhi, delhi", delhiEntry.lat, delhiEntry.lng);
    addRow("new delhi, delhi", delhiEntry.lat, delhiEntry.lng);
  }

  cachedIndiaBrowseAnchorUnnest = {
    anchorLabelNorms: rows.map((r) => r.labelNorm),
    anchorLats: rows.map((r) => r.lat),
    anchorLngs: rows.map((r) => r.lng),
  };
  return cachedIndiaBrowseAnchorUnnest;
}

module.exports = {
  getCityAndState,
  getAllIndianCities,
  resolveIndiaBrowseAnchor,
  getIndiaBrowseAnchorUnnestArrays,
  haversineKm,
};
