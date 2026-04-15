require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { pool } = require("../config/db");

async function runMigration() {
  const migrationsDir = path.join(__dirname, "..", "..", "sql");

  try {
    const migrationFiles = fs
      .readdirSync(migrationsDir)
      .filter((file) => /^\d+_.*\.sql$/.test(file))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    if (migrationFiles.length === 0) {
      console.log("No SQL migration files found.");
      return;
    }

    for (const fileName of migrationFiles) {
      const migrationFilePath = path.join(migrationsDir, fileName);
      const sql = fs.readFileSync(migrationFilePath, "utf8");
      await pool.query(sql);
      console.log(`Applied migration: ${fileName}`);
    }

    console.log("All migrations applied successfully.");
  } catch (error) {
    console.error("Migration failed:", error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

runMigration();
