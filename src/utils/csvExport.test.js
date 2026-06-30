const test = require("node:test");
const assert = require("node:assert/strict");
const { escapeCsvField, formatAccountStateLabel, csvRow } = require("./csvExport");

test("escapeCsvField leaves plain values unchanged", () => {
  assert.equal(escapeCsvField("Alice"), "Alice");
  assert.equal(escapeCsvField(42), "42");
  assert.equal(escapeCsvField(null), "");
});

test("escapeCsvField wraps commas, quotes, and newlines", () => {
  assert.equal(escapeCsvField("Alice, Bob"), '"Alice, Bob"');
  assert.equal(escapeCsvField('Say "hi"'), '"Say ""hi"""');
  assert.equal(escapeCsvField("Line\nBreak"), '"Line\nBreak"');
});

test("formatAccountStateLabel mirrors admin panel formatting", () => {
  assert.equal(formatAccountStateLabel("HIDDEN_BY_MODERATION"), "Hidden By Moderation");
  assert.equal(formatAccountStateLabel("DELETED"), "Deleted");
});

test("csvRow builds RFC-style rows", () => {
  assert.equal(csvRow(["Phone", "Name"]), "Phone,Name\n");
  assert.equal(csvRow(["+1", "O'Brien, Jr."]), '+1,"O\'Brien, Jr."\n');
});
