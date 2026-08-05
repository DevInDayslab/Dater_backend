const { query } = require("../../config/db");
const { presignMediaUrl } = require("./adminPresign.service");

function parsePagination(queryParams) {
  const page = Math.max(Number.parseInt(queryParams.page, 10) || 1, 1);
  const limit = Math.min(Math.max(Number.parseInt(queryParams.limit, 10) || 25, 1), 100);
  return { page, limit, offset: (page - 1) * limit };
}

function toIso(value) {
  return value ? new Date(value).toISOString() : null;
}

function mapListRow(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    mobile: row.mobile,
    description: row.description,
    hasAttachment: Boolean(row.attachment_url || row.attachment_s3_key),
    ipAddress: row.ip_address || null,
    createdAt: toIso(row.created_at),
  };
}

async function mapDetailRow(row) {
  const attachmentUrl = await presignMediaUrl({
    s3Key: row.attachment_s3_key,
    fallbackUrl: row.attachment_url,
  });

  return {
    id: row.id,
    name: row.name,
    email: row.email,
    mobile: row.mobile,
    description: row.description,
    attachmentUrl,
    attachmentS3Key: row.attachment_s3_key || null,
    ipAddress: row.ip_address || null,
    createdAt: toIso(row.created_at),
  };
}

async function listLandingContacts(queryParams = {}) {
  const { page, limit, offset } = parsePagination(queryParams);
  const search = String(queryParams.search || "").trim();

  const params = [];
  const where = ["1=1"];

  if (search) {
    params.push(`%${search}%`);
    const idx = params.length;
    where.push(
      `(name ILIKE $${idx} OR email ILIKE $${idx} OR mobile ILIKE $${idx})`
    );
  }

  const whereSql = where.join(" AND ");

  const countRes = await query(
    `SELECT COUNT(*)::int AS total FROM landing_contacts WHERE ${whereSql}`,
    params
  );
  const total = Number(countRes.rows[0]?.total || 0);

  params.push(limit, offset);
  const limitIdx = params.length - 1;
  const offsetIdx = params.length;

  const listRes = await query(
    `SELECT
       id,
       name,
       email,
       mobile,
       description,
       attachment_url,
       attachment_s3_key,
       ip_address::text AS ip_address,
       created_at
     FROM landing_contacts
     WHERE ${whereSql}
     ORDER BY created_at DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params
  );

  return {
    items: listRes.rows.map(mapListRow),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(Math.ceil(total / limit), 1),
    },
  };
}

async function getLandingContactDetail(contactId) {
  const res = await query(
    `SELECT
       id,
       name,
       email,
       mobile,
       description,
       attachment_url,
       attachment_s3_key,
       ip_address::text AS ip_address,
       created_at
     FROM landing_contacts
     WHERE id = $1::uuid`,
    [contactId]
  );

  const row = res.rows[0];
  if (!row) return null;

  return {
    contact: await mapDetailRow(row),
  };
}

module.exports = {
  listLandingContacts,
  getLandingContactDetail,
};
