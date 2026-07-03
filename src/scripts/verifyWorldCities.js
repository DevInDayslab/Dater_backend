require("dotenv").config();

const { pool } = require("../config/db");
const {
  getCityAndState,
  searchCities,
  resolveBrowseAnchor,
} = require("../services/geocoder.service");

function fail(name, detail = "") {
  throw new Error(`${name} failed${detail ? `: ${detail}` : ""}`);
}

function ok(name) {
  console.log(`OK: ${name}`);
}

async function auditIndexes() {
  const res = await pool.query(
    `SELECT indexname, indexdef
     FROM pg_indexes
     WHERE tablename = 'cities'
     ORDER BY indexname`
  );
  const defs = Object.fromEntries(res.rows.map((r) => [r.indexname, r.indexdef]));

  if (!defs.idx_cities_label_norm_search?.includes("USING gin") || !defs.idx_cities_label_norm_search?.includes("gin_trgm_ops")) {
    fail("idx_cities_label_norm_search GIN trigram", defs.idx_cities_label_norm_search);
  }
  ok("idx_cities_label_norm_search uses GIN gin_trgm_ops");

  if (!defs.idx_cities_city_ascii_search?.includes("gin_trgm_ops")) {
    fail("idx_cities_city_ascii_search GIN trigram", defs.idx_cities_city_ascii_search);
  }
  ok("idx_cities_city_ascii_search uses GIN gin_trgm_ops");

  if (!defs.idx_cities_geom?.includes("USING gist")) {
    fail("idx_cities_geom GIST", defs.idx_cities_geom);
  }
  ok("idx_cities_geom uses GIST");

  const col = await pool.query(
    `SELECT udt_name, data_type
     FROM information_schema.columns
     WHERE table_name = 'cities' AND column_name = 'geom'`
  );
  const typeRow = await pool.query(
    `SELECT format_type(a.atttypid, a.atttypmod) AS coltype
     FROM pg_attribute a
     JOIN pg_class c ON c.oid = a.attrelid
     WHERE c.relname = 'cities' AND a.attname = 'geom' AND NOT a.attisdropped`
  );
  const coltype = coltypeRow(typeRow);
  if (!String(coltype).toLowerCase().includes("geography")) {
    fail("geom column type geography", coltype);
  }
  ok(`geom column is ${coltype}`);
}

function coltypeRow(res) {
  return res.rows[0]?.coltype || "";
}

async function auditEmptySearch() {
  const result = await searchCities({ q: "", page: 1, pageSize: 50, countryIso2: "IN" });
  if (result.cities.length === 0) {
    fail("empty search returns first page", `total=${result.total}`);
  }
  if (result.total < 1000) {
    fail("empty search total India cities", `total=${result.total}`);
  }
  ok(`empty search returns ${result.cities.length} cities (total=${result.total}, hasMore=${result.hasMore})`);
}

async function auditSearchMumbai() {
  const result = await searchCities({ q: "mum", page: 1, pageSize: 10, countryIso2: "IN" });
  const labels = result.cities.map((c) => c.cityStateLabel);
  if (!labels.some((l) => l.toLowerCase().includes("mumbai"))) {
    fail("search mum includes Mumbai", JSON.stringify(labels));
  }
  ok(`search mum → ${labels.slice(0, 3).join(", ")}`);

  const explain = await pool.query(
    `EXPLAIN SELECT id FROM cities
     WHERE iso2 = 'IN' AND (label_norm ILIKE '%mum%' OR city_ascii ILIKE '%mum%')
     LIMIT 10`
  );
  const plan = explain.rows.map((r) => r["QUERY PLAN"]).join("\n");
  if (plan.includes("Seq Scan on cities") && !plan.includes("Bitmap")) {
    fail("search uses trigram index", plan);
  }
  ok("search mum uses index-backed plan");
}

async function auditGeocoder() {
  const mumbai = await getCityAndState(19.0761, 72.8775, { countryIso2: "IN" });
  if (!mumbai?.cityStateLabel?.toLowerCase().includes("mumbai")) {
    fail("getCityAndState Mumbai", mumbai?.cityStateLabel);
  }
  ok(`getCityAndState Mumbai area → ${mumbai.cityStateLabel}`);

  const amritsar = await getCityAndState(31.634, 74.8723, { countryIso2: "IN" });
  if (!amritsar?.cityStateLabel) {
    fail("getCityAndState Amritsar");
  }
  ok(`getCityAndState Amritsar → ${amritsar.cityStateLabel}`);

  const wrongCountry = await getCityAndState(31.634, 74.8723, { countryIso2: "PK" });
  if (wrongCountry?.cityStateLabel?.includes("Amritsar")) {
    fail("country scoping PK should not return Amritsar", wrongCountry.cityStateLabel);
  }
  ok("country scoping isolates IN vs PK");

  // Ramprastha / NCR suburb: should prefer Ghaziabad or Delhi, not tiny Garhi (3.5 km).
  const ramprastha = await getCityAndState(28.663287, 77.3247703, { countryIso2: "IN" });
  const ramLabel = String(ramprastha?.cityStateLabel || "").toLowerCase();
  if (ramLabel.includes("garhi")) {
    fail("NCR suburb should not resolve to Garhi", ramprastha?.cityStateLabel);
  }
  if (!ramLabel.includes("ghaziabad") && !ramLabel.includes("delhi") && !ramLabel.includes("noida")) {
    fail("NCR suburb major city", ramprastha?.cityStateLabel);
  }
  ok(`NCR suburb (Ramprastha coords) → ${ramprastha.cityStateLabel}`);
}

async function auditAnchors() {
  const gurgaon = await resolveBrowseAnchor("Gurgaon, HR");
  const gurugram = await resolveBrowseAnchor("Gurugram, HR");
  if (!gurgaon?.lat || !gurugram?.lat) {
    fail("browse anchors Gurgaon/Gurugram", JSON.stringify({ gurgaon, gurugram }));
  }
  ok("resolveBrowseAnchor Gurgaon + Gurugram alias");
}

async function auditAsciiLabels() {
  const habra = await pool.query(
    `SELECT city, label FROM cities WHERE iso2 = 'IN' AND city_ascii ILIKE 'habra' LIMIT 3`
  );
  if (habra.rows.length === 0) {
    ok("Habra row not in dataset (skipped)");
    return;
  }
  const row = habra.rows[0];
  if (/[ãáàâä]/i.test(row.city) || /[ãáàâä]/i.test(row.label)) {
    fail("Habra uses ASCII display", JSON.stringify(row));
  }
  ok(`Habra display clean → city="${row.city}" label="${row.label}"`);

  const kolkata = await pool.query(
    `SELECT city, label FROM cities WHERE iso2 = 'IN' AND city_ascii = 'Kolkata' LIMIT 1`
  );
  if (kolkata.rows[0] && /[ā]/i.test(kolkata.rows[0].city)) {
    fail("Kolkata uses ASCII display", JSON.stringify(kolkata.rows[0]));
  }
  if (kolkata.rows[0]) {
    ok(`Kolkata display clean → "${kolkata.rows[0].label}"`);
  }
}

async function auditGlobalCityPicker() {
  const result = await searchCities({ q: "london", page: 1, pageSize: 10 });
  const labels = result.cities.map((c) => c.cityStateLabel);
  if (!labels.some((l) => l.toLowerCase().includes("london"))) {
    fail("global search london", JSON.stringify(labels));
  }
  if (!result.cities.some((c) => c.iso2 && c.iso2 !== "IN")) {
    fail("global search returns non-IN cities", JSON.stringify(result.cities.map((c) => c.iso2)));
  }
  ok(`global search london → ${labels.slice(0, 3).join(", ")}`);

  const browse = await searchCities({ q: "", page: 1, pageSize: 20 });
  if (browse.total < 10000) {
    fail("global browse total cities", `total=${browse.total}`);
  }
  if (!browse.cities.some((c) => c.iso2 && c.iso2 !== "IN")) {
    fail("global browse includes international cities");
  }
  ok(`global browse returns ${browse.cities.length} cities (total=${browse.total})`);
}

async function auditPagination() {
  const p1 = await searchCities({ q: "", page: 1, pageSize: 10, countryIso2: "IN" });
  const p2 = await searchCities({ q: "", page: 2, pageSize: 10, countryIso2: "IN" });
  if (p1.cities.length !== 10 || p2.cities.length !== 10) {
    fail("pagination page sizes", `p1=${p1.cities.length} p2=${p2.cities.length}`);
  }
  if (p1.cities[0].cityStateLabel === p2.cities[0].cityStateLabel) {
    fail("pagination distinct pages", `${p1.cities[0].cityStateLabel}`);
  }
  ok("pagination page 1 vs page 2 distinct");
}

async function main() {
  await auditIndexes();
  await auditEmptySearch();
  await auditSearchMumbai();
  await auditGeocoder();
  await auditAnchors();
  await auditAsciiLabels();
  await auditGlobalCityPicker();
  await auditPagination();
  console.log("\nAll world cities audits passed.");
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
