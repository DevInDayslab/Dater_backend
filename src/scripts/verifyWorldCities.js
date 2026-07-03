require("dotenv").config();

const { pool } = require("../config/db");
const {
  getCityAndState,
  searchCities,
  resolveBrowseAnchor,
} = require("../services/geocoder.service");

async function assert(name, condition, detail = "") {
  if (!condition) {
    throw new Error(`${name} failed${detail ? `: ${detail}` : ""}`);
  }
  console.log(`OK: ${name}`);
}

async function main() {
  const countRes = await pool.query("SELECT COUNT(*)::int AS n FROM cities");
  await assert("cities table populated", countRes.rows[0].n > 40000, `count=${countRes.rows[0].n}`);

  const indiaRes = await pool.query("SELECT COUNT(*)::int AS n FROM cities WHERE iso2 = 'IN'");
  await assert("India rows present", indiaRes.rows[0].n > 1000, `count=${indiaRes.rows[0].n}`);

  const search = await searchCities({ q: "mum", countryIso2: "IN", page: 1, pageSize: 10 });
  await assert(
    "searchCities mum",
    search.cities.some((c) => c.cityStateLabel.toLowerCase().includes("mumbai")),
    JSON.stringify(search.cities.slice(0, 3).map((c) => c.cityStateLabel))
  );

  const geocode = await getCityAndState(19.0761, 72.8775, { countryIso2: "IN" });
  await assert(
    "getCityAndState Mumbai area",
    geocode && geocode.cityStateLabel.toLowerCase().includes("mumbai"),
    geocode?.cityStateLabel
  );

  const anchor = await resolveBrowseAnchor("Gurgaon, HR");
  await assert("resolveBrowseAnchor Gurgaon", anchor && Number.isFinite(anchor.lat), JSON.stringify(anchor));

  const gurugramAlias = await resolveBrowseAnchor("Gurugram, HR");
  await assert(
    "resolveBrowseAnchor Gurugram alias",
    gurugramAlias && Number.isFinite(gurugramAlias.lat),
    JSON.stringify(gurugramAlias)
  );

  const explain = await pool.query(
    `EXPLAIN SELECT id FROM cities
     WHERE iso2 = 'IN' AND label_norm ILIKE '%mum%'
     LIMIT 10`
  );
  const plan = explain.rows.map((r) => r["QUERY PLAN"]).join("\n");
  await assert(
    "search uses index (not seq scan on cities alone)",
    !plan.includes("Seq Scan on cities") || plan.includes("Bitmap") || plan.includes("Index"),
    plan
  );

  console.log("\nAll world cities checks passed.");
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
