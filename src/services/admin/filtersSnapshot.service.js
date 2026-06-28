const { query } = require("../../config/db");

async function loadStringRows(runQuery, sql, params, fieldName) {
  const res = await runQuery(sql, params);
  return res.rows.map((r) => String(r[fieldName] || "").trim()).filter(Boolean);
}

/**
 * Admin-facing filter snapshot (no premium gate). Maps to DaterAdmin UserFiltersDetail.
 */
async function loadUserFiltersDetail(userId, runQuery = query) {
  const scalarRes = await runQuery(
    `SELECT uf.distance_pref_km,
            uf.age_min,
            uf.age_max,
            uf.expand_age_range,
            uf.expand_distance,
            uf.only_verified_profiles,
            uf.preferred_location_city,
            uf.min_height_inches,
            uf.max_height_inches,
            uf.show_other_people_if_run_out,
            u.age_years
     FROM user_filters uf
     JOIN users u ON u.id = uf.user_id
     WHERE uf.user_id = $1
     LIMIT 1`,
    [userId]
  );
  const scalar = scalarRes.rows[0];
  if (!scalar) {
    return null;
  }

  const [
    preferredGenders,
    languages,
    maritalStatuses,
    lookingFor,
    drinking,
    smoking,
    exercise,
    religion,
    education,
    starSign,
    kids,
    political,
    pets,
    ethnicity,
    pronouns,
  ] = await Promise.all([
    loadStringRows(runQuery, `SELECT gender FROM user_filter_preferred_genders WHERE user_id = $1 ORDER BY gender ASC`, [userId], "gender"),
    loadStringRows(runQuery, `SELECT language FROM user_filter_languages WHERE user_id = $1 ORDER BY language ASC`, [userId], "language"),
    loadStringRows(runQuery, `SELECT marital_status FROM user_filter_marital_statuses WHERE user_id = $1 ORDER BY marital_status ASC`, [userId], "marital_status"),
    loadStringRows(runQuery, `SELECT looking_for_option FROM user_filter_looking_for WHERE user_id = $1 ORDER BY looking_for_option ASC`, [userId], "looking_for_option"),
    loadStringRows(runQuery, `SELECT drinking_option FROM user_filter_drinking_preferences WHERE user_id = $1 ORDER BY drinking_option ASC`, [userId], "drinking_option"),
    loadStringRows(runQuery, `SELECT smoking_option FROM user_filter_smoking_preferences WHERE user_id = $1 ORDER BY smoking_option ASC`, [userId], "smoking_option"),
    loadStringRows(runQuery, `SELECT exercise_option FROM user_filter_exercise_preferences WHERE user_id = $1 ORDER BY exercise_option ASC`, [userId], "exercise_option"),
    loadStringRows(runQuery, `SELECT religion_option FROM user_filter_religion_preferences WHERE user_id = $1 ORDER BY religion_option ASC`, [userId], "religion_option"),
    loadStringRows(runQuery, `SELECT education_option FROM user_filter_education_preferences WHERE user_id = $1 ORDER BY education_option ASC`, [userId], "education_option"),
    loadStringRows(runQuery, `SELECT star_sign_option FROM user_filter_star_sign_preferences WHERE user_id = $1 ORDER BY star_sign_option ASC`, [userId], "star_sign_option"),
    loadStringRows(runQuery, `SELECT kids_option FROM user_filter_kids_preferences WHERE user_id = $1 ORDER BY kids_option ASC`, [userId], "kids_option"),
    loadStringRows(runQuery, `SELECT political_option FROM user_filter_political_preferences WHERE user_id = $1 ORDER BY political_option ASC`, [userId], "political_option"),
    loadStringRows(runQuery, `SELECT pet_option FROM user_filter_pet_preferences WHERE user_id = $1 ORDER BY pet_option ASC`, [userId], "pet_option"),
    loadStringRows(runQuery, `SELECT ethnicity_option FROM user_filter_ethnicity_preferences WHERE user_id = $1 ORDER BY ethnicity_option ASC`, [userId], "ethnicity_option"),
    loadStringRows(runQuery, `SELECT pronoun_option FROM user_filter_pronoun_preferences WHERE user_id = $1 ORDER BY pronoun_option ASC`, [userId], "pronoun_option"),
  ]);

  const viewerAge = Number(scalar.age_years || 0);
  const seededAgeMin =
    Number.isFinite(viewerAge) && viewerAge > 0 ? Math.max(18, viewerAge - 5) : 20;
  const seededAgeMax =
    Number.isFinite(viewerAge) && viewerAge > 0 ? viewerAge + 5 : 36;
  const persistedAgeMin = Number(scalar.age_min || 0);
  const persistedAgeMax = Number(scalar.age_max || 0);
  const useSeededAgeRange =
    !(Number.isFinite(persistedAgeMin) && persistedAgeMin > 0) &&
    !(Number.isFinite(persistedAgeMax) && persistedAgeMax > 0);

  const preferredLocationCity = String(scalar.preferred_location_city || "").trim() || null;

  return {
    distancePrefKm: Number(scalar.distance_pref_km || 20),
    ageMin: useSeededAgeRange ? seededAgeMin : Number(scalar.age_min || 20),
    ageMax: useSeededAgeRange ? seededAgeMax : Number(scalar.age_max || 36),
    minHeightInches: scalar.min_height_inches == null ? null : Number(scalar.min_height_inches),
    maxHeightInches: scalar.max_height_inches == null ? null : Number(scalar.max_height_inches),
    expandAgeRange: Boolean(scalar.expand_age_range),
    expandDistance: Boolean(scalar.expand_distance),
    onlyVerifiedProfiles: Boolean(scalar.only_verified_profiles),
    preferredLocationCity,
    showOtherPeopleIfRunOut: Boolean(scalar.show_other_people_if_run_out),
    preferredGenders,
    languages,
    maritalStatuses,
    lookingFor,
    drinking,
    smoking,
    exercise,
    religion,
    education,
    starSign,
    kids,
    political,
    pets,
    ethnicity,
    pronouns,
  };
}

module.exports = {
  loadUserFiltersDetail,
};
