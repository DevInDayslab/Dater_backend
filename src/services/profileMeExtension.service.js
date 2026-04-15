const { query } = require("../config/db");

function filledStr(v) {
  if (v == null) return false;
  return String(v).trim() !== "";
}

/**
 * Profile completion (0–100) per product spec. Totals 100%.
 * @param {object} params
 */
function computeProfileCompletionPercent({
  user,
  approvedPhotoCount,
  interestsCount,
  lookingForCount,
  languagesCount,
  pronounCount,
  filledPromptSlotCount,
}) {
  let score = 0;

  score += Math.min(6, approvedPhotoCount) * 4;
  if (user.is_verified) score += 10;

  const basicsPresent = [
    user.height_inches != null,
    filledStr(user.drinking),
    filledStr(user.smoking),
    filledStr(user.exercise),
    filledStr(user.religion),
    filledStr(user.education),
    filledStr(user.star_sign),
    filledStr(user.kids),
    filledStr(user.political_leanings),
    filledStr(user.pets),
  ];
  score += basicsPresent.filter(Boolean).length * 2;

  if (filledStr(user.preset_message)) score += 2;
  score += Math.min(2, lookingForCount) * 3;
  score += Math.min(5, interestsCount) * 1;
  if (filledStr(user.bio)) score += 5;
  if (filledStr(user.marital_status)) score += 2;
  if (languagesCount >= 1) score += 2;
  score += Math.min(3, filledPromptSlotCount) * 4;
  if (filledStr(user.ethnicity)) score += 2;
  if (pronounCount >= 1) score += 2;
  if (filledStr(user.occupation_job_title) || filledStr(user.occupation_company)) score += 2;
  if (filledStr(user.education_institution_name) || user.education_passing_year != null) score += 2;
  if (filledStr(user.living_in_city)) score += 2;
  if (filledStr(user.home_town_city)) score += 2;

  return Math.min(100, Math.round(score));
}

function primaryPhotoUrlFromRows(photoRows) {
  if (!photoRows || photoRows.length === 0) return null;
  const sorted = [...photoRows].sort((a, b) => {
    if (Boolean(b.is_primary) !== Boolean(a.is_primary)) return b.is_primary ? 1 : -1;
    return (a.photo_order ?? 0) - (b.photo_order ?? 0);
  });
  return sorted[0]?.photo_url || null;
}

/**
 * @param {object} user — row from users with profile columns
 * @param {object[]} approvedPhotoRows
 * @param {object[]} interestRows — { interest }
 * @param {object[]} lookingRows — { looking_for_option }
 * @param {object[]} languageRows — { language }
 * @param {object[]} pronounRows — { pronoun }
 * @param {object[]} promptRows — { prompt_order, prompt_question, prompt_answer }
 * @param {object[]} genderMoreRows — { gender_option }
 * @param {object[]} datingPrefRows — { preferred_gender }
 */
function buildProfileEditPayload(
  user,
  approvedPhotoRows,
  interestRows,
  lookingRows,
  languageRows,
  pronounRows,
  promptRows,
  genderMoreRows,
  datingPrefRows
) {
  const sortedPrompts = [...promptRows].sort((a, b) => (a.prompt_order ?? 0) - (b.prompt_order ?? 0));
  const answeredPromptCount = sortedPrompts.filter((r) => filledStr(r.prompt_answer)).length;

  const interestsCount = interestRows.length;
  const lookingForCount = lookingRows.length;
  const languagesCount = languageRows.length;
  const pronounCount = pronounRows.length;

  const profileCompletionPercent = computeProfileCompletionPercent({
    user,
    approvedPhotoCount: approvedPhotoRows.length,
    interestsCount,
    lookingForCount,
    languagesCount,
    pronounCount,
    filledPromptSlotCount: answeredPromptCount,
  });

  const writtenPrompts = sortedPrompts.map((r) => ({
    promptOrder: r.prompt_order,
    question: r.prompt_question || "",
    answer: r.prompt_answer || "",
  }));

  const interestedInGenders = datingPrefRows.map((r) => r.preferred_gender).filter(filledStr);
  const defaultDatingOptions = ["Woman", "Man", "Nonbinary"];
  const interestedInEveryone =
    interestedInGenders.length === defaultDatingOptions.length &&
    defaultDatingOptions.every((d) => interestedInGenders.includes(d));

  const profileEdit = {
    bio: user.bio || "",
    presetMessage: user.preset_message || "",
    maritalStatus: user.marital_status || "",
    selectedLanguages: languageRows.map((r) => r.language).filter(filledStr),
    selectedInterests: interestRows.map((r) => r.interest).filter(filledStr),
    lookingForSelected: lookingRows.map((r) => r.looking_for_option).filter(filledStr),
    writtenPrompts,
    basicsHeightInches: user.height_inches != null ? Number(user.height_inches) : 0,
    basicsDrinking: user.drinking || "",
    basicsSmoking: user.smoking || "",
    basicsExercise: user.exercise || "",
    basicsReligion: user.religion || "",
    basicsEducation: user.education || "",
    basicsStarSign: user.star_sign || "",
    basicsKids: user.kids || "",
    basicsPolitical: user.political_leanings || "",
    basicsPets: user.pets || "",
    ethnicity: user.ethnicity || "",
    selectedPronouns: pronounRows.map((r) => r.pronoun).filter(filledStr),
    occupationJobTitle: user.occupation_job_title || "",
    occupationCompany: user.occupation_company || "",
    educationInstitution: user.education_institution_name || "",
    educationPassingYear:
      user.education_passing_year != null && user.education_passing_year !== ""
        ? String(user.education_passing_year)
        : "",
    livingInCity: user.living_in_city || "",
    livingInCityMode: user.living_in_city_mode || "FOLLOW_DEVICE",
    homeTownCity: user.home_town_city || "",
    genderMain: user.gender_main || "",
    showGenderOnProfile: user.show_gender_on_profile !== false,
    genderMoreOptions: genderMoreRows.map((r) => r.gender_option).filter(filledStr),
    interestedInGenders,
    interestedInEveryone,
  };

  return {
    profileCompletionPercent,
    profileEdit,
    primaryPhotoUrl: primaryPhotoUrlFromRows(approvedPhotoRows),
  };
}

/**
 * Loads junction tables + builds completion and profileEdit for GET /me.
 */
async function loadProfileMeExtension(userId, userRow, approvedPhotoRows) {
  const [interestsRes, lookingRes, languagesRes, pronounsRes, promptsRes, genderMoreRes, datingPrefsRes] =
    await Promise.all([
      query(
        `SELECT interest FROM user_interests WHERE user_id = $1 ORDER BY interest ASC`,
        [userId]
      ),
      query(
        `SELECT looking_for_option FROM user_looking_for WHERE user_id = $1 ORDER BY looking_for_option ASC`,
        [userId]
      ),
      query(`SELECT language FROM user_languages WHERE user_id = $1 ORDER BY language ASC`, [userId]),
      query(`SELECT pronoun FROM user_pronouns WHERE user_id = $1 ORDER BY pronoun ASC`, [userId]),
      query(
        `SELECT prompt_order, prompt_question, prompt_answer
       FROM user_written_prompts
       WHERE user_id = $1
       ORDER BY prompt_order ASC`,
        [userId]
      ),
      query(
        `SELECT gender_option FROM user_gender_more_options WHERE user_id = $1 ORDER BY gender_option ASC`,
        [userId]
      ),
      query(
        `SELECT preferred_gender FROM user_dating_preferences WHERE user_id = $1 ORDER BY preferred_gender ASC`,
        [userId]
      ),
    ]);

  return buildProfileEditPayload(
    userRow,
    approvedPhotoRows,
    interestsRes.rows,
    lookingRes.rows,
    languagesRes.rows,
    pronounsRes.rows,
    promptsRes.rows,
    genderMoreRes.rows,
    datingPrefsRes.rows
  );
}

/**
 * Recomputes and persists users.profile_completion_percentage from current profile state.
 * Accepts either a pg client (transaction-safe) or defaults to shared query().
 */
async function recomputeAndPersistProfileCompletion(userId, db = null) {
  const runQuery =
    db && typeof db.query === "function" ? db.query.bind(db) : query;

  const userRes = await runQuery(
    `SELECT id,
            is_verified,
            bio, preset_message, marital_status,
            height_inches, drinking, smoking, exercise, religion, education,
            star_sign, kids, political_leanings, pets,
            ethnicity, occupation_job_title, occupation_company,
            education_institution_name, education_passing_year,
            living_in_city, home_town_city,
            living_in_city_mode,
            gender_main, show_gender_on_profile
     FROM users
     WHERE id = $1
     LIMIT 1`,
    [userId]
  );
  const user = userRes.rows[0];
  if (!user) return null;

  const photosRes = await runQuery(
    `SELECT photo_url, photo_order, is_primary
     FROM user_photos
     WHERE user_id = $1
       AND deleted_at IS NULL
       AND moderation_status = 'APPROVED'
     ORDER BY is_primary DESC, photo_order ASC`,
    [userId]
  );

  const { profileCompletionPercent } = await loadProfileMeExtension(
    userId,
    user,
    photosRes.rows
  );

  await runQuery(
    `UPDATE users
     SET profile_completion_percentage = $2
     WHERE id = $1
       AND profile_completion_percentage IS DISTINCT FROM $2`,
    [userId, profileCompletionPercent]
  );

  return profileCompletionPercent;
}

module.exports = {
  computeProfileCompletionPercent,
  buildProfileEditPayload,
  loadProfileMeExtension,
  recomputeAndPersistProfileCompletion,
};
