/**
 * Indian state / UT name → 2-letter code for cityStateLabel (e.g. "Mumbai, MH").
 * Codes match legacy india_cities.json (OD for Odisha, TS for Telangana).
 */
const STATE_CODE_MAP = {
  "Andaman and Nicobar Islands": "AN",
  "Andhra Pradesh": "AP",
  "Arunachal Pradesh": "AR",
  Assam: "AS",
  Bihar: "BR",
  Chandigarh: "CH",
  Chhattisgarh: "CG",
  "Dadra and Nagar Haveli and Daman and Diu": "DN",
  "Dadra and Nagar Haveli": "DN",
  "Daman and Diu": "DN",
  Delhi: "DL",
  Goa: "GA",
  Gujarat: "GJ",
  Haryana: "HR",
  "Himachal Pradesh": "HP",
  "Jammu and Kashmir": "JK",
  Jharkhand: "JH",
  Karnataka: "KA",
  Kerala: "KL",
  Ladakh: "LA",
  Lakshadweep: "LD",
  "Madhya Pradesh": "MP",
  Maharashtra: "MH",
  Manipur: "MN",
  Meghalaya: "ML",
  Mizoram: "MZ",
  Nagaland: "NL",
  Odisha: "OD",
  Orissa: "OD",
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

const ADMIN_NAME_ALIASES = {
  Orissa: "Odisha",
};

/** Cities where CSV omits admin_name but state is known. Key = NFD-stripped lower city_ascii. */
const INDIAN_CITY_OVERRIDES = {
  chandigarh: { stateCode: "CH", adminName: "Chandigarh" },
};

/** Strip diacritics so CSV "Mahārāshtra" maps to STATE_CODE_MAP key "Maharashtra". */
function normalizeAdminName(rawName) {
  if (!rawName) return "";
  let cleaned = String(rawName)
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (ADMIN_NAME_ALIASES[cleaned]) {
    cleaned = ADMIN_NAME_ALIASES[cleaned];
  }
  return cleaned;
}

function stateCodeForIndianAdmin(rawAdminName) {
  const normalized = normalizeAdminName(rawAdminName);
  return STATE_CODE_MAP[normalized] || "";
}

function stateNameForIndianAdmin(rawAdminName) {
  return normalizeAdminName(rawAdminName);
}

function normalizeCityAsciiKey(value) {
  return String(value || "")
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function buildIndiaCityLabel(city, rawAdminName, cityAscii = "") {
  const cityName = String(city || "").trim();
  const asciiKey = normalizeCityAsciiKey(cityAscii || cityName);
  const override = INDIAN_CITY_OVERRIDES[asciiKey];
  const stateCode =
    stateCodeForIndianAdmin(rawAdminName) || override?.stateCode || "";
  const cleanAdmin =
    normalizeAdminName(rawAdminName) || override?.adminName || "";

  if (cleanAdmin === "Delhi") {
    if (cityName === "New Delhi") return "New Delhi, DL";
    if (cityName === "Delhi") return "Delhi, DL";
    return stateCode ? `${cityName}, ${stateCode}` : `${cityName}, IN`;
  }

  if (stateCode) return `${cityName}, ${stateCode}`;
  return `${cityName}, IN`;
}

function buildCityLabel(row) {
  const iso2 = String(row.iso2 || "").trim().toUpperCase();
  const city = String(row.city || "").trim();
  if (!city || !iso2) return "";

  if (iso2 === "IN") {
    return buildIndiaCityLabel(city, row.admin_name, row.city_ascii || city);
  }
  return `${city}, ${iso2}`;
}

const DEFAULT_CITY_LABEL_ALIASES = [
  ["allahabad, up", "prayagraj, up"],
  ["gurugram, hr", "gurgaon, hr"],
];

module.exports = {
  STATE_CODE_MAP,
  normalizeAdminName,
  stateCodeForIndianAdmin,
  stateNameForIndianAdmin,
  buildIndiaCityLabel,
  buildCityLabel,
  DEFAULT_CITY_LABEL_ALIASES,
  INDIAN_CITY_OVERRIDES,
  normalizeCityAsciiKey,
};
