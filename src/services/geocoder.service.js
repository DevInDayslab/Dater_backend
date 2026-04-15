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

module.exports = {
  getCityAndState,
  getAllIndianCities,
};
