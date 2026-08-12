/**
 * Apple App Review demo account — fully enriched, verified, premium test user.
 *
 * Reads phone from APPLE_DEMO_PHONE (or CLI override). Creates the account if missing.
 *
 * From backend/:
 *   npm run seed:demo
 *   npm run seed:demo -- +919876543210
 *
 * Requires DATABASE_URL in .env. Phone from APPLE_DEMO_PHONE or CLI.
 * Login OTP for that phone is fixed at APPLE_DEMO_OTP (default 765290) — no SMS required.
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const { randomUUID } = require("crypto");
const { pool, query } = require("../config/db");
const socialService = require("../services/social.service");
const chatService = require("../services/chat.service");
const { syncPeriodicGrants } = require("../services/periodicGrants.service");
const {
  ensureUserFiltersRow,
  syncViewerInclusivePreferredGenders,
} = require("./seedFeedProfilesForViewerPhone");

const MOCK_PHONE_PREFIX = "98881";
const DEMO_BIO =
  "Exploring new connections in the city. Big fan of travel, live music, and good coffee!";

const MOCK_FRIENDS = [
  { index: 1, name: "Sarah", age: 25, role: "friend_chat" },
  { index: 2, name: "Riya", age: 24, role: "pending_comment" },
  { index: 3, name: "Priya", age: 23, role: "friend_unread_chat" },
  { index: 4, name: "Ananya", age: 26, role: "pending_request" },
];

function toE164(raw) {
  const s = String(raw || "").trim().replace(/\s/g, "");
  if (s.startsWith("+")) return s;
  const digits = s.replace(/\D/g, "");
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  if (digits.length > 0) return `+${digits}`;
  return s;
}

function phonePartsFromE164(phoneE164) {
  const digits = String(phoneE164).replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) {
    return { country: "+91", number: digits.slice(2), phoneE164: `+${digits}` };
  }
  if (digits.length === 10) {
    return { country: "+91", number: digits, phoneE164: `+91${digits}` };
  }
  const country = phoneE164.startsWith("+") ? phoneE164.slice(0, phoneE164.length - digits.length) : "+";
  return { country: country || "+91", number: digits, phoneE164 };
}

function mockPhoneE164(index) {
  return `+91${MOCK_PHONE_PREFIX}${String(index).padStart(5, "0")}`;
}

function demoPhotoUrl(slot) {
  return `https://picsum.photos/seed/dater-apple-demo-${slot}/1080/1350`;
}

function mockPhotoUrl(friendIndex, slot) {
  return `https://picsum.photos/seed/dater-apple-mock-${friendIndex}-${slot}/1080/1350`;
}

async function upsertDemoUser(phoneE164) {
  const { country, number } = phonePartsFromE164(phoneE164);
  const userRes = await query(
    `INSERT INTO users (
       id, phone_country_code, phone_number, phone_e164,
       is_phone_verified, name, age_years, date_of_birth,
       gender, gender_main, bio,
       is_verified, verified_at,
       account_state, location, location_granted,
       onboarding_step, onboarding_completed_at,
       profile_completion_percentage, living_in_city, living_in_city_mode,
       notifications_granted,
       terms_accepted_at, privacy_accepted_at, be_kind_accepted_at,
       created_at, updated_at, last_active_at
     ) VALUES (
       $1, $2, $3, $4,
       TRUE, 'Alex', 24, CURRENT_DATE - INTERVAL '24 years',
       'Man', 'Man', $5,
       TRUE, NOW(),
       'ACTIVE', ST_SetSRID(ST_MakePoint(77.209::double precision, 28.6139::double precision), 4326), TRUE,
       'main', NOW(),
       95, 'Delhi, DL', 'FOLLOW_DEVICE',
       TRUE,
       NOW(), NOW(), NOW(),
       NOW(), NOW(), NOW()
     )
     ON CONFLICT (phone_e164) DO UPDATE SET
       name = EXCLUDED.name,
       age_years = EXCLUDED.age_years,
       date_of_birth = EXCLUDED.date_of_birth,
       gender = EXCLUDED.gender,
       gender_main = EXCLUDED.gender_main,
       bio = EXCLUDED.bio,
       is_phone_verified = TRUE,
       is_verified = TRUE,
       verified_at = NOW(),
       account_state = 'ACTIVE',
       location = EXCLUDED.location,
       location_granted = TRUE,
       onboarding_step = 'main',
       onboarding_completed_at = COALESCE(users.onboarding_completed_at, NOW()),
       profile_completion_percentage = EXCLUDED.profile_completion_percentage,
       living_in_city = EXCLUDED.living_in_city,
       living_in_city_mode = EXCLUDED.living_in_city_mode,
       notifications_granted = TRUE,
       terms_accepted_at = COALESCE(users.terms_accepted_at, NOW()),
       privacy_accepted_at = COALESCE(users.privacy_accepted_at, NOW()),
       be_kind_accepted_at = COALESCE(users.be_kind_accepted_at, NOW()),
       updated_at = NOW(),
       last_active_at = NOW()
     RETURNING id`,
    [randomUUID(), country, number, phoneE164, DEMO_BIO]
  );
  return userRes.rows[0].id;
}

async function seedDemoProfileExtras(demoUserId) {
  await ensureUserFiltersRow(pool, demoUserId);
  await syncViewerInclusivePreferredGenders(pool, demoUserId);

  await query(
    `UPDATE user_filters
     SET distance_pref_km = 50,
         age_min = 18,
         age_max = 80,
         expand_age_range = TRUE,
         expand_distance = TRUE,
         only_verified_profiles = FALSE,
         preferred_location_city = 'Delhi, DL',
         show_other_people_if_run_out = TRUE,
         updated_at = NOW()
     WHERE user_id = $1`,
    [demoUserId]
  );

  await query(`DELETE FROM user_dating_preferences WHERE user_id = $1`, [demoUserId]);
  await query(
    `INSERT INTO user_dating_preferences (user_id, preferred_gender) VALUES ($1, 'Woman')`,
    [demoUserId]
  );

  for (const interest of ["Travel", "Music", "Coffee", "Live music"]) {
    await query(
      `INSERT INTO user_interests (user_id, interest) VALUES ($1, $2)
       ON CONFLICT (user_id, interest) DO NOTHING`,
      [demoUserId, interest]
    );
  }

  await query(`DELETE FROM user_looking_for WHERE user_id = $1`, [demoUserId]);
  await query(
    `INSERT INTO user_looking_for (user_id, looking_for_option) VALUES ($1, 'Hangout, casual meet-up')`,
    [demoUserId]
  );

  await query(
    `INSERT INTO user_notification_preferences (
       user_id,
       push_friend_request_received, push_friend_request_accepted, push_chat_dm, push_comment,
       inapp_friend_request_received, inapp_friend_request_accepted, inapp_chat_dm, inapp_comment
     ) VALUES ($1, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE)
     ON CONFLICT (user_id) DO UPDATE SET
       push_friend_request_received = TRUE,
       push_friend_request_accepted = TRUE,
       push_chat_dm = TRUE,
       push_comment = TRUE,
       inapp_friend_request_received = TRUE,
       inapp_friend_request_accepted = TRUE,
       inapp_chat_dm = TRUE,
       inapp_comment = TRUE,
       updated_at = NOW()`,
    [demoUserId]
  );
}

async function seedUserPhotos(userId, photoUrls) {
  await query(
    `UPDATE user_photos SET deleted_at = NOW()
     WHERE user_id = $1 AND deleted_at IS NULL`,
    [userId]
  );
  for (let i = 0; i < photoUrls.length; i += 1) {
    const order = i + 1;
    await query(
      `INSERT INTO user_photos (user_id, photo_url, photo_order, is_primary, moderation_status, uploaded_at)
       VALUES ($1, $2, $3, $4, 'APPROVED', NOW())`,
      [userId, photoUrls[i], order, order === 1]
    );
  }
}

async function upsertMockFriend({ index, name, age }) {
  const phoneE164 = mockPhoneE164(index);
  const { country, number } = phonePartsFromE164(phoneE164);
  const userRes = await query(
    `INSERT INTO users (
       id, phone_country_code, phone_number, phone_e164,
       is_phone_verified, name, age_years, date_of_birth,
       gender, gender_main,
       is_verified, verified_at,
       account_state, location, location_granted,
       onboarding_step, onboarding_completed_at,
       profile_completion_percentage, living_in_city, living_in_city_mode,
       created_at, updated_at, last_active_at
     ) VALUES (
       $1, $2, $3, $4,
       TRUE, $5, $6::smallint, CURRENT_DATE - make_interval(years => $6::int),
       'Woman', 'Woman',
       TRUE, NOW(),
       'ACTIVE', ST_SetSRID(ST_MakePoint(77.215::double precision, 28.620::double precision), 4326), TRUE,
       'main', NOW(),
       88, 'Delhi, DL', 'FOLLOW_DEVICE',
       NOW(), NOW(), NOW()
     )
     ON CONFLICT (phone_e164) DO UPDATE SET
       name = EXCLUDED.name,
       age_years = EXCLUDED.age_years,
       gender = EXCLUDED.gender,
       gender_main = EXCLUDED.gender_main,
       is_verified = TRUE,
       verified_at = NOW(),
       account_state = 'ACTIVE',
       location = EXCLUDED.location,
       location_granted = TRUE,
       onboarding_completed_at = COALESCE(users.onboarding_completed_at, NOW()),
       profile_completion_percentage = EXCLUDED.profile_completion_percentage,
       updated_at = NOW(),
       last_active_at = NOW()
     RETURNING id`,
    [randomUUID(), country, number, phoneE164, name, age]
  );
  const userId = userRes.rows[0].id;
  await seedUserPhotos(userId, [mockPhotoUrl(index, 1), mockPhotoUrl(index, 2)]);

  await ensureUserFiltersRow(pool, userId);
  await query(`DELETE FROM user_dating_preferences WHERE user_id = $1`, [userId]);
  await query(
    `INSERT INTO user_dating_preferences (user_id, preferred_gender) VALUES ($1, 'Man')`,
    [userId]
  );

  return { userId, name, phoneE164 };
}

async function grantPremium(demoUserId) {
  const expiresRes = await query(
    `UPDATE users
     SET premium_started_at = NOW(),
         premium_expires_at = NOW() + INTERVAL '180 days',
         premium_plan_code = 'PREMIUM_THREE_MONTHS',
         premium_status = 'ACTIVE',
         is_premium = TRUE,
         updated_at = NOW()
     WHERE id = $1
     RETURNING premium_expires_at, premium_plan_code, is_premium`,
    [demoUserId]
  );
  const expiresAt = expiresRes.rows[0].premium_expires_at;

  await query(
    `INSERT INTO store_subscriptions (
       user_id, platform, store_product_id, purchase_token,
       expiry_time, auto_renewing, store_state, metadata, updated_at
     ) VALUES ($1, 'APP_STORE', 'com.dater.premium.planthree', 'apple_demo_seed', $2, TRUE, 'ACTIVE', '{}'::jsonb, NOW())
     ON CONFLICT (user_id, platform) DO UPDATE SET
       store_product_id = EXCLUDED.store_product_id,
       purchase_token = EXCLUDED.purchase_token,
       expiry_time = EXCLUDED.expiry_time,
       auto_renewing = TRUE,
       store_state = 'ACTIVE',
       updated_at = NOW()`,
    [demoUserId, expiresAt]
  );

  return expiresRes.rows[0];
}

async function grantConsumables(demoUserId) {
  await query(`DELETE FROM premium_boosts WHERE user_id = $1`, [demoUserId]);

  const boostWallet = await query(
    `INSERT INTO user_boost_wallet (user_id, remaining_credits, updated_at)
     VALUES ($1, 5, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       remaining_credits = 5,
       updated_at = NOW()
     RETURNING remaining_credits`,
    [demoUserId]
  );

  await query(
    `INSERT INTO premium_boosts (user_id, started_at, expires_at)
     VALUES ($1, NOW() - INTERVAL '30 seconds', NOW() + INTERVAL '30 minutes')`,
    [demoUserId]
  );

  const commentWallet = await query(
    `INSERT INTO user_comment_wallet (user_id, remaining_paid_comments, updated_at)
     VALUES ($1, 10, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       remaining_paid_comments = 10,
       updated_at = NOW()
     RETURNING remaining_paid_comments`,
    [demoUserId]
  );

  return {
    boostCredits: Number(boostWallet.rows[0]?.remaining_credits || 0),
    commentCredits: Number(commentWallet.rows[0]?.remaining_paid_comments || 0),
  };
}

async function cleanupDemoSocialGraph(demoUserId, mockUserIds) {
  await query(`DELETE FROM notification_events WHERE recipient_user_id = $1`, [demoUserId]);

  await query(
    `DELETE FROM user_interactions
     WHERE (user_id = $1 AND target_id = ANY($2::uuid[]))
        OR (user_id = ANY($2::uuid[]) AND target_id = $1)`,
    [demoUserId, mockUserIds]
  );

  await query(
    `DELETE FROM friendships
     WHERE (u1_id = $1 AND u2_id = ANY($2::uuid[]))
        OR (u1_id = ANY($2::uuid[]) AND u2_id = $1)`,
    [demoUserId, mockUserIds]
  );

  await query(
    `DELETE FROM chat_threads
     WHERE id IN (
       SELECT p1.thread_id
       FROM chat_thread_participants p1
       JOIN chat_thread_participants p2 ON p2.thread_id = p1.thread_id
       WHERE p1.user_id = $1
         AND p2.user_id = ANY($2::uuid[])
     )`,
    [demoUserId, mockUserIds]
  );
}

async function ensureAcceptedFriendWithChat(demoUserId, friendId, messages) {
  await socialService.sendFriendRequest(friendId, demoUserId);
  await socialService.respondToRequest(demoUserId, friendId, "ACCEPTED");
  const thread = await chatService.getOrCreateDirectThread(demoUserId, friendId);
  for (const { fromId, text } of messages) {
    await chatService.sendMessage(fromId, thread.threadId, text);
  }
  return thread.threadId;
}

async function grantMockCommentCredits(userId, credits) {
  await query(
    `INSERT INTO user_comment_wallet (user_id, remaining_paid_comments, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       remaining_paid_comments = GREATEST(user_comment_wallet.remaining_paid_comments, EXCLUDED.remaining_paid_comments),
       updated_at = NOW()`,
    [userId, credits]
  );
}

async function seedNotificationAuditRows(demoUserId, actorIds) {
  const { sarahId, riyaId, priyaId, ananyaId } = actorIds;

  await query(
    `INSERT INTO notification_events (recipient_user_id, actor_user_id, event_type, is_silent, is_read, read_at, created_at)
     VALUES
       ($1, $2, 'REQUEST_ACCEPTED', FALSE, TRUE, NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days'),
       ($1, $3, 'REQUEST_COMMENT_SENT', FALSE, TRUE, NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day'),
       ($1, $4, 'CHAT_MESSAGE', FALSE, FALSE, NULL, NOW() - INTERVAL '3 hours'),
       ($1, $5, 'REQUEST_SENT', FALSE, FALSE, NULL, NOW() - INTERVAL '1 hour')`,
    [demoUserId, sarahId, riyaId, priyaId, ananyaId]
  );
}

async function main() {
  const rawPhone = process.argv[2] || process.env.APPLE_DEMO_PHONE;
  if (!rawPhone || !String(rawPhone).trim()) {
    console.error("Set APPLE_DEMO_PHONE in backend/.env or pass a phone as CLI arg.");
    process.exit(2);
  }

  const phoneE164 = toE164(rawPhone);
  console.log(`Seeding Apple demo user for ${phoneE164}…`);

  const demoUserId = await upsertDemoUser(phoneE164);
  await seedDemoProfileExtras(demoUserId);
  await seedUserPhotos(
    demoUserId,
    [1, 2, 3, 4].map((slot) => demoPhotoUrl(slot))
  );

  const mockUsers = {};
  for (const spec of MOCK_FRIENDS) {
    const row = await upsertMockFriend(spec);
    mockUsers[spec.role] = row;
    mockUsers[spec.name.toLowerCase()] = row;
  }
  const mockUserIds = MOCK_FRIENDS.map((spec) => mockUsers[spec.role].userId);

  const premium = await grantPremium(demoUserId);
  const consumables = await grantConsumables(demoUserId);

  await cleanupDemoSocialGraph(demoUserId, mockUserIds);

  const sarah = mockUsers.friend_chat;
  const riya = mockUsers.pending_comment;
  const priya = mockUsers.friend_unread_chat;
  const ananya = mockUsers.pending_request;

  await ensureAcceptedFriendWithChat(demoUserId, sarah.userId, [
    { fromId: sarah.userId, text: "Hey Alex! Great to connect!" },
    { fromId: demoUserId, text: "Hey! How is your week going?" },
    { fromId: sarah.userId, text: "Pretty good — hope yours is too!" },
  ]);

  await ensureAcceptedFriendWithChat(demoUserId, priya.userId, [
    { fromId: demoUserId, text: "Hi Priya!" },
  ]);
  const priyaThread = await chatService.getOrCreateDirectThread(demoUserId, priya.userId);
  await chatService.sendMessage(priya.userId, priyaThread.threadId, "Priya sent you a new message!");

  await grantMockCommentCredits(riya.userId, 10);
  await socialService.sendCommentRequest(
    riya.userId,
    demoUserId,
    "Love your travel photos — would love to connect!"
  );

  await socialService.sendFriendRequest(ananya.userId, demoUserId);

  await seedNotificationAuditRows(demoUserId, {
    sarahId: sarah.userId,
    riyaId: riya.userId,
    priyaId: priya.userId,
    ananyaId: ananya.userId,
  });

  const grantClient = await pool.connect();
  try {
    const premiumRowRes = await grantClient.query(
      `SELECT id, is_premium, premium_status, premium_expires_at, premium_started_at, premium_plan_code
       FROM users WHERE id = $1`,
      [demoUserId]
    );
    await syncPeriodicGrants(grantClient, demoUserId, premiumRowRes.rows[0]);
  } finally {
    grantClient.release();
  }

  const [pendingNotifications, unreadChats, friendsRes] = await Promise.all([
    socialService.countPendingIncomingFriendRequests(demoUserId),
    chatService.countThreadsAwaitingViewerReply(demoUserId),
    query(
      `SELECT COUNT(*)::int AS c FROM friendships WHERE u1_id = $1 OR u2_id = $1`,
      [demoUserId]
    ),
  ]);

  const summary = {
    success: true,
    demoUserId,
    phoneE164,
    name: "Alex",
    premium: {
      isPremium: premium.is_premium,
      planCode: premium.premium_plan_code,
      expiresAt: premium.premium_expires_at,
    },
    consumables,
    mockFriends: MOCK_FRIENDS.map((spec) => ({
      name: spec.name,
      phone: mockPhoneE164(spec.index),
      userId: mockUsers[spec.role].userId,
      role: spec.role,
    })),
    friendsCount: friendsRes.rows[0]?.c ?? 0,
    pendingNotifications,
    unreadChats,
  };

  console.log(JSON.stringify(summary, null, 2));
}

main()
  .catch((err) => {
    console.error("seedAppleDemoUser failed:", err.message || err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
