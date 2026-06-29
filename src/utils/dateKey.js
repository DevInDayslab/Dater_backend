/**
 * Normalize PostgreSQL DATE / timestamp values from node-pg into YYYY-MM-DD keys.
 * node-pg returns DATE columns as JS Date objects; String(date) does not match ISO keys.
 */
function toUtcDateKey(value) {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  const text = String(value ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
    return text.slice(0, 10);
  }

  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }

  return text;
}

module.exports = {
  toUtcDateKey,
}
