/**
 * Destroys ALL application data:
 * 1) TRUNCATE every public table (PostGIS system table excluded).
 * 2) Delete every object in S3_MEDIA_BUCKET (paginated).
 *
 * Safety:
 *   WIPE_ALL_DATA_CONFIRM=DELETE_ALL_DATA_AND_S3   (required)
 *   DATABASE_URL must be localhost/127.0.0.1 OR set ALLOW_REMOTE_WIPE=true
 *
 * Usage (from backend/):
 *   WIPE_ALL_DATA_CONFIRM=DELETE_ALL_DATA_AND_S3 node src/scripts/wipeAllData.js
 */
require("dotenv").config();

const { pool } = require("../config/db");
const {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} = require("@aws-sdk/client-s3");

const REQUIRED_CONFIRM = "DELETE_ALL_DATA_AND_S3";

function assertSafeTargetDb() {
  const url = String(process.env.DATABASE_URL || "");
  if (!url) {
    throw new Error("DATABASE_URL is not set");
  }
  const local =
    url.includes("localhost") ||
    url.includes("127.0.0.1") ||
    url.includes("host.docker.internal");
  if (!local && process.env.ALLOW_REMOTE_WIPE !== "true") {
    throw new Error(
      "Refusing non-local DATABASE_URL. Set ALLOW_REMOTE_WIPE=true if you intend to wipe this server."
    );
  }
}

async function truncateAllPublicTables(client) {
  const { rows } = await client.query(`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename NOT IN ('spatial_ref_sys')
    ORDER BY tablename
  `);
  const tables = rows.map((r) => r.tablename).filter(Boolean);
  if (tables.length === 0) {
    console.log("No public tables found.");
    return;
  }
  const list = tables.map((t) => {
    const safe = String(t).replace(/"/g, '""');
    return `"${safe}"`;
  });
  await client.query(`TRUNCATE TABLE ${list.join(", ")} CASCADE`);
  console.log(`Truncated ${tables.length} table(s).`);
}

async function emptyS3MediaBucket() {
  const region = process.env.AWS_REGION || "ap-south-1";
  const bucket = process.env.S3_MEDIA_BUCKET || "dater-media-vault-2026";
  const client = new S3Client({ region });
  let continuationToken;
  let deleted = 0;
  // Paginate and delete in batches of up to 1000 keys (S3 limit).
  do {
    const listOut = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        ContinuationToken: continuationToken,
        MaxKeys: 1000,
      })
    );
    const contents = listOut.Contents || [];
    if (contents.length > 0) {
      await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: {
            Objects: contents.map((o) => ({ Key: o.Key })),
            Quiet: true,
          },
        })
      );
      deleted += contents.length;
    }
    continuationToken = listOut.IsTruncated ? listOut.NextContinuationToken : undefined;
  } while (continuationToken);
  console.log(`Removed ${deleted} object(s) from s3://${bucket} (${region}).`);
}

async function main() {
  if (process.env.WIPE_ALL_DATA_CONFIRM !== REQUIRED_CONFIRM) {
    console.error(
      `Refusing to run. Export WIPE_ALL_DATA_CONFIRM=${REQUIRED_CONFIRM} and run from backend/ with .env loaded.`
    );
    process.exitCode = 1;
    return;
  }

  assertSafeTargetDb();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await truncateAllPublicTables(client);
    await client.query("COMMIT");
    console.log("PostgreSQL: all application tables truncated.");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
    await pool.end();
  }

  await emptyS3MediaBucket();
  console.log("Done.");
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
