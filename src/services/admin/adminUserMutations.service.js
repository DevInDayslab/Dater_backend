const { query, pool } = require("../../config/db");

const VALID_PREMIUM_PLANS = new Set(["PREMIUM_WEEK", "PREMIUM_MONTH", "PREMIUM_THREE_MONTHS"]);

const PLAN_DAYS = {
  PREMIUM_WEEK: 7,
  PREMIUM_MONTH: 30,
  PREMIUM_THREE_MONTHS: 90,
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

async function grantPremium(userId, { planCode, expiresAt } = {}) {
  const code = String(planCode || "").trim().toUpperCase();
  if (!VALID_PREMIUM_PLANS.has(code)) {
    const err = new Error("Invalid premium plan code");
    err.code = "INVALID_PLAN_CODE";
    throw err;
  }

  let premiumExpiresAt = expiresAt ? new Date(expiresAt) : null;
  if (!premiumExpiresAt || Number.isNaN(premiumExpiresAt.getTime())) {
    const days = PLAN_DAYS[code] || 30;
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

module.exports = {
  issueWarning,
  banUser,
  unbanUser,
  shadowbanUser,
  pauseUser,
  deleteUser,
  patchProfile,
  grantPremium,
  revokeSession,
};
