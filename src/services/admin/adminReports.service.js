const { query, pool } = require("../../config/db");
const moderationReports = require("../moderationReports.service");
const { presignMediaUrl } = require("./adminPresign.service");
const adminUsersService = require("./adminUsers.service");
const { withAdminReportDisplay } = require("../../utils/adminReportDisplay");

function parsePagination(queryParams) {
  const page = Math.max(Number.parseInt(queryParams.page, 10) || 1, 1);
  const limit = Math.min(Math.max(Number.parseInt(queryParams.limit, 10) || 25, 1), 100);
  return { page, limit, offset: (page - 1) * limit };
}

function toIso(value) {
  return value ? new Date(value).toISOString() : null;
}

function mapReportListRow(row) {
  const adminDisplay = withAdminReportDisplay(row);
  return {
    id: row.id,
    reporterId: adminDisplay?.reporterId ?? row.reporter_id,
    reporterName: adminDisplay?.reporterName ?? (row.reporter_name || "Unknown"),
    reportedId: row.reported_id,
    reportedName: row.reported_name || "Unknown",
    contentType: row.content_type,
    reason: adminDisplay?.reason ?? row.reason,
    status: row.status,
    createdAt: toIso(row.created_at),
    chatThreadId: row.chat_thread_id || null,
    storyId: row.story_id || null,
    filedByAdmin: Boolean(adminDisplay),
    reportedUserWarningCount: Number(row.reported_user_warning_count || 0),
    reportedUserAccountState: row.reported_user_account_state,
    storyPreviewUrl: row.story_preview_url || null,
    profilePreviewUrl: row.profile_preview_url || null,
    reportedBio: row.reported_bio || null,
  };
}

async function listReports(queryParams = {}) {
  const { page, limit, offset } = parsePagination(queryParams);
  const contentType = String(queryParams.contentType || queryParams.type || "").trim().toUpperCase();

  const params = [];
  const where = ["1=1"];

  if (contentType && ["PROFILE", "STORY", "CHAT"].includes(contentType)) {
    params.push(contentType);
    where.push(`r.content_type = $${params.length}::report_content_type_enum`);
  }

  const whereSql = where.join(" AND ");

  const countRes = await query(
    `SELECT COUNT(*)::int AS total FROM reports r WHERE ${whereSql}`,
    params
  );
  const total = Number(countRes.rows[0]?.total || 0);

  params.push(limit, offset);
  const limitIdx = params.length - 1;
  const offsetIdx = params.length;

  const listRes = await query(
    `SELECT
       r.id,
       r.reporter_id,
       r.reported_id,
       r.content_type,
       r.reason,
       r.status,
       r.created_at,
       r.chat_thread_id,
       r.story_id,
       rep.name AS reporter_name,
       rd.name AS reported_name,
       rd.account_state AS reported_user_account_state,
       rd.moderation_warning_count AS reported_user_warning_count,
       rd.bio AS reported_bio,
       story.media_url AS story_media_url,
       primary_photo.photo_url AS profile_photo_url,
       primary_photo.s3_key AS profile_photo_s3_key
     FROM reports r
     JOIN users rep ON rep.id = r.reporter_id
     JOIN users rd ON rd.id = r.reported_id
     LEFT JOIN stories story ON story.id = r.story_id
     LEFT JOIN LATERAL (
       SELECT photo_url, s3_key
       FROM user_photos
       WHERE user_id = rd.id
         AND deleted_at IS NULL
         AND moderation_status = 'APPROVED'
         AND is_primary = TRUE
       ORDER BY photo_order ASC
       LIMIT 1
     ) primary_photo ON TRUE
     WHERE ${whereSql}
     ORDER BY r.created_at DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params
  );

  const items = await Promise.all(
    listRes.rows.map(async (row) => {
      const [storyPreviewUrl, profilePreviewUrl] = await Promise.all([
        row.story_media_url
          ? presignMediaUrl({ s3Key: null, fallbackUrl: row.story_media_url })
          : null,
        row.profile_photo_url || row.profile_photo_s3_key
          ? presignMediaUrl({ s3Key: row.profile_photo_s3_key, fallbackUrl: row.profile_photo_url })
          : null,
      ]);
      return mapReportListRow({
        ...row,
        story_preview_url: storyPreviewUrl,
        profile_preview_url: profilePreviewUrl,
      });
    })
  );

  return {
    items,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
  };
}

async function getReportDetail(reportId) {
  const res = await query(
    `SELECT
       r.*,
       rep.name AS reporter_name,
       rd.name AS reported_name,
       rd.account_state AS reported_user_account_state,
       rd.moderation_warning_count AS reported_user_warning_count,
       rd.bio AS reported_bio,
       story.media_url AS story_media_url,
       story.media_type AS story_media_type,
       story.audience AS story_audience,
       story.created_at AS story_created_at,
       primary_photo.photo_url AS profile_photo_url,
       primary_photo.s3_key AS profile_photo_s3_key
     FROM reports r
     JOIN users rep ON rep.id = r.reporter_id
     JOIN users rd ON rd.id = r.reported_id
     LEFT JOIN stories story ON story.id = r.story_id
     LEFT JOIN LATERAL (
       SELECT photo_url, s3_key
       FROM user_photos
       WHERE user_id = rd.id
         AND deleted_at IS NULL
         AND moderation_status = 'APPROVED'
         AND is_primary = TRUE
       ORDER BY photo_order ASC
       LIMIT 1
     ) primary_photo ON TRUE
     WHERE r.id = $1::uuid
     LIMIT 1`,
    [reportId]
  );
  const row = res.rows[0];
  if (!row) return null;

  const base = mapReportListRow({
    ...row,
    story_preview_url: null,
    profile_preview_url: null,
  });

  const [storyPreviewUrl, profilePreviewUrl] = await Promise.all([
    row.story_media_url
      ? presignMediaUrl({ s3Key: null, fallbackUrl: row.story_media_url })
      : null,
    row.profile_photo_url || row.profile_photo_s3_key
      ? presignMediaUrl({ s3Key: row.profile_photo_s3_key, fallbackUrl: row.profile_photo_url })
      : null,
  ]);

  base.storyPreviewUrl = storyPreviewUrl;
  base.profilePreviewUrl = profilePreviewUrl;

  let context = null;
  if (row.content_type === "CHAT" && row.chat_thread_id) {
    const messages = await adminUsersService.getUserChatMessages(row.reported_id, row.chat_thread_id);
    context = { type: "CHAT", messages: messages || [] };
  } else if (row.content_type === "STORY" && row.story_id) {
    context = {
      type: "STORY",
      story: {
        id: row.story_id,
        mediaUrl: storyPreviewUrl,
        mediaType: row.story_media_type,
        audience: row.story_audience,
        createdAt: toIso(row.story_created_at),
      },
    };
  } else if (row.content_type === "PROFILE") {
    context = {
      type: "PROFILE",
      bio: row.reported_bio || null,
      profilePhotoUrl: profilePreviewUrl,
    };
  }

  return { report: base, context };
}

async function dismissReport(reportId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const reportRes = await client.query(
      `SELECT id, reported_id FROM reports WHERE id = $1::uuid FOR UPDATE`,
      [reportId]
    );
    const report = reportRes.rows[0];
    if (!report) {
      await client.query("ROLLBACK");
      return { notFound: true };
    }

    await client.query(`DELETE FROM reports WHERE id = $1::uuid`, [reportId]);

    const reconcile = await moderationReports.reconcileReportMilestonesAfterDismiss(
      client,
      report.reported_id
    );

    await client.query("COMMIT");

    return {
      dismissedReportId: reportId,
      reportedUserId: report.reported_id,
      reconcile,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  listReports,
  getReportDetail,
  dismissReport,
};
