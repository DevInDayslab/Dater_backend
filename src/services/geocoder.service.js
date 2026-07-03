const { query } = require("../config/db");
const {
  stateCodeForIndianAdmin,
  stateNameForIndianAdmin,
  buildIndiaCityLabel,
} = require("../constants/indiaStateCodes");

const EARTH_RADIUS_KM = 6371;
const DEFAULT_COUNTRY_ISO2 = "IN";
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 50;
/** Prefer a major city for GPS reverse-geocode (avoids tiny suburbs like Garhi over Ghaziabad). */
const REVERSE_GEOCODE_MIN_POPULATION = 250000;
const REVERSE_GEOCODE_SIGNIFICANT_RADIUS_M = 50000;

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

const normCityKey = (s) => String(s || "").trim().toLowerCase();

function mapCityRow(row) {
  const iso2 = String(row.iso2 || "").trim().toUpperCase();
  const stateCode =
    row.state_code ||
    (iso2 === "IN" ? stateCodeForIndianAdmin(row.admin_name) : "") ||
    "";
  const state =
    iso2 === "IN"
      ? stateNameForIndianAdmin(row.admin_name) || String(row.admin_name || "").trim()
      : String(row.admin_name || row.country || "").trim();

  return {
    id: row.id,
    city: row.city,
    state,
    stateCode,
    cityStateLabel: row.label,
    country: row.country,
    iso2,
    population: row.population != null ? Number(row.population) : null,
    lat: Number(row.lat),
    lng: Number(row.lng),
  };
}

function resolveCountryIso2(countryIso2) {
  const code = String(countryIso2 || DEFAULT_COUNTRY_ISO2).trim().toUpperCase();
  return code || DEFAULT_COUNTRY_ISO2;
}

/** Empty / ALL / * → no country filter (worldwide city picker). */
function resolveSearchCountryIso2(countryIso2) {
  const code = String(countryIso2 ?? "").trim().toUpperCase();
  if (!code || code === "*" || code === "ALL") return null;
  return code;
}

function phoneCountryCodeToIso2(phoneCountryCode) {
  const code = String(phoneCountryCode || "").trim();
  if (code === "+91" || code === "91") return "IN";
  return DEFAULT_COUNTRY_ISO2;
}

async function getCityAndState(lat, lng, { countryIso2 = DEFAULT_COUNTRY_ISO2 } = {}) {
  const latitude = Number(lat);
  const longitude = Number(lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }

  const iso2 = resolveCountryIso2(countryIso2);
  const pointSql = `ST_SetSRID(ST_MakePoint($3::double precision, $2::double precision), 4326)::geography`;
  const baseParams = [iso2, latitude, longitude];

  // Nearest major city within ~50 km (NCR suburbs should read Ghaziabad/Delhi, not Garhi).
  const significantRes = await query(
    `SELECT id, city, admin_name, state_code, label, country, iso2, population, lat, lng
     FROM cities
     WHERE iso2 = $1
       AND COALESCE(population, 0) >= $4
       AND ST_DWithin(geom, ${pointSql}, $5)
     ORDER BY geom <-> ${pointSql}
     LIMIT 1`,
    [...baseParams, REVERSE_GEOCODE_MIN_POPULATION, REVERSE_GEOCODE_SIGNIFICANT_RADIUS_M]
  );

  let row = significantRes.rows[0];
  if (!row) {
    const nearestRes = await query(
      `SELECT id, city, admin_name, state_code, label, country, iso2, population, lat, lng
       FROM cities
       WHERE iso2 = $1
       ORDER BY geom <-> ${pointSql}
       LIMIT 1`,
      baseParams
    );
    row = nearestRes.rows[0];
  }

  if (!row) return null;
  const mapped = mapCityRow(row);
  return {
    city: mapped.city,
    state: mapped.stateCode || mapped.state,
    cityStateLabel: mapped.cityStateLabel,
  };
}

async function searchCities({
  q = "",
  page = 1,
  pageSize = DEFAULT_PAGE_SIZE,
  countryIso2 = "",
  selectedLabel = "",
} = {}) {
  const iso2 = resolveSearchCountryIso2(countryIso2);
  const searchTerm = String(q || "").trim();
  const safePage = Math.max(1, Number.parseInt(String(page), 10) || 1);
  const safePageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Number.parseInt(String(pageSize), 10) || DEFAULT_PAGE_SIZE)
  );
  const offset = (safePage - 1) * safePageSize;
  const selectedNorm = normCityKey(selectedLabel);
  const ilikePattern = searchTerm ? `%${searchTerm}%` : null;
  const prefixPattern = searchTerm ? `${searchTerm}%` : null;

  const whereParts = [];
  const params = [];
  if (iso2) {
    params.push(iso2);
    whereParts.push(`iso2 = $${params.length}`);
  }
  if (searchTerm) {
    params.push(ilikePattern);
    const p = `$${params.length}`;
    whereParts.push(`(label_norm ILIKE ${p} OR city_ascii ILIKE ${p} OR city ILIKE ${p})`);
  }
  const whereClause = whereParts.length > 0 ? whereParts.join(" AND ") : "TRUE";

  const countRes = await query(`SELECT COUNT(*)::int AS total FROM cities WHERE ${whereClause}`, params);
  const total = countRes.rows[0]?.total ?? 0;

  const listParams = [...params];
  if (searchTerm) {
    listParams.push(selectedNorm, prefixPattern, safePageSize, offset);
    const selectedIdx = listParams.length - 3;
    const prefixIdx = listParams.length - 2;
    const limitIdx = listParams.length - 1;
    const offsetIdx = listParams.length;
    const listSql = `SELECT id, city, city_ascii, admin_name, state_code, label, country, iso2, population, lat, lng
       FROM cities
       WHERE ${whereClause}
       ORDER BY
         CASE WHEN label_norm = $${selectedIdx} THEN 0 ELSE 1 END,
         CASE WHEN label_norm LIKE $${prefixIdx} OR city_ascii LIKE $${prefixIdx} OR city LIKE $${prefixIdx} THEN 0 ELSE 1 END,
         ${iso2 ? "label_norm ASC" : "COALESCE(population, 0) DESC, label_norm ASC"}
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`;
    const listRes = await query(listSql, listParams);
    const cities = listRes.rows.map(mapCityRow);
    return {
      cities,
      page: safePage,
      pageSize: safePageSize,
      total,
      hasMore: offset + cities.length < total,
    };
  }

  listParams.push(selectedNorm, safePageSize, offset);
  const selectedIdx = listParams.length - 2;
  const limitIdx = listParams.length - 1;
  const offsetIdx = listParams.length;
  const emptyBrowseOrder = iso2
    ? "label_norm ASC"
    : "COALESCE(population, 0) DESC, label_norm ASC";
  const listSql = `SELECT id, city, city_ascii, admin_name, state_code, label, country, iso2, population, lat, lng
       FROM cities
       WHERE ${whereClause}
       ORDER BY
         CASE WHEN label_norm = $${selectedIdx} THEN 0 ELSE 1 END,
         ${emptyBrowseOrder}
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`;
  const listRes = await query(listSql, listParams);
  const cities = listRes.rows.map(mapCityRow);

  return {
    cities,
    page: safePage,
    pageSize: safePageSize,
    total,
    hasMore: offset + cities.length < total,
  };
}

async function resolveLabelNorm(label) {
  const key = normCityKey(label);
  if (!key) return null;

  const direct = await query(`SELECT label_norm FROM cities WHERE label_norm = $1 LIMIT 1`, [key]);
  if (direct.rows[0]) return key;

  const alias = await query(
    `SELECT new_label_norm FROM city_label_aliases WHERE old_label_norm = $1 LIMIT 1`,
    [key]
  );
  if (alias.rows[0]?.new_label_norm) return alias.rows[0].new_label_norm;

  return null;
}

async function resolveBrowseAnchor(preferredLocationCityRaw) {
  const label = String(preferredLocationCityRaw || "").trim();
  if (!label) return null;

  const labelNorm = await resolveLabelNorm(label);
  if (labelNorm) {
    const res = await query(`SELECT lat, lng FROM cities WHERE label_norm = $1 LIMIT 1`, [labelNorm]);
    if (res.rows[0]) {
      return { lat: Number(res.rows[0].lat), lng: Number(res.rows[0].lng) };
    }
  }

  const part0 = normCityKey(label.split(",")[0]);
  const part1 = normCityKey(label.split(",")[1] || "");
  if (part0) {
    const params = [part0];
    let sql = `SELECT lat, lng, label_norm, state_code, admin_name
               FROM cities
               WHERE iso2 = 'IN' AND (lower(trim(city)) = $1 OR lower(trim(city_ascii)) = $1)`;
    if (part1) {
      sql += ` AND (lower(trim(state_code)) = $2 OR lower(trim(admin_name)) = $2)`;
      params.push(part1);
    }
    sql += ` LIMIT 2`;
    const fuzzy = await query(sql, params);
    if (fuzzy.rows.length === 1) {
      return { lat: Number(fuzzy.rows[0].lat), lng: Number(fuzzy.rows[0].lng) };
    }
  }

  const cityKey = normCityKey(label.split(",")[0]);
  const stateKey = normCityKey(label.split(",")[1] || "");
  if (
    (cityKey === "delhi" || cityKey === "new delhi") &&
    (!stateKey || stateKey === "dl" || stateKey === "delhi")
  ) {
    const delhi = await query(
      `SELECT lat, lng FROM cities
       WHERE iso2 = 'IN' AND label_norm IN ('new delhi, dl', 'delhi, dl')
       ORDER BY CASE WHEN label_norm = 'new delhi, dl' THEN 0 ELSE 1 END
       LIMIT 1`
    );
    if (delhi.rows[0]) {
      return { lat: Number(delhi.rows[0].lat), lng: Number(delhi.rows[0].lng) };
    }
  }

  return null;
}

/** @deprecated use resolveBrowseAnchor */
const resolveIndiaBrowseAnchor = resolveBrowseAnchor;

async function getAllIndianCities() {
  const result = await searchCities({ countryIso2: "IN", page: 1, pageSize: MAX_PAGE_SIZE });
  return result.cities;
}

module.exports = {
  getCityAndState,
  searchCities,
  getAllIndianCities,
  resolveBrowseAnchor,
  resolveIndiaBrowseAnchor,
  haversineKm,
  phoneCountryCodeToIso2,
  mapCityRow,
  buildIndiaCityLabel,
};
