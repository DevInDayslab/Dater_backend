const test = require("node:test");
const assert = require("node:assert/strict");
const sql = require("./advancedFilterMatchSql");

test("exports contain expected SQL keywords", () => {
  assert.match(sql.advMatchDrinkingAnd, /CASE c\.drinking/);
  assert.match(sql.advMatchDrinkingAnd, /Yes, I drink/);
  assert.match(sql.advMatchSmokingAnd, /CASE c\.smoking/);
  assert.match(sql.advMatchMaritalAnd, /It''s complicated/);
  assert.match(sql.advMatchEthnicityAnd, /White\/caucasian/);
});
