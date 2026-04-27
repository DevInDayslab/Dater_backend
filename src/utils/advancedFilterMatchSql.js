/**
 * SQL fragments for viewer advanced-filter matching against candidate profile columns.
 * Filter tables store UI tokens (drinking/smoking chips); profile stores long-form strings.
 * Embedded into feed.service.js candidate_staging.adv_match only.
 */

/** Predicate tail after previous AND — marital: align "Complicated" (legacy filter) with "It's complicated" (profile). */
const advMatchMaritalAnd =
  "                  AND (CARDINALITY(v.filter_marital_statuses) = 0 OR (" +
  " c.marital_status IS NOT NULL AND (" +
  " c.marital_status = ANY(v.filter_marital_statuses)" +
  " OR (" +
  " c.marital_status IN ('It''s complicated', 'Complicated')" +
  " AND v.filter_marital_statuses && ARRAY['It''s complicated','Complicated']::varchar[]" +
  " )" +
  " )))";

/** Drinking: map profile answers to advanced chip tokens before ANY(filter_drinking). */
const advMatchDrinkingAnd =
  "                  AND (CARDINALITY(v.filter_drinking) = 0 OR (" +
  " c.drinking IS NOT NULL AND (" +
  " CASE c.drinking" +
  " WHEN 'Yes, I drink' THEN 'Yes'" +
  " WHEN 'I drink sometimes' THEN 'Sometimes'" +
  " WHEN 'I rarely drink' THEN 'Rarely'" +
  " WHEN 'No, i don''t drink' THEN 'No'" +
  " WHEN 'No, I don''t drink' THEN 'No'" +
  " WHEN 'I''m sober' THEN 'Sober'" +
  " ELSE NULL END" +
  " ) = ANY(v.filter_drinking)" +
  " ))";

/** Smoking: map profile (and occasional legacy short values) to advanced chip tokens. */
const advMatchSmokingAnd =
  "                  AND (CARDINALITY(v.filter_smoking) = 0 OR (" +
  " c.smoking IS NOT NULL AND (" +
  " CASE c.smoking" +
  " WHEN 'Yes, I smoke' THEN 'Yes'" +
  " WHEN 'I smoke sometimes' THEN 'Sometimes'" +
  " WHEN 'No, I don''t smoke' THEN 'No'" +
  " WHEN 'I''m trying to quit' THEN 'Trying to quit'" +
  " WHEN 'Yes' THEN 'Yes'" +
  " WHEN 'Sometimes' THEN 'Sometimes'" +
  " WHEN 'No' THEN 'No'" +
  " WHEN 'Trying to quit' THEN 'Trying to quit'" +
  " ELSE NULL END" +
  " ) = ANY(v.filter_smoking)" +
  " ))";

/** Ethnicity: legacy White spelling + filter/table drift (advanced vs profile casing). */
const advMatchEthnicityAnd =
  "                  AND (CARDINALITY(v.filter_ethnicity) = 0 OR (" +
  " c.ethnicity IS NOT NULL AND (" +
  " c.ethnicity = ANY(v.filter_ethnicity)" +
  " OR (" +
  " c.ethnicity IN ('White/caucasian', 'White/Caucasian') AND" +
  " v.filter_ethnicity && ARRAY['White/caucasian','White/Caucasian']::varchar[]" +
  " ))))";

module.exports = {
  advMatchMaritalAnd,
  advMatchDrinkingAnd,
  advMatchSmokingAnd,
  advMatchEthnicityAnd,
};
