function escapeCsvField(value) {
  const text = value == null ? "" : String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function formatAccountStateLabel(state) {
  return String(state || "")
    .toLowerCase()
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function csvRow(fields) {
  return `${fields.map(escapeCsvField).join(",")}\n`;
}

module.exports = {
  escapeCsvField,
  formatAccountStateLabel,
  csvRow,
};
