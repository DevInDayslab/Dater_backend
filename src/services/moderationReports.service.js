/**
 * After a new row is inserted into `reports` for `reported_id`, evaluate global milestones:
 * every 3 reports against this user (any content_type: PROFILE, CHAT, STORY) ⇒ +1 moderation_warning_count;
 * at 3 warnings ⇒ BANNED.
 *
 * Caller must supply a transaction client; must already be in BEGIN. Locks the reported user row.
 */
async function applyReportMilestonesForReportedUser(client, reportedUserId) {
  await client.query(`SELECT id FROM users WHERE id = $1::uuid FOR UPDATE`, [reportedUserId]);

  const cntRes = await client.query(
    `SELECT COUNT(*)::int AS c FROM reports WHERE reported_id = $1::uuid`,
    [reportedUserId]
  );
  const totalReports = Number(cntRes.rows[0]?.c || 0);
  let warningIssued = false;
  let userBanned = false;

  if (totalReports >= 3 && totalReports % 3 === 0) {
    const w = await client.query(
      `UPDATE users
       SET moderation_warning_count = moderation_warning_count + 1
       WHERE id = $1::uuid
       RETURNING moderation_warning_count`,
      [reportedUserId]
    );
    const wc = Number(w.rows[0]?.moderation_warning_count || 0);
    warningIssued = true;
    if (wc >= 3) {
      await client.query(
        `UPDATE users SET account_state = 'BANNED'::account_state_enum WHERE id = $1::uuid`,
        [reportedUserId]
      );
      userBanned = true;
    }
  }

  return { totalReports, warningIssued, userBanned };
}

/**
 * After an admin dismisses/deletes a report, re-sync warning count and ban state
 * from remaining report rows (every 3 reports ⇒ 1 warning; 3 warnings ⇒ ban).
 * Caller must supply a transaction client; must already be in BEGIN.
 */
async function reconcileReportMilestonesAfterDismiss(client, reportedUserId) {
  await client.query(`SELECT id FROM users WHERE id = $1::uuid FOR UPDATE`, [reportedUserId]);

  const cntRes = await client.query(
    `SELECT COUNT(*)::int AS c FROM reports WHERE reported_id = $1::uuid`,
    [reportedUserId]
  );
  const totalReports = Number(cntRes.rows[0]?.c || 0);
  const expectedWarnings = Math.floor(totalReports / 3);

  await client.query(
    `UPDATE users
     SET moderation_warning_count = $2,
         moderation_consecutive_warning_count = LEAST(moderation_consecutive_warning_count, $2)
     WHERE id = $1::uuid`,
    [reportedUserId, expectedWarnings]
  );

  let userUnbanned = false;
  if (expectedWarnings < 3) {
    const banRes = await client.query(
      `UPDATE users
       SET account_state = 'ACTIVE'::account_state_enum
       WHERE id = $1::uuid
         AND account_state = 'BANNED'::account_state_enum
       RETURNING id`,
      [reportedUserId]
    );
    userUnbanned = banRes.rowCount > 0;
  }

  return { totalReports, expectedWarnings, userUnbanned };
}

module.exports = {
  applyReportMilestonesForReportedUser,
  reconcileReportMilestonesAfterDismiss,
};
