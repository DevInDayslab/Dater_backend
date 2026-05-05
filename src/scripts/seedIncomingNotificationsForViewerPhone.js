/**
 * Seeds a fixed pool of synthetic “power user” profiles (default 50) that send
 * incoming friend interactions to whichever viewer phone you pass in.
 *
 * - Profiles are upserted by phone_e164 (ON CONFLICT in upsertCompatibleCandidate);
 *   we never DELETE synthetic users, so bots stay stable across runs and other
 *   viewers keep valid sender rows.
 * - For each bot → viewer pair: if a PENDING REQUEST/COMMENT_REQUEST already
 *   exists, or the pair is already friends, we skip (no duplicate constraint
 *   errors, no nuking relationships).
 * - Otherwise we call the same APIs as production: sendFriendRequest /
 *   sendCommentRequest (plus comment-wallet top-up for COMMENT_REQUEST).
 *
 * From backend/:
 *   npm run seed:notifications:viewer -- 9354120990
 *   npm run seed:notifications:viewer -- 9354120990 50 25 25
 *   npm run seed:notifications:viewer -- 9354120990 50 25 25 98873   # optional 5–6 digit bot pool prefix
 *
 * Default bot pool uses phonePrefix 98873 → +919887300001 … +919887300050
 * (does not overlap feed seed +91988770…).
 */
require("dotenv").config();
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const { Client } = require("pg");
const {
  toE164,
  ensureUserFiltersRow,
  syncViewerInclusivePreferredGenders,
  upsertCompatibleCandidate,
} = require("./seedFeedProfilesForViewerPhone");

/** 5-digit prefix recommended: +91 + prefix + 5-digit index = 10-digit numbers. */
const DEFAULT_NOTIF_BOT_POOL_PREFIX = "98873";

function parseBotPoolPrefixOverride(argv6) {
  if (argv6 == null) return null;
  const s = String(argv6).trim();
  if (/^\d{5}$/.test(s) || /^\d{6}$/.test(s)) return s;
  return null;
}

const COMMENT_SAMPLES = [
  "Loved your prompts — would love to chat sometime.",
  "Hey! We’re into the same music; mind connecting?",
  "Your photos made me smile. Coffee sometime?",
  "Hi — I’m new here and your profile stood out.",
  "That travel answer was great. Any tips for Goa?",
  "Sent you a request after reading your bio :)",
  "Would love to hear more about your startup journey.",
  "Your dog pics won me over instantly.",
  "Same hometown! Small world — say hi?",
  "Commenting because your vibe feels genuine.",
  "Big fan of your taste in books — recommendations?",
  "Weekend hiking crew? I’m always looking for partners.",
  "Your sense of humor in prompts is A+.",
  "Not great at openers but here goes — hi!",
  "Friend request + a note: you seem really grounded.",
];

function pickComment(i) {
  return COMMENT_SAMPLES[(i - 1) % COMMENT_SAMPLES.length];
}

function buildCommentText(i) {
  const base = pickComment(i);
  if (i % 3 !== 0) return base;
  const suffix =
    " Thoughtful people, direct communication, and a little humor make conversations better; if you are open, I'd enjoy getting to know you.";
  const raw = `${base} ${suffix}`.trim();
  return raw.length <= 150 ? raw : raw.slice(0, 150);
}

async function grantSenderCommentCredits(pool, userId) {
  await pool.query(
    `INSERT INTO user_comment_wallet (user_id, remaining_paid_comments, updated_at)
     VALUES ($1, 50, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       remaining_paid_comments = user_comment_wallet.remaining_paid_comments + 50,
       updated_at = NOW()`,
    [userId]
  );
}

function orderedPair(a, b) {
  return a < b ? [a, b] : [b, a];
}

async function alreadyFriends(pool, userIdA, userIdB) {
  const [u1, u2] = orderedPair(userIdA, userIdB);
  const r = await pool.query(
    `SELECT 1 FROM friendships WHERE u1_id = $1 AND u2_id = $2 LIMIT 1`,
    [u1, u2]
  );
  return r.rowCount > 0;
}

async function hasPendingOutgoingRequest(pool, senderId, targetId) {
  const r = await pool.query(
    `SELECT 1 FROM user_interactions
     WHERE user_id = $1
       AND target_id = $2
       AND interaction_type IN ('REQUEST', 'COMMENT_REQUEST')
       AND request_status = 'PENDING'
     LIMIT 1`,
    [senderId, targetId]
  );
  return r.rowCount > 0;
}

async function main() {
  const rawPhone = process.argv[2] || "9354120990";
  const phoneE164 = toE164(rawPhone);
  const rawCount = process.argv[3];
  const parsed = rawCount != null ? Number.parseInt(String(rawCount), 10) : 25;
  const senderCount = Number.isFinite(parsed) ? Math.min(60, Math.max(1, parsed)) : 25;
  const rawNormal = process.argv[4];
  const rawComment = process.argv[5];
  const parsedNormal = rawNormal != null ? Number.parseInt(String(rawNormal), 10) : NaN;
  const parsedComment = rawComment != null ? Number.parseInt(String(rawComment), 10) : NaN;
  const hasSplit = Number.isFinite(parsedNormal) && Number.isFinite(parsedComment);
  const normalCount = hasSplit ? Math.max(0, parsedNormal) : Math.ceil(senderCount * 0.5);
  const commentCount = hasSplit ? Math.max(0, parsedComment) : senderCount - normalCount;
  const totalSenders = Math.min(60, Math.max(1, normalCount + commentCount));

  const botPoolPrefix = parseBotPoolPrefixOverride(process.argv[6]) ?? DEFAULT_NOTIF_BOT_POOL_PREFIX;

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  let profileTransactionCommitted = false;
  try {
    await client.query("BEGIN");

    const vRes = await client.query(
      `SELECT u.id,
              u.name,
              u.age_years,
              u.gender_main,
              u.living_in_city,
              u.living_in_city_mode,
              u.is_verified,
              (u.location IS NOT NULL) AS has_location,
              ST_X(u.location::geometry) AS lng,
              ST_Y(u.location::geometry) AS lat,
              uf.distance_pref_km,
              uf.age_min,
              uf.age_max,
              uf.expand_age_range,
              uf.expand_distance,
              uf.only_verified_profiles,
              uf.preferred_location_city
       FROM users u
       LEFT JOIN user_filters uf ON uf.user_id = u.id
       WHERE u.phone_e164 = $1
         AND u.deleted_at IS NULL
       LIMIT 1`,
      [phoneE164]
    );

    if (vRes.rows.length === 0) {
      throw new Error(`No user found for phone_e164=${phoneE164}`);
    }

    const viewer = vRes.rows[0];
    viewer.expand_age_range = viewer.expand_age_range === true;
    viewer.expand_distance = viewer.expand_distance === true;
    viewer.only_verified_profiles = viewer.only_verified_profiles === true;

    await ensureUserFiltersRow(client, viewer.id);
    await syncViewerInclusivePreferredGenders(client, viewer.id);

    const ufRes = await client.query(
      `SELECT distance_pref_km, age_min, age_max, expand_age_range, expand_distance,
              only_verified_profiles, preferred_location_city
       FROM user_filters WHERE user_id = $1 LIMIT 1`,
      [viewer.id]
    );
    if (ufRes.rows[0]) {
      Object.assign(viewer, ufRes.rows[0]);
      viewer.expand_age_range = viewer.expand_age_range === true;
      viewer.expand_distance = viewer.expand_distance === true;
      viewer.only_verified_profiles = viewer.only_verified_profiles === true;
    }

    const staged = [];
    for (let i = 1; i <= totalSenders; i += 1) {
      const profile = await upsertCompatibleCandidate(client, viewer, i, {
        phonePrefix: botPoolPrefix,
      });
      staged.push({ profile, index: i });
    }

    await client.query("COMMIT");
    profileTransactionCommitted = true;

    const viewerId = viewer.id;
    const { pool } = require("../config/db");
    const { emitUnreadCountsUpdated } = require("../services/websocket.service");
    const { sendFriendRequest, sendCommentRequest } = require("../services/social.service");

    const results = [];
    let sentCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    for (const { profile, index } of staged) {
      const senderId = profile.userId;
      const asComment = index > normalCount;
      const interactionType = asComment ? "COMMENT_REQUEST" : "REQUEST";
      const commentText = asComment ? buildCommentText(index) : null;

      const pending = await hasPendingOutgoingRequest(pool, senderId, viewerId);
      if (pending) {
        skippedCount += 1;
        results.push({
          index,
          fromUserId: senderId,
          phone: profile.phone_e164,
          name: profile.name,
          interactionType,
          outcome: "skipped",
          reason: "PENDING_REQUEST_ALREADY_EXISTS",
        });
        continue;
      }

      const friends = await alreadyFriends(pool, senderId, viewerId);
      if (friends) {
        skippedCount += 1;
        results.push({
          index,
          fromUserId: senderId,
          phone: profile.phone_e164,
          name: profile.name,
          interactionType,
          outcome: "skipped",
          reason: "ALREADY_FRIENDS",
        });
        continue;
      }

      try {
        if (asComment) {
          await grantSenderCommentCredits(pool, senderId);
          await sendCommentRequest(senderId, viewerId, commentText);
        } else {
          await sendFriendRequest(senderId, viewerId);
        }
        emitUnreadCountsUpdated(viewerId).catch(() => {});
        sentCount += 1;
        results.push({
          index,
          fromUserId: senderId,
          phone: profile.phone_e164,
          name: profile.name,
          interactionType,
          commentPreview: commentText,
          outcome: "sent",
        });
      } catch (err) {
        failedCount += 1;
        const code = err.code || err.message;
        results.push({
          index,
          fromUserId: senderId,
          phone: profile.phone_e164,
          name: profile.name,
          interactionType,
          outcome: "failed",
          error: String(err.message || err),
          code: typeof code === "string" ? code : undefined,
        });
      }
    }

    console.log(
      JSON.stringify(
        {
          success: failedCount === 0,
          viewerPhone: phoneE164,
          viewerId,
          botPoolPrefix,
          prefixSource: parseBotPoolPrefixOverride(process.argv[6]) ? "argv[6] override" : "default pool",
          profileUpsertCount: staged.length,
          requestedSplit: { normalCount, commentCount },
          summary: {
            sent: sentCount,
            skipped: skippedCount,
            failed: failedCount,
          },
          requestCount: results.filter((r) => r.interactionType === "REQUEST" && r.outcome === "sent").length,
          commentRequestCount: results.filter(
            (r) => r.interactionType === "COMMENT_REQUEST" && r.outcome === "sent"
          ).length,
          note:
            "Synthetic users are upserted by phone (never deleted). Sends are skipped when a PENDING " +
            "REQUEST/COMMENT_REQUEST already exists or the pair is already friends. " +
            "Uses sendFriendRequest / sendCommentRequest (same as feed API).",
          results,
        },
        null,
        2
      )
    );
    if (failedCount > 0) {
      process.exitCode = 1;
    }
  } catch (e) {
    if (!profileTransactionCommitted) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {
        /* ignore */
      }
    }
    console.error("seedIncomingNotificationsForViewerPhone failed:", e.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();
