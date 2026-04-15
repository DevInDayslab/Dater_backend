#!/usr/bin/env node
/**
 * Times loading profile photos referenced in user_photos.
 *
 * Default: HTTP GET of photo_url (what an anonymous client does).
 *   If the bucket is private, you will see HTTP 403 — the URL is not publicly readable.
 *
 *   node src/scripts/benchmarkProfilePhotoLoads.js --s3-sdk
 *   Uses the same AWS credentials as the API (GetObject by s3_key) — measures real object read time.
 *
 * Usage:
 *   cd backend && node src/scripts/benchmarkProfilePhotoLoads.js
 *   node src/scripts/benchmarkProfilePhotoLoads.js --user=<uuid>
 *   node src/scripts/benchmarkProfilePhotoLoads.js --include-pending
 *   node src/scripts/benchmarkProfilePhotoLoads.js --parallel
 *   node src/scripts/benchmarkProfilePhotoLoads.js --limit=20
 *   node src/scripts/benchmarkProfilePhotoLoads.js --s3-sdk [--parallel]
 *
 * Requires DATABASE_URL. --s3-sdk also needs AWS credentials + S3_MEDIA_BUCKET (same as API).
 */
require("dotenv").config();

const { performance } = require("perf_hooks");
const { pool, query } = require("../config/db");
const s3Media = require("../services/s3Media.service");

function parseArgs() {
  const out = {
    userId: null,
    includePending: false,
    parallel: false,
    limit: null,
    s3Sdk: false,
  };
  for (const a of process.argv.slice(2)) {
    if (a === "--include-pending") out.includePending = true;
    else if (a === "--parallel") out.parallel = true;
    else if (a === "--s3-sdk") out.s3Sdk = true;
    else if (a.startsWith("--user=")) out.userId = a.slice("--user=".length).trim();
    else if (a.startsWith("--limit=")) out.limit = Math.max(1, parseInt(a.slice("--limit=".length), 10) || 0);
  }
  return out;
}

async function fetchTimingsHttp(url) {
  const t0 = performance.now();
  const res = await fetch(url, { redirect: "follow" });
  const tHeaders = performance.now();
  const buf = await res.arrayBuffer();
  const tEnd = performance.now();
  return {
    ok: res.ok,
    status: res.status,
    ttfbMs: tHeaders - t0,
    downloadMs: tEnd - tHeaders,
    totalMs: tEnd - t0,
    bytes: buf.byteLength,
  };
}

async function fetchTimingsS3(key) {
  const t0 = performance.now();
  const buf = await s3Media.getObjectBytes(key);
  const tEnd = performance.now();
  const getMs = tEnd - t0;
  return {
    ok: true,
    status: 200,
    /** Full GetObject (request + stream to EOF); not split like browser TTFB. */
    getMs,
    ttfbMs: getMs,
    downloadMs: 0,
    totalMs: getMs,
    bytes: buf.length,
  };
}

function fmtMs(n) {
  if (Number.isNaN(n)) return "     ---";
  return n.toFixed(1).padStart(8);
}

async function main() {
  const opts = parseArgs();

  const parts = ["deleted_at IS NULL"];
  const params = [];
  let i = 1;
  if (!opts.includePending) {
    parts.push("moderation_status = 'APPROVED'");
  }
  if (opts.userId) {
    parts.push(`user_id = $${i++}`);
    params.push(opts.userId);
  }
  let sql = `
    SELECT id, user_id, photo_order, moderation_status, photo_url, s3_key
    FROM user_photos
    WHERE ${parts.join(" AND ")}
    ORDER BY uploaded_at DESC NULLS LAST, id
  `;
  if (opts.limit) {
    sql += ` LIMIT $${i}`;
    params.push(opts.limit);
  }

  const { rows } = await query(sql.trim(), params);
  if (rows.length === 0) {
    console.log("No rows matched (check --user / flags / DB).");
    await pool.end();
    return;
  }

  const mode = opts.s3Sdk ? "S3 GetObject (SDK)" : "HTTP GET photo_url";
  console.log(`Rows: ${rows.length} | ${mode} | ${opts.parallel ? "parallel" : "sequential"}\n`);

  if (!opts.s3Sdk) {
    console.log(
      "Note: If every row is HTTP 403, objects are private. Use --s3-sdk to time reads with AWS credentials,\n" +
        "      or serve images via CloudFront / presigned GET URLs for clients.\n"
    );
  }

  const header = opts.s3Sdk
    ? ["order", "mod", "get_ms", "bytes", "kb", "photo_id", "user_id"].join("\t")
    : ["order", "mod", "http", "ttfb_ms", "body_ms", "total_ms", "bytes", "photo_id"].join("\t");
  console.log(header);

  const results = [];
  const wallStart = performance.now();

  async function oneRow(r) {
    if (opts.s3Sdk) {
      if (!r.s3_key) {
        return {
          r,
          t: null,
          err: new Error("missing s3_key"),
        };
      }
      try {
        const t = await fetchTimingsS3(r.s3_key);
        return { r, t, err: null };
      } catch (e) {
        return { r, t: null, err: e };
      }
    }
    try {
      const t = await fetchTimingsHttp(r.photo_url);
      return { r, t, err: null };
    } catch (e) {
      return { r, t: null, err: e };
    }
  }

  if (opts.parallel) {
    const settled = await Promise.all(rows.map((r, idx) => oneRow(r).then((x) => ({ ...x, idx }))));
    settled.sort((a, b) => a.idx - b.idx);
    for (const { r, t, err } of settled) {
      if (err) {
        const errLine = opts.s3Sdk
          ? `${r.photo_order}\t${r.moderation_status}\t---\t---\t---\t${r.id}\t${r.user_id}`
          : `${r.photo_order}\t${r.moderation_status}\t---\t---\t---\t---\t---\t${r.id}`;
        console.log(`${errLine}\n  ERR ${err.message}`);
        results.push({ httpFailed: true });
      } else if (opts.s3Sdk) {
        const kb = (t.bytes / 1024).toFixed(1);
        console.log(
          `${r.photo_order}\t${r.moderation_status}\t${fmtMs(t.getMs ?? t.totalMs)}\t${t.bytes}\t${kb}\t${r.id}\t${r.user_id}`
        );
        results.push(t);
      } else {
        console.log(
          `${r.photo_order}\t${r.moderation_status}\t${t.status}\t${fmtMs(t.ttfbMs)}\t${fmtMs(t.downloadMs)}\t${fmtMs(t.totalMs)}\t${t.bytes}\t${r.id}`
        );
        results.push(t);
      }
    }
  } else {
    for (const r of rows) {
      const { t, err } = await oneRow(r);
      if (err) {
        const errLine = opts.s3Sdk
          ? `${r.photo_order}\t${r.moderation_status}\t---\t---\t---\t${r.id}\t${r.user_id}`
          : `${r.photo_order}\t${r.moderation_status}\t---\t---\t---\t---\t---\t${r.id}`;
        console.log(`${errLine}\n  ERR ${err.message}`);
        results.push({ httpFailed: true });
      } else if (opts.s3Sdk) {
        const kb = (t.bytes / 1024).toFixed(1);
        console.log(
          `${r.photo_order}\t${r.moderation_status}\t${fmtMs(t.getMs ?? t.totalMs)}\t${t.bytes}\t${kb}\t${r.id}\t${r.user_id}`
        );
        results.push(t);
      } else {
        console.log(
          `${r.photo_order}\t${r.moderation_status}\t${t.status}\t${fmtMs(t.ttfbMs)}\t${fmtMs(t.downloadMs)}\t${fmtMs(t.totalMs)}\t${t.bytes}\t${r.id}`
        );
        results.push(t);
      }
    }
  }

  const wallMs = performance.now() - wallStart;
  const httpOk = results.filter((t) => t && t.ok === true && !t.httpFailed);
  const http403 = results.filter((t) => t && t.ok === false && t.status === 403);
  const otherFail = results.filter(
    (t) => t && !t.httpFailed && t.ok === false && t.status !== 403
  );
  const networkErr = results.filter((t) => t && t.httpFailed);

  console.log("\n--- Summary ---");
  if (opts.s3Sdk) {
    console.log(`S3 GetObject OK:           ${httpOk.length} / ${rows.length}`);
  } else {
    console.log(`HTTP 2xx (image body):   ${httpOk.length} / ${rows.length}`);
  }
  if (http403.length) {
    console.log(`HTTP 403 (access denied):  ${http403.length}  ← bucket/objects not public for these URLs`);
  }
  if (otherFail.length) {
    console.log(`Other non-2xx:            ${otherFail.length}`);
  }
  if (networkErr.length) {
    console.log(`Fetch errors:             ${networkErr.length}`);
  }
  console.log(`Wall clock (this run):     ${wallMs.toFixed(1)} ms`);

  if (httpOk.length) {
    const sumTotal = httpOk.reduce((s, t) => s + t.totalMs, 0);
    const maxTotal = Math.max(...httpOk.map((t) => t.totalMs));
    if (opts.s3Sdk) {
      const sumBytes = httpOk.reduce((s, t) => s + t.bytes, 0);
      console.log(`Sum GetObject time:        ${sumTotal.toFixed(1)} ms  (sequential)`);
      console.log(`Total bytes read:        ${sumBytes} (${(sumBytes / 1024).toFixed(1)} KB)`);
      console.log(`Slowest GetObject:         ${maxTotal.toFixed(1)} ms`);
      console.log(`Avg GetObject:             ${(sumTotal / httpOk.length).toFixed(1)} ms`);
    } else {
      const sumTtfb = httpOk.reduce((s, t) => s + t.ttfbMs, 0);
      console.log(`Sum TTFB (where split):    ${sumTtfb.toFixed(1)} ms`);
      console.log(`Sum full round-trips:      ${sumTotal.toFixed(1)} ms`);
      console.log(`Slowest single object:     ${maxTotal.toFixed(1)} ms`);
      console.log(`Avg full round-trip:       ${(sumTotal / httpOk.length).toFixed(1)} ms`);
    }
  } else if (!opts.s3Sdk && http403.length === rows.length) {
    console.log("\nTip: run with --s3-sdk to time GetObject using server AWS credentials (ignores public URL).");
  }

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
