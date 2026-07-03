require("dotenv").config();

const { pool, query } = require("../config/db");
const { resolveBrowseAnchor } = require("../services/geocoder.service");

const LABEL_COLUMNS = [
  { table: "user_filters", column: "preferred_location_city" },
  { table: "users", column: "living_in_city" },
  { table: "users", column: "home_town_city" },
];

async function resolveCanonicalLabel(rawLabel) {
  const label = String(rawLabel || "").trim();
  if (!label) return null;

  const direct = await query(`SELECT label FROM cities WHERE label_norm = $1 LIMIT 1`, [
    label.toLowerCase(),
  ]);
  if (direct.rows[0]?.label) return direct.rows[0].label;

  const alias = await query(
    `SELECT c.label
     FROM city_label_aliases a
     JOIN cities c ON c.label_norm = a.new_label_norm
     WHERE a.old_label_norm = $1
     LIMIT 1`,
    [label.toLowerCase()]
  );
  if (alias.rows[0]?.label) return alias.rows[0].label;

  const anchor = await resolveBrowseAnchor(label);
  if (anchor) {
    const matched = await query(
      `SELECT label FROM cities WHERE lat = $1 AND lng = $2 LIMIT 1`,
      [anchor.lat, anchor.lng]
    );
    if (matched.rows[0]?.label) return matched.rows[0].label;
  }

  return null;
}

async function migrateColumn(table, column) {
  const res = await query(
    `SELECT DISTINCT ${column} AS label
     FROM ${table}
     WHERE ${column} IS NOT NULL AND NULLIF(TRIM(${column}), '') IS NOT NULL`
  );

  let updated = 0;
  const unresolved = [];

  for (const row of res.rows) {
    const current = String(row.label || "").trim();
    const canonical = await resolveCanonicalLabel(current);
    if (!canonical) {
      unresolved.push({ table, column, label: current });
      continue;
    }
    if (canonical === current) continue;

    const upd = await query(
      `UPDATE ${table}
       SET ${column} = $2
       WHERE ${column} = $1`,
      [current, canonical]
    );
    updated += upd.rowCount || 0;
    console.log(`  ${table}.${column}: "${current}" → "${canonical}" (${upd.rowCount || 0} rows)`);
  }

  return { updated, unresolved };
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  let totalUpdated = 0;
  const allUnresolved = [];

  for (const { table, column } of LABEL_COLUMNS) {
    console.log(`Migrating ${table}.${column}...`);
    if (dryRun) {
      const res = await query(
        `SELECT DISTINCT ${column} AS label
         FROM ${table}
         WHERE ${column} IS NOT NULL AND NULLIF(TRIM(${column}), '') IS NOT NULL`
      );
      for (const row of res.rows) {
        const current = String(row.label || "").trim();
        const canonical = await resolveCanonicalLabel(current);
        if (!canonical) allUnresolved.push({ table, column, label: current });
        else if (canonical !== current) {
          console.log(`  would update: "${current}" → "${canonical}"`);
        }
      }
      continue;
    }
    const { updated, unresolved } = await migrateColumn(table, column);
    totalUpdated += updated;
    allUnresolved.push(...unresolved);
  }

  console.log(`\nDone. ${totalUpdated} row(s) updated.`);
  if (allUnresolved.length > 0) {
    console.warn(`\nUnresolved labels (${allUnresolved.length}):`);
    for (const item of allUnresolved) {
      console.warn(`  ${item.table}.${item.column}: "${item.label}"`);
    }
  }
}

main()
  .catch((err) => {
    console.error("migrateStoredCityLabels failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
