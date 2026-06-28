const { query, pool } = require("../../config/db");

const moderationReports = require("../moderationReports.service");

const VALID_PREMIUM_PLANS = new Set([
  "PREMIUM_DAY",
  "PREMIUM_WEEK",
  "PREMIUM_MONTH",
  "PREMIUM_THREE_MONTHS",
  "PREMIUM_SIX_MONTHS",
]);
const VALID_REPORT_REASONS = new Set([
  "Fake Profile",
  "Inappropriate Content",
  "Scam or Commercial",
  "Hate Speech",
  "Off Dater behaviour",
  "Underage",
  "Rude or abusive behaviour",
]);

const PLAN_DAYS = {
  PREMIUM_DAY: 1,
  PREMIUM_WEEK: 7,
  PREMIUM_MONTH: 30,
  PREMIUM_THREE_MONTHS: 90,
  PREMIUM_SIX_MONTHS: 180,
};

const DURATION_TO_PLAN = {
  1: "PREMIUM_DAY",
  7: "PREMIUM_WEEK",
  30: "PREMIUM_MONTH",
  180: "PREMIUM_SIX_MONTHS",
};

function toIso(value) {
  return value ? new Date(value).toISOString() : null;
}

async function loadUserForUpdate(client, userId) {
  const res = await client.query(
    `SELECT id, account_state, phone_e164, deleted_at
     FROM users
     WHERE id = $1::uuid
     FOR UPDATE`,
    [userId]
  );
  return res.rows[0] || null;
}

async function issueWarning(userId, { reason } = {}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const user = await loadUserForUpdate(client, userId);
    if (!user || user.deleted_at) {
      await client.query("ROLLBACK");
      return { notFound: true };
    }

    const upd = await client.query(
      `UPDATE users
       SET moderation_warning_count = moderation_warning_count + 1,
           moderation_consecutive_warning_count = moderation_consecutive_warning_count + 1,
           updated_at = NOW()
       WHERE id = $1::uuid
       RETURNING moderation_warning_count, moderation_consecutive_warning_count, account_state`,
      [userId]
    );
    const row = upd.rows[0];
    let accountState = row.account_state;
    let userBanned = false;

    if (Number(row.moderation_warning_count) >= 3) {
      const banRes = await client.query(
        `UPDATE users
         SET account_state = 'BANNED'::account_state_enum
         WHERE id = $1::uuid
           AND account_state <> 'BANNED'::account_state_enum
         RETURNING account_state`,
        [userId]
      );
      if (banRes.rows[0]) {
        accountState = banRes.rows[0].account_state;
        userBanned = true;
      }
    }

    await client.query("COMMIT");
    return {
      userId,
      accountState,
      moderationWarningCount: Number(row.moderation_warning_count),
      moderationConsecutiveWarningCount: Number(row.moderation_consecutive_warning_count),
      userBanned,
      reason: reason || null,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function banUser(userId, { reason } = {}) {
  const res = await query(
    `UPDATE users
     SET account_state = 'BANNED'::account_state_enum,
         updated_at = NOW()
     WHERE id = $1::uuid
       AND deleted_at IS NULL
     RETURNING id, account_state, moderation_warning_count`,
    [userId]
  );
  if (!res.rows[0]) return { notFound: true };
  return {
    userId,
    accountState: res.rows[0].account_state,
    moderationWarningCount: Number(res.rows[0].moderation_warning_count || 0),
    reason: reason || null,
  };
}

async function unbanUser(userId) {
  const res = await query(
    `UPDATE users
     SET account_state = 'ACTIVE'::account_state_enum,
         profile_hidden_at = NULL,
         updated_at = NOW()
     WHERE id = $1::uuid
     RETURNING id, account_state`,
    [userId]
  );
  if (!res.rows[0]) return { notFound: true };
  return { userId, accountState: res.rows[0].account_state };
}

async function shadowbanUser(userId, { reason } = {}) {
  const res = await query(
    `UPDATE users
     SET account_state = 'HIDDEN_BY_MODERATION'::account_state_enum,
         profile_hidden_at = NOW(),
         updated_at = NOW()
     WHERE id = $1::uuid
       AND deleted_at IS NULL
     RETURNING id, account_state, profile_hidden_at`,
    [userId]
  );
  if (!res.rows[0]) return { notFound: true };
  return {
    userId,
    accountState: res.rows[0].account_state,
    profileHiddenAt: toIso(res.rows[0].profile_hidden_at),
    reason: reason || null,
  };
}

async function pauseUser(userId, { until } = {}) {
  let pausedUntil = null;
  if (until) {
    const t = new Date(until);
    if (Number.isNaN(t.getTime())) {
      const err = new Error("until must be a valid ISO timestamp");
      err.code = "INVALID_UNTIL";
      throw err;
    }
    pausedUntil = t.toISOString();
  }

  const res = await query(
    `UPDATE users
     SET account_state = 'PAUSED'::account_state_enum,
         paused_until = $2,
         updated_at = NOW()
     WHERE id = $1::uuid
       AND deleted_at IS NULL
       AND account_state NOT IN ('BANNED'::account_state_enum, 'DELETED'::account_state_enum, 'HIDDEN_BY_MODERATION'::account_state_enum)
     RETURNING id, account_state, paused_until`,
    [userId, pausedUntil]
  );
  if (!res.rows[0]) return { notFound: true };
  return {
    userId,
    accountState: res.rows[0].account_state,
    pausedUntil: toIso(res.rows[0].paused_until),
  };
}

async function deleteUser(userId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const user = await loadUserForUpdate(client, userId);
    if (!user) {
      await client.query("ROLLBACK");
      return { notFound: true };
    }
    if (user.deleted_at) {
      await client.query("ROLLBACK");
      return { alreadyDeleted: true, userId };
    }

    const deletedAt = new Date().toISOString();

    await client.query(
      `UPDATE chat_thread_user_state s
       SET relationship_state = 'DELETED_ACCOUNT'::chat_relationship_state_enum,
           relationship_state_set_at = NOW(),
           relationship_state_expires_at = NULL,
           can_report = false,
           can_view_profile = false,
           pinned_to_bottom = true,
           updated_at = NOW()
       FROM chat_thread_participants p_self
       JOIN chat_thread_participants p_other
         ON p_other.thread_id = p_self.thread_id
        AND p_other.user_id <> p_self.user_id
       WHERE p_self.user_id = $1::uuid
         AND s.thread_id = p_other.thread_id
         AND s.user_id = p_other.user_id`,
      [userId]
    );

    await client.query(
      `INSERT INTO user_account_deletion_audit (user_id, phone_e164, account_deleted_at, data_retention_until)
       VALUES ($1::uuid, $2, $3::timestamptz, ($3::timestamptz + interval '6 months'))`,
      [userId, user.phone_e164 || null, deletedAt]
    );

    const upd = await client.query(
      `UPDATE users
       SET deleted_at = $2::timestamptz,
           account_state = 'DELETED'::account_state_enum,
           updated_at = NOW()
       WHERE id = $1::uuid
       RETURNING id, account_state, deleted_at`,
      [userId, deletedAt]
    );

    await client.query("COMMIT");

    const row = upd.rows[0];
    return {
      userId,
      accountState: row.account_state,
      accountDeletedAt: toIso(row.deleted_at),
      dataRetentionUntil: new Date(
        new Date(deletedAt).getTime() + 180 * 24 * 60 * 60 * 1000
      ).toISOString(),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function patchProfile(userId, { name, bio, presetMessage } = {}) {
  const sets = [];
  const params = [userId];

  if (name !== undefined) {
    params.push(String(name).trim().slice(0, 80));
    sets.push(`name = $${params.length}`);
  }
  if (bio !== undefined) {
    params.push(String(bio).trim());
    sets.push(`bio = $${params.length}`);
  }
  if (presetMessage !== undefined) {
    params.push(String(presetMessage).trim());
    sets.push(`preset_message = $${params.length}`);
  }

  if (sets.length === 0) {
    const err = new Error("No allowed profile fields supplied");
    err.code = "EMPTY_PATCH";
    throw err;
  }

  sets.push("profile_updated_at = NOW()", "updated_at = NOW()");

  const res = await query(
    `UPDATE users
     SET ${sets.join(", ")}
     WHERE id = $1::uuid
       AND deleted_at IS NULL
     RETURNING id, name, bio, preset_message`,
    params
  );
  if (!res.rows[0]) return { notFound: true };

  const row = res.rows[0];
  return {
    userId: row.id,
    name: row.name || null,
    bio: row.bio || null,
    presetMessage: row.preset_message || null,
  };
}

async function grantPremium(userId, { planCode, expiresAt, durationDays } = {}) {
  let code = String(planCode || "").trim().toUpperCase();
  let days = null;

  if (durationDays != null) {
    days = Number(durationDays);
    if (!Number.isFinite(days) || !DURATION_TO_PLAN[days]) {
      const err = new Error("Invalid premium duration");
      err.code = "INVALID_DURATION";
      throw err;
    }
    code = DURATION_TO_PLAN[days];
  } else if (!VALID_PREMIUM_PLANS.has(code)) {
    const err = new Error("Invalid premium plan code");
    err.code = "INVALID_PLAN_CODE";
    throw err;
  } else {
    days = PLAN_DAYS[code] || 30;
  }

  let premiumExpiresAt = expiresAt ? new Date(expiresAt) : null;
  if (!premiumExpiresAt || Number.isNaN(premiumExpiresAt.getTime())) {
    premiumExpiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  }

  const res = await query(
    `UPDATE users
     SET premium_status = 'ACTIVE',
         premium_plan_code = $2,
         premium_started_at = NOW(),
         premium_expires_at = $3,
         is_premium = TRUE,
         updated_at = NOW()
     WHERE id = $1::uuid
       AND deleted_at IS NULL
     RETURNING id, premium_status, premium_plan_code, premium_started_at, premium_expires_at, is_premium`,
    [userId, code, premiumExpiresAt.toISOString()]
  );
  if (!res.rows[0]) return { notFound: true };

  const row = res.rows[0];
  return {
    userId: row.id,
    premiumStatus: row.premium_status,
    premiumPlanCode: row.premium_plan_code,
    premiumStartedAt: toIso(row.premium_started_at),
    premiumExpiresAt: toIso(row.premium_expires_at),
    isPremium: Boolean(row.is_premium),
  };
}

async function removePremium(userId) {
  const res = await query(
    `UPDATE users
     SET premium_status = 'INACTIVE',
         premium_plan_code = NULL,
         premium_started_at = NULL,
         premium_expires_at = NULL,
         is_premium = FALSE,
         updated_at = NOW()
     WHERE id = $1::uuid
       AND deleted_at IS NULL
     RETURNING id, premium_status, premium_plan_code, premium_expires_at, is_premium`,
    [userId]
  );
  if (!res.rows[0]) return { notFound: true };

  const row = res.rows[0];
  return {
    userId: row.id,
    premiumStatus: row.premium_status,
    premiumPlanCode: row.premium_plan_code,
    premiumExpiresAt: toIso(row.premium_expires_at),
    isPremium: Boolean(row.is_premium),
  };
}

async function grantBoostCredits(userId, { amount } = {}) {
  const credits = Number(amount);
  if (!Number.isFinite(credits) || credits < 1 || credits > 9999) {
    const err = new Error("Boost amount must be between 1 and 9999");
    err.code = "INVALID_BOOST_AMOUNT";
    throw err;
  }

  const res = await query(
    `INSERT INTO user_boost_wallet (user_id, remaining_credits, updated_at)
     VALUES ($1::uuid, $2, NOW())
     ON CONFLICT (user_id)
     DO UPDATE SET
       remaining_credits = user_boost_wallet.remaining_credits + EXCLUDED.remaining_credits,
       updated_at = NOW()
     RETURNING user_id, remaining_credits`,
    [userId, credits]
  );
  if (!res.rows[0]) return { notFound: true };

  return {
    userId: res.rows[0].user_id,
    remainingCredits: Number(res.rows[0].remaining_credits),
    granted: credits,
  };
}

async function grantCommentCredits(userId, { amount } = {}) {
  const comments = Number(amount);
  if (!Number.isFinite(comments) || comments < 1 || comments > 9999) {
    const err = new Error("Comment amount must be between 1 and 9999");
    err.code = "INVALID_COMMENT_AMOUNT";
    throw err;
  }

  const res = await query(
    `INSERT INTO user_comment_wallet (user_id, remaining_paid_comments, updated_at)
     VALUES ($1::uuid, $2, NOW())
     ON CONFLICT (user_id)
     DO UPDATE SET
       remaining_paid_comments = user_comment_wallet.remaining_paid_comments + EXCLUDED.remaining_paid_comments,
       updated_at = NOW()
     RETURNING user_id, remaining_paid_comments`,
    [userId, comments]
  );
  if (!res.rows[0]) return { notFound: true };

  return {
    userId: res.rows[0].user_id,
    remainingPaidComments: Number(res.rows[0].remaining_paid_comments),
    granted: comments,
  };
}

async function revokeSession(userId, sessionId) {
  const res = await query(
    `UPDATE user_sessions
     SET revoked_at = NOW()
     WHERE id = $1::uuid
       AND user_id = $2::uuid
       AND revoked_at IS NULL
     RETURNING id, revoked_at`,
    [sessionId, userId]
  );
  if (!res.rows[0]) return { notFound: true };
  return {
    sessionId: res.rows[0].id,
    revokedAt: toIso(res.rows[0].revoked_at),
  };
}

async function resolveModerationReporterUserId(client, reportedUserId) {
  const configured = String(process.env.ADMIN_MODERATION_REPORTER_USER_ID || "").trim();
  if (configured) {
    const configuredRes = await client.query(
      `SELECT id FROM users WHERE id = $1::uuid AND id <> $2::uuid AND deleted_at IS NULL`,
      [configured, reportedUserId]
    );
    if (configuredRes.rows[0]) return configuredRes.rows[0].id;
  }

  const fallbackRes = await client.query(
    `SELECT id
     FROM users
     WHERE deleted_at IS NULL
       AND id <> $1::uuid
     ORDER BY created_at ASC
     LIMIT 1`,
    [reportedUserId]
  );
  if (!fallbackRes.rows[0]) {
    const error = new Error(
      "No reporter user available. Set ADMIN_MODERATION_REPORTER_USER_ID in backend/.env."
    );
    error.code = "MODERATION_REPORTER_NOT_CONFIGURED";
    throw error;
  }
  return fallbackRes.rows[0].id;
}

async function fileReport(reportedUserId, { reason, adminName } = {}) {
  const normalizedReason = String(reason || "").trim();
  if (!normalizedReason || !VALID_REPORT_REASONS.has(normalizedReason)) {
    const error = new Error("A valid report reason is required");
    error.code = "INVALID_REPORT_REASON";
    throw error;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const reportedRes = await client.query(
      `SELECT id FROM users WHERE id = $1::uuid AND deleted_at IS NULL FOR UPDATE`,
      [reportedUserId]
    );
    if (!reportedRes.rows[0]) {
      await client.query("ROLLBACK");
      return { notFound: true };
    }

    const reporterId = await resolveModerationReporterUserId(client, reportedUserId);
    const reasonWithAdmin = adminName
      ? `[Admin: ${adminName}] ${normalizedReason}`
      : `[Admin] ${normalizedReason}`;

    const insertRes = await client.query(
      `INSERT INTO reports (reporter_id, reported_id, content_type, reason)
       VALUES ($1::uuid, $2::uuid, 'PROFILE'::report_content_type_enum, $3)
       RETURNING id, created_at, status`,
      [reporterId, reportedUserId, reasonWithAdmin]
    );
    const report = insertRes.rows[0];
    const agg = await moderationReports.applyReportMilestonesForReportedUser(client, reportedUserId);

    await client.query("COMMIT");
    return {
      reportId: report.id,
      createdAt: toIso(report.created_at),
      status: report.status,
      reason: reasonWithAdmin,
      ...agg,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  issueWarning,
  banUser,
  unbanUser,
  shadowbanUser,
  pauseUser,
  deleteUser,
  patchProfile,
  grantPremium,
  removePremium,
  grantBoostCredits,
  grantCommentCredits,
  revokeSession,
  fileReport,
};
