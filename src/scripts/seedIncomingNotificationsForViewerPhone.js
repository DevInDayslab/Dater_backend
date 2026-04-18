/**
 * Seeds ~25 synthetic users (distinct phone range) who each send the viewer
 * one pending friend interaction: alternating plain REQUEST vs COMMENT_REQUEST.
 *
 * Reuses feed-compatible profile rows from seedFeedProfilesForViewerPhone so
 * listIncomingFriendRequests (gender filter + primary photo) returns them.
 *
 * After profiles are committed, uses the same service calls as the feed API:
 * social.sendFriendRequest(senderId, viewerId) and sendCommentRequest(...),
 * including notification_events and paid-comment debit (senders get a small
 * comment-wallet top-up first so COMMENT_REQUEST succeeds).
 *
 * From backend/:
 *   npm run seed:notifications:viewer -- 9354120990
 *   npm run seed:notifications:viewer -- 9354120990 30
 *   npm run seed:notifications:viewer -- 9354120990 30 20 10
 *
 * Removes prior batch: phone_e164 LIKE '+91988773_____' (see NOTIF_PHONE_PREFIX).
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

/** 6-digit national prefix; full numbers +91 + prefix + 5-digit index (does not overlap feed seed 988770). */
const NOTIF_PHONE_PREFIX = "988773";

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
  // Every third comment is intentionally long (close to 150 chars) for UI stress testing.
  if (i % 3 !== 0) return base;
  const suffix =
    " Thoughtful people, direct communication, and a little humor make conversations better; if you are open, I'd enjoy getting to know you.";
  const raw = `${base} ${suffix}`.trim();
  return raw.length <= 150 ? raw : raw.slice(0, 150);
}

async function deleteNotifSeedBatch(client) {
  await client.query(`DELETE FROM users WHERE phone_e164 LIKE $1`, [`+91${NOTIF_PHONE_PREFIX}%`]);
}

/** Same path as feed: sendCommentRequest debits one paid comment from sender. */
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

    await deleteNotifSeedBatch(client);

    const staged = [];
    for (let i = 1; i <= totalSenders; i += 1) {
      const profile = await upsertCompatibleCandidate(client, viewer, i, {
        phonePrefix: NOTIF_PHONE_PREFIX,
      });
      staged.push({ profile, index: i });
    }

    await client.query("COMMIT");
    profileTransactionCommitted = true;

    const viewerId = viewer.id;
    const { pool } = require("../config/db");
    const { sendFriendRequest, sendCommentRequest } = require("../services/social.service");

    const created = [];
    for (const { profile, index } of staged) {
      const asComment = index > normalCount;
      const commentText = asComment ? buildCommentText(index) : null;
      if (asComment) {
        await grantSenderCommentCredits(pool, profile.userId);
        await sendCommentRequest(profile.userId, viewerId, commentText);
      } else {
        await sendFriendRequest(profile.userId, viewerId);
      }
      created.push({
        fromUserId: profile.userId,
        phone: profile.phone_e164,
        name: profile.name,
        interactionType: asComment ? "COMMENT_REQUEST" : "REQUEST",
        commentPreview: commentText,
      });
    }

    console.log(
      JSON.stringify(
        {
          success: true,
          viewerPhone: phoneE164,
          viewerId,
          seededSenders: created.length,
          requestedSplit: { normalCount, commentCount },
          requestCount: created.filter((r) => r.interactionType === "REQUEST").length,
          commentRequestCount: created.filter((r) => r.interactionType === "COMMENT_REQUEST").length,
          note:
            "Ensured viewer has Woman/Man/Nonbinary in user_filter_preferred_genders (missing only). " +
            `Removed any prior +91${NOTIF_PHONE_PREFIX}_____ seed users before insert. ` +
            "Interactions created via sendFriendRequest / sendCommentRequest (same as feed API).",
          senders: created,
        },
        null,
        2
      )
    );
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
