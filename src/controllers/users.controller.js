const { pool, query } = require("../config/db");
const geocoderService = require("../services/geocoder.service");
const photoMaintenance = require("../services/photoMaintenance.service");
const { debugLog } = require("../utils/serverDebugLog");
const { resolveUserAppRoute } = require("../utils/resolveUserAppRoute");
const profileMeExtension = require("../services/profileMeExtension.service");
const s3Media = require("../services/s3Media.service");
const entitlementsService = require("../services/entitlements.service");
const { hasPremiumAccess } = require("../services/subscriptionState.service");
const { stripPremiumExclusiveFiltersFromSnapshot } = require("../services/premiumExclusiveSettings.service");
const verificationService = require("../services/verification.service");
const socialService = require("../services/social.service");
const accountLifecycle = require("../services/accountLifecycle.service");
const { emitUnreadCountsUpdated } = require("../services/websocket.service");
const unreadCountsService = require("../services/unreadCounts.service");
const { effectiveNewHereUntilMs, isNewHereBadgeActive } = require("../utils/newHereBadge");

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return null;
  const seen = new Set();
  const out = [];
  for (const item of value) {
    const v = String(item || "").trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function isAlphabeticName(value) {
  // Frontend parity with NameStep: letters + spaces only.
  return /^[A-Za-z ]+$/.test(String(value || ""));
}

/** Blank string → null so SQL COALESCE keeps the existing column value. */
function coalescePatchString(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return value;
  const t = value.trim();
  return t === "" ? null : t;
}

/** Invalid / missing height → null (do not overwrite stored height). */
function coalescePatchHeightInches(value) {
  if (value === undefined || value === null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const i = Math.round(n);
  if (i < 36 || i > 96) return null;
  return i;
}

/** Invalid / blank passing year -> null (do not overwrite stored year). */
function coalescePatchEducationPassingYear(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const i = Math.round(n);
  if (i < 1900 || i > 2100) return null;
  return i;
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

function normalizeLivingInCityMode(value) {
  const v = String(value || "").trim().toUpperCase();
  if (v === "FOLLOW_DEVICE" || v === "MANUAL_SWITCH") return v;
  return null;
}

function parseStringArrayPatch(value) {
  if (value === undefined) return { present: false, values: null };
  if (value === null) return { present: true, values: [] };
  if (!Array.isArray(value)) return { present: true, values: null, invalid: true };
  return { present: true, values: normalizeStringArray(value) || [] };
}

function parseWrittenPromptsPatch(value) {
  if (value === undefined) return { present: false, values: null };
  if (value === null) return { present: true, values: [] };
  if (!Array.isArray(value)) return { present: true, values: null, invalid: true };
  return {
    present: true,
    values: value
      .slice(0, 3)
      .map((p, i) => ({
        promptOrder: Number.isFinite(Number(p?.promptOrder))
          ? Math.max(1, Math.min(3, Number(p.promptOrder)))
          : i + 1,
        promptQuestion: String(p?.promptQuestion || "").trim(),
        promptAnswer: String(p?.promptAnswer || "").trim(),
      }))
      .filter((p) => p.promptQuestion && p.promptAnswer),
  };
}

function parseBooleanPatch(value) {
  if (value === undefined) return { present: false, value: null };
  if (typeof value !== "boolean") return { present: true, value: null, invalid: true };
  return { present: true, value };
}

function parseIntegerPatch(value, { min, max } = {}) {
  if (value === undefined) return { present: false, value: null };
  if (value === null || value === "") return { present: true, value: null };
  const n = Number(value);
  if (!Number.isFinite(n)) return { present: true, value: null, invalid: true };
  const i = Math.round(n);
  if ((min != null && i < min) || (max != null && i > max)) {
    return { present: true, value: null, invalid: true };
  }
  return { present: true, value: i };
}

/** Full-body clients send these keys every time; treat as absent so we do not gate the whole PATCH. */
function noopStringArrayPatch() {
  return { present: false, values: null };
}

function noopBooleanPatch() {
  return { present: false, value: null };
}

function noopIntegerPatch() {
  return { present: false, value: null };
}

async function ensureUserFiltersRow(client, userId) {
  // Seed defaults ONCE for brand-new accounts:
  // age range = (user age ± 5), with min clamped to 18.
  // If the row already exists (user has opened/saved filters before), do not override.
  await client.query(
    `INSERT INTO user_filters (user_id, age_min, age_max)
     SELECT $1,
            GREATEST(18, COALESCE(u.age_years, 20) - 5) AS age_min,
            (COALESCE(u.age_years, 20) + 5) AS age_max
     FROM users u
     WHERE u.id = $1
     ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );

  // If onboarding created the user_filters row earlier with legacy defaults (20–36),
  // upgrade it to the new default range, but ONLY when the user hasn't edited filters yet.
  await client.query(
    `UPDATE user_filters uf
     SET age_min = GREATEST(18, COALESCE(u.age_years, 20) - 5),
         age_max = (COALESCE(u.age_years, 20) + 5),
         updated_at = NOW()
     FROM users u
     WHERE uf.user_id = $1
       AND u.id = uf.user_id
       AND uf.updated_at = uf.created_at
       AND uf.age_min = 20
       AND uf.age_max = 36`,
    [userId]
  );
}

async function loadStringRows(runQuery, sql, params, fieldName) {
  const res = await runQuery(sql, params);
  return res.rows.map((r) => String(r[fieldName] || "").trim()).filter(Boolean);
}

async function loadUserFiltersSnapshot(userId, runQuery = query) {
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
            u.living_in_city,
            u.living_in_city_mode,
            u.age_years,
            u.is_verified
     FROM user_filters uf
     JOIN users u ON u.id = uf.user_id
     WHERE uf.user_id = $1
     LIMIT 1`,
    [userId]
  );
  const scalar = scalarRes.rows[0] || null;
  if (!scalar) return null;

  const [
    preferredGenders,
    languages,
    maritalStatuses,
    lookingFor,
    drinkingPreferences,
    smokingPreferences,
    exercisePreferences,
    religionPreferences,
    educationPreferences,
    starSignPreferences,
    kidsPreferences,
    politicalPreferences,
    petPreferences,
    ethnicityPreferences,
    pronounPreferences,
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

  const preferredLocationCity = String(scalar.preferred_location_city || "").trim();
  const usingSwitchCity = preferredLocationCity.length > 0;
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
  return {
    preferredGenders,
    distanceKm: Number(scalar.distance_pref_km || 20),
    ageMin: useSeededAgeRange ? seededAgeMin : Number(scalar.age_min || 20),
    ageMax: useSeededAgeRange ? seededAgeMax : Number(scalar.age_max || 36),
    expandAgeRange: Boolean(scalar.expand_age_range),
    expandDistance: Boolean(scalar.expand_distance),
    onlyVerifiedProfiles: Boolean(scalar.only_verified_profiles),
    selectedLocation: usingSwitchCity ? preferredLocationCity : "__CURRENT_LOCATION__",
    usingSwitchCity,
    minHeightInches: scalar.min_height_inches == null ? null : Number(scalar.min_height_inches),
    maxHeightInches: scalar.max_height_inches == null ? null : Number(scalar.max_height_inches),
    showOtherPeopleIfRunOut: Boolean(scalar.show_other_people_if_run_out),
    languages,
    maritalStatuses,
    lookingFor,
    drinkingPreferences,
    smokingPreferences,
    exercisePreferences,
    religionPreferences,
    educationPreferences,
    starSignPreferences,
    kidsPreferences,
    politicalPreferences,
    petPreferences,
    ethnicityPreferences,
    pronounPreferences,
    viewerIsVerified: Boolean(scalar.is_verified),
  };
}

async function replaceUserRows(client, { table, column, userId, values }) {
  await client.query(`DELETE FROM ${table} WHERE user_id = $1`, [userId]);
  for (const value of values) {
    await client.query(
      `INSERT INTO ${table} (user_id, ${column}) VALUES ($1, $2) ON CONFLICT (user_id, ${column}) DO NOTHING`,
      [userId, value]
    );
  }
}

async function replaceUserWrittenPrompts(client, { userId, prompts }) {
  await client.query(`DELETE FROM user_written_prompts WHERE user_id = $1`, [userId]);
  for (const p of prompts) {
    await client.query(
      `INSERT INTO user_written_prompts (user_id, prompt_order, prompt_question, prompt_answer)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, prompt_order)
       DO UPDATE SET prompt_question = EXCLUDED.prompt_question,
                     prompt_answer = EXCLUDED.prompt_answer,
                     updated_at = NOW()`,
      [userId, p.promptOrder, p.promptQuestion, p.promptAnswer]
    );
  }
}

async function getMe(req, res) {
  try {
    const userId = req.auth.userId;
    await accountLifecycle.normalizeExpiredPauseForUser(userId);
    const entitlementSnapshot = await entitlementsService.getEntitlementsSnapshot(userId);
    const result = await query(
      `SELECT id, phone_e164, account_state, onboarding_step, onboarding_completed_at, onboarding_updated_at,
              moderation_warning_count, moderation_warnings_acknowledged,
              location_granted, living_in_city, home_town_city, notifications_granted,
              is_verified, is_premium, is_phone_verified,
              premium_started_at, premium_expires_at, premium_plan_code, premium_status,
              created_at, new_here_until,
              paused_until, hide_my_name,
              verified_at, verification_last_attempt_at, verification_selfie_s3_key,
              name, age_years, date_of_birth, gender, gender_main, show_gender_on_profile, marital_status,
              bio, preset_message, height_inches, drinking, smoking, exercise, religion, education,
              star_sign, kids, political_leanings, pets,
              ethnicity, occupation_job_title, occupation_company,
              education_institution_name, education_passing_year, living_in_city_mode,
              ST_Y(location::geometry) AS location_latitude,
              ST_X(location::geometry) AS location_longitude
       FROM users
       WHERE id = $1
       LIMIT 1`,
      [userId]
    );

    const user = result.rows[0];
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // `living_in_city` is manual profile text only (never GPS). Browse/filter labels use coordinates +
    // geocoder (`browseLocationCity`) or premium `user_filters.preferred_location_city`.

    await photoMaintenance.expireStalePendingPhotosForUser(userId);
    await photoMaintenance.normalizePhotoOrdersForUser(userId);

    const photosRes = await query(
      `SELECT id, photo_url, photo_order, is_primary, moderation_status, blur_hash, s3_key
       FROM user_photos
       WHERE user_id = $1
         AND deleted_at IS NULL
         AND moderation_status = 'APPROVED'
       ORDER BY is_primary DESC, photo_order ASC`,
      [userId]
    );

    const photoRowsForClient = await Promise.all(
      photosRes.rows.map(async (p) => {
        let readUrl = p.photo_url;
        if (p.s3_key) {
          try {
            readUrl = await s3Media.getPresignedGetUrl({ key: p.s3_key });
          } catch (e) {
            debugLog("me_photo_presign_get_failed", { userId, photoId: p.id, error: e.message });
          }
        }
        return { ...p, photo_url: readUrl };
      })
    );

    const { profileCompletionPercent, profileEdit, primaryPhotoUrl } =
      await profileMeExtension.loadProfileMeExtension(userId, user, photoRowsForClient);
    await query(
      `UPDATE users
       SET profile_completion_percentage = $2
       WHERE id = $1
         AND profile_completion_percentage IS DISTINCT FROM $3`,
      [userId, profileCompletionPercent, profileCompletionPercent]
    );

    const nextRoute = resolveUserAppRoute(user);
    const effNewHereUntilMs = effectiveNewHereUntilMs(user);
    const isNewHere = isNewHereBadgeActive(user);
    const newHereUntilIso = Number.isFinite(effNewHereUntilMs)
      ? new Date(effNewHereUntilMs).toISOString()
      : null;

    const pendingSess = await query(
      `SELECT EXISTS (
         SELECT 1 FROM user_verification_sessions
         WHERE user_id = $1 AND status = 'CREATED' AND created_at > NOW() - INTERVAL '30 minutes'
       ) AS pending`,
      [userId]
    );
    const verificationPending = Boolean(pendingSess.rows[0]?.pending);
    const filters = await loadUserFiltersSnapshot(userId);

    let browseLocationCity = "";
    const brLat = user.location_latitude;
    const brLng = user.location_longitude;
    if (Number.isFinite(Number(brLat)) && Number.isFinite(Number(brLng))) {
      const gs = await geocoderService.getCityAndState(Number(brLat), Number(brLng));
      browseLocationCity = gs?.cityStateLabel ? String(gs.cityStateLabel).trim() : "";
    }

    return res.status(200).json({
      success: true,
      message: "User profile fetched",
      data: {
        userId: user.id,
        phoneE164: user.phone_e164,
        accountState: user.account_state,
        moderationWarningCount: Number(user.moderation_warning_count || 0),
        moderationWarningsAcknowledged: Number(user.moderation_warnings_acknowledged || 0),
        onboardingStep: user.onboarding_step,
        onboardingCompletedAt: user.onboarding_completed_at,
        isVerified: user.is_verified,
        isPremium: user.is_premium,
        isPhoneVerified: user.is_phone_verified,
        hideMyName: user.hide_my_name === true,
        pausedUntil: user.paused_until ? new Date(user.paused_until).toISOString() : null,
        locationGranted: user.location_granted,
        livingInCity: user.living_in_city,
        browseLocationCity,
        livingInCityMode: user.living_in_city_mode || "FOLLOW_DEVICE",
        notificationsGranted: user.notifications_granted,
        nextRoute,
        profileCompletionPercent,
        isNewHere,
        newHereUntil: newHereUntilIso,
        primaryPhotoUrl: primaryPhotoUrl || null,
        profileEdit,
        entitlements: entitlementSnapshot,
        profileResume: {
          name: user.name || null,
          ageYears: user.age_years != null ? user.age_years : null,
          dateOfBirth: user.date_of_birth || null,
          gender: user.gender || null,
          maritalStatus: user.marital_status || null,
          livingInCity: user.living_in_city || null,
          locationGranted: user.location_granted,
          notificationsGranted: user.notifications_granted,
        },
        profilePhotos: photoRowsForClient.map((p) => ({
          id: p.id,
          photoUrl: p.photo_url,
          photoOrder: p.photo_order,
          isPrimary: p.is_primary,
          moderationStatus: p.moderation_status,
          blurHash: p.blur_hash || null,
        })),
        verification: {
          verificationPending,
          verifiedAt: user.verified_at || null,
          verificationLastAttemptAt: user.verification_last_attempt_at || null,
          hasVerificationSelfie: Boolean(user.verification_selfie_s3_key),
        },
        filters,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch user profile",
      error: error.message,
    });
  }
}

async function ackModerationWarning(req, res) {
  try {
    const userId = req.auth.userId;
    await query(
      `UPDATE users
       SET moderation_warnings_acknowledged = moderation_warning_count
       WHERE id = $1::uuid`,
      [userId]
    );
    return res.status(200).json({ success: true, message: "OK" });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to acknowledge moderation warning",
    });
  }
}

async function getMyFilters(req, res) {
  try {
    const userId = req.auth.userId;
    const userRowRes = await query(
      `SELECT id, is_premium, premium_started_at, premium_expires_at, premium_status
       FROM users
       WHERE id = $1 AND deleted_at IS NULL
       LIMIT 1`,
      [userId]
    );
    if (!userRowRes.rows[0]) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }
    const isPremiumUser = hasPremiumAccess(userRowRes.rows[0]);
    const filters = await loadUserFiltersSnapshot(userId);
    if (!filters) {
      return res.status(404).json({
        success: false,
        message: "Filter preferences not found",
      });
    }
    return res.status(200).json({
      success: true,
      message: "Filter preferences fetched",
      data: isPremiumUser ? filters : stripPremiumExclusiveFiltersFromSnapshot(filters),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch filter preferences",
      error: error.message,
    });
  }
}

async function updateMyFilters(req, res) {
  const userId = req.auth.userId;
  const body = req.body || {};
  const preferredGendersPatch = parseStringArrayPatch(body.preferredGenders);
  const languagesPatch = parseStringArrayPatch(body.languages);
  let maritalStatusesPatch = parseStringArrayPatch(body.maritalStatuses);
  let lookingForPatch = parseStringArrayPatch(body.lookingFor);
  let drinkingPatch = parseStringArrayPatch(body.drinkingPreferences);
  let smokingPatch = parseStringArrayPatch(body.smokingPreferences);
  let exercisePatch = parseStringArrayPatch(body.exercisePreferences);
  let religionPatch = parseStringArrayPatch(body.religionPreferences);
  let educationPatch = parseStringArrayPatch(body.educationPreferences);
  let starSignPatch = parseStringArrayPatch(body.starSignPreferences);
  let kidsPatch = parseStringArrayPatch(body.kidsPreferences);
  let politicalPatch = parseStringArrayPatch(body.politicalPreferences);
  let petPatch = parseStringArrayPatch(body.petPreferences);
  let ethnicityPatch = parseStringArrayPatch(body.ethnicityPreferences);
  let pronounPatch = parseStringArrayPatch(body.pronounPreferences);
  const expandAgeRangePatch = parseBooleanPatch(body.expandAgeRange);
  const expandDistancePatch = parseBooleanPatch(body.expandDistance);
  const onlyVerifiedPatch = parseBooleanPatch(body.onlyVerifiedProfiles);
  let showOtherPeoplePatch = parseBooleanPatch(body.showOtherPeopleIfRunOut);
  const distancePatch = parseIntegerPatch(body.distanceKm, { min: 2, max: 150 });
  const ageMinPatch = parseIntegerPatch(body.ageMin, { min: 18, max: 80 });
  const ageMaxPatch = parseIntegerPatch(body.ageMax, { min: 18, max: 80 });
  let minHeightPatch = parseIntegerPatch(body.minHeightInches, { min: 36, max: 96 });
  let maxHeightPatch = parseIntegerPatch(body.maxHeightInches, { min: 36, max: 96 });

  const invalidPatch = [
    preferredGendersPatch,
    languagesPatch,
    maritalStatusesPatch,
    lookingForPatch,
    drinkingPatch,
    smokingPatch,
    exercisePatch,
    religionPatch,
    educationPatch,
    starSignPatch,
    kidsPatch,
    politicalPatch,
    petPatch,
    ethnicityPatch,
    pronounPatch,
    expandAgeRangePatch,
    expandDistancePatch,
    onlyVerifiedPatch,
    showOtherPeoplePatch,
    distancePatch,
    ageMinPatch,
    ageMaxPatch,
    minHeightPatch,
    maxHeightPatch,
  ].some((p) => p.invalid === true);
  if (invalidPatch) {
    return res.status(400).json({
      success: false,
      message: "Invalid filter payload",
    });
  }

  if (ageMinPatch.present && ageMaxPatch.present && ageMinPatch.value != null && ageMaxPatch.value != null) {
    if (ageMaxPatch.value < ageMinPatch.value) {
      return res.status(400).json({
        success: false,
        message: "ageMax must be greater than or equal to ageMin",
      });
    }
  }
  if (minHeightPatch.present && maxHeightPatch.present && minHeightPatch.value != null && maxHeightPatch.value != null) {
    if (maxHeightPatch.value < minHeightPatch.value) {
      return res.status(400).json({
        success: false,
        message: "maxHeightInches must be greater than or equal to minHeightInches",
      });
    }
  }

  const currentUserRes = await query(
    `SELECT is_verified, is_premium, premium_started_at, premium_expires_at, premium_status
     FROM users
     WHERE id = $1
     LIMIT 1`,
    [userId]
  );
  const currentUser = currentUserRes.rows[0];
  if (!currentUser) {
    return res.status(404).json({ success: false, message: "User not found" });
  }

  if (onlyVerifiedPatch.present && onlyVerifiedPatch.value === true && currentUser.is_verified !== true) {
    return res.status(403).json({
      success: false,
      code: "VERIFY_REQUIRED",
      message: "Verify yourself first to use this filter",
    });
  }

  const isPremiumUser = hasPremiumAccess(currentUser);

  const selectedLocationRaw = hasOwn(body, "selectedLocation")
    ? String(body.selectedLocation || "").trim()
    : null;
  const selectedLocationPresent = hasOwn(body, "selectedLocation");
  const useCurrentLocation = selectedLocationPresent && selectedLocationRaw === "__CURRENT_LOCATION__";
  const wantsSwitchCity = selectedLocationPresent && selectedLocationRaw && !useCurrentLocation;
  if (wantsSwitchCity && !isPremiumUser) {
    return res.status(403).json({
      success: false,
      code: "PREMIUM_REQUIRED",
      message: "Switch city requires an active premium window",
    });
  }

  /**
   * Mobile sends a full filter body every time, so array keys are always "present".
   * Non-premium users may still PATCH basics + languages; ignore premium-only advanced mutations here
   * (advanced changes are gated in-app + switch-city still returns PREMIUM_REQUIRED above).
   */
  if (!isPremiumUser) {
    maritalStatusesPatch = noopStringArrayPatch();
    lookingForPatch = noopStringArrayPatch();
    drinkingPatch = noopStringArrayPatch();
    smokingPatch = noopStringArrayPatch();
    exercisePatch = noopStringArrayPatch();
    religionPatch = noopStringArrayPatch();
    educationPatch = noopStringArrayPatch();
    starSignPatch = noopStringArrayPatch();
    kidsPatch = noopStringArrayPatch();
    politicalPatch = noopStringArrayPatch();
    petPatch = noopStringArrayPatch();
    ethnicityPatch = noopStringArrayPatch();
    pronounPatch = noopStringArrayPatch();
    minHeightPatch = noopIntegerPatch();
    maxHeightPatch = noopIntegerPatch();
    showOtherPeoplePatch = noopBooleanPatch();
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensureUserFiltersRow(client, userId);

    const scalarSet = [];
    const scalarValues = [userId];
    const addScalarSet = (column, value) => {
      scalarValues.push(value);
      scalarSet.push(`${column} = $${scalarValues.length}`);
    };

    if (distancePatch.present) addScalarSet("distance_pref_km", distancePatch.value);
    if (ageMinPatch.present) addScalarSet("age_min", ageMinPatch.value);
    if (ageMaxPatch.present) addScalarSet("age_max", ageMaxPatch.value);
    if (expandAgeRangePatch.present) addScalarSet("expand_age_range", expandAgeRangePatch.value);
    if (expandDistancePatch.present) addScalarSet("expand_distance", expandDistancePatch.value);
    if (onlyVerifiedPatch.present) addScalarSet("only_verified_profiles", onlyVerifiedPatch.value);
    if (selectedLocationPresent) {
      addScalarSet("preferred_location_city", useCurrentLocation ? null : selectedLocationRaw || null);
    }
    if (minHeightPatch.present) addScalarSet("min_height_inches", minHeightPatch.value);
    if (maxHeightPatch.present) addScalarSet("max_height_inches", maxHeightPatch.value);
    if (showOtherPeoplePatch.present) addScalarSet("show_other_people_if_run_out", showOtherPeoplePatch.value);

    if (scalarSet.length > 0) {
      scalarSet.push("updated_at = NOW()");
      await client.query(
        `UPDATE user_filters
         SET ${scalarSet.join(",\n             ")}
         WHERE user_id = $1`,
        scalarValues
      );
    }

    // NOTE:
    // Filter "Switch city" is a browse-only preference stored in user_filters.preferred_location_city.
    // It must NOT mutate profile fields such as users.living_in_city / users.living_in_city_mode,
    // because those drive the "Lives in" bubble and edit-profile values.

    const rowReplacements = [
      [preferredGendersPatch, "user_filter_preferred_genders", "gender"],
      [languagesPatch, "user_filter_languages", "language"],
      [maritalStatusesPatch, "user_filter_marital_statuses", "marital_status"],
      [lookingForPatch, "user_filter_looking_for", "looking_for_option"],
      [drinkingPatch, "user_filter_drinking_preferences", "drinking_option"],
      [smokingPatch, "user_filter_smoking_preferences", "smoking_option"],
      [exercisePatch, "user_filter_exercise_preferences", "exercise_option"],
      [religionPatch, "user_filter_religion_preferences", "religion_option"],
      [educationPatch, "user_filter_education_preferences", "education_option"],
      [starSignPatch, "user_filter_star_sign_preferences", "star_sign_option"],
      [kidsPatch, "user_filter_kids_preferences", "kids_option"],
      [politicalPatch, "user_filter_political_preferences", "political_option"],
      [petPatch, "user_filter_pet_preferences", "pet_option"],
      [ethnicityPatch, "user_filter_ethnicity_preferences", "ethnicity_option"],
      [pronounPatch, "user_filter_pronoun_preferences", "pronoun_option"],
    ];
    for (const [patch, table, column] of rowReplacements) {
      if (patch.present) {
        await replaceUserRows(client, { table, column, userId, values: patch.values });
      }
    }

    await client.query("COMMIT");
    const filters = await loadUserFiltersSnapshot(userId);
    debugLog("filters_saved", {
      userId,
      touchedFields: Object.keys(body),
      usingSwitchCity: filters?.usingSwitchCity || false,
      onlyVerifiedProfiles: filters?.onlyVerifiedProfiles || false,
    });
    return res.status(200).json({
      success: true,
      message: "Filter preferences updated",
      data: isPremiumUser ? filters : stripPremiumExclusiveFiltersFromSnapshot(filters),
    });
  } catch (error) {
    await client.query("ROLLBACK");
    return res.status(500).json({
      success: false,
      message: "Failed to update filter preferences",
      error: error.message,
    });
  } finally {
    client.release();
  }
}

async function getPublicProfile(req, res) {
  try {
    const viewerId = req.auth.userId;
    const targetUserId = req.params.userId;
    const recordViewRaw = String(req.query?.recordView ?? "").toLowerCase().trim();
    const consumeView = recordViewRaw !== "false" && recordViewRaw !== "0";
    const profile = await socialService.getPublicProfile(viewerId, targetUserId, {
      source: "FEED",
      consumeView,
    });
    return res.status(200).json({
      success: true,
      message: "Profile fetched",
      data: profile,
    });
  } catch (error) {
    const status =
      error.code === "PROFILE_VIEW_LIMIT_REACHED"
        ? 403
        : error.code === "PROFILE_NOT_FOUND" || error.code === "VIEWER_NOT_FOUND"
          ? 404
          : error.code === "INVALID_TARGET_USER"
            ? 400
            : 500;
    const body = {
      success: false,
      code: error.code || "PROFILE_FETCH_FAILED",
      message: error.message || "Failed to fetch profile",
    };
    if (error.code === "PROFILE_VIEW_LIMIT_REACHED" && error.profileViewsUnlockAt) {
      body.data = { profileViewsUnlockAt: error.profileViewsUnlockAt };
    }
    return res.status(status).json(body);
  }
}

async function sendFriendRequest(req, res) {
  try {
    const viewerId = req.auth.userId;
    const { targetUserId } = req.body || {};
    const profile = await socialService.sendFriendRequest(viewerId, targetUserId);
    const targetId = String(targetUserId || "").trim();
    if (targetId) emitUnreadCountsUpdated(targetId).catch(() => {});
    return res.status(200).json({
      success: true,
      message: "Friend request sent",
      data: profile,
    });
  } catch (error) {
    const status =
      error.code === "PROFILE_NOT_FOUND"
        ? 404
        : error.code === "PRIVACY_MODE_BLOCKS_REQUEST"
          ? 403
          : error.code === "INVALID_TARGET_USER" || error.code === "ALREADY_FRIENDS"
            ? 400
            : 500;
    return res.status(status).json({
      success: false,
      code: error.code || "REQUEST_SEND_FAILED",
      message: error.message || "Failed to send friend request",
    });
  }
}

async function sendCommentRequest(req, res) {
  try {
    const viewerId = req.auth.userId;
    const { targetUserId, message } = req.body || {};
    const profile = await socialService.sendCommentRequest(viewerId, targetUserId, message);
    const targetId = String(targetUserId || "").trim();
    if (targetId) emitUnreadCountsUpdated(targetId).catch(() => {});
    return res.status(200).json({
      success: true,
      message: "Comment request sent",
      data: profile,
    });
  } catch (error) {
    const status =
      error.code === "PROFILE_NOT_FOUND"
        ? 404
        : error.code === "PRIVACY_MODE_BLOCKS_REQUEST"
          ? 403
          : error.code === "INSUFFICIENT_COMMENT_CREDITS"
            ? 409
            : error.code === "INVALID_TARGET_USER" ||
                error.code === "ALREADY_FRIENDS" ||
                error.code === "INVALID_COMMENT_TEXT"
              ? 400
              : 500;
    return res.status(status).json({
      success: false,
      code: error.code || "COMMENT_REQUEST_SEND_FAILED",
      message: error.message || "Failed to send comment request",
    });
  }
}

async function ignoreProfile(req, res) {
  try {
    const viewerId = req.auth.userId;
    const { targetUserId } = req.body || {};
    await socialService.ignoreProfile(viewerId, targetUserId);
    emitUnreadCountsUpdated(viewerId).catch(() => {});
    return res.status(200).json({
      success: true,
      message: "Profile ignored",
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      code: error.code || "PROFILE_IGNORE_FAILED",
      message: error.message || "Failed to ignore profile",
    });
  }
}

async function listIncomingFriendRequests(req, res) {
  try {
    const viewerId = req.auth.userId;
    const result = await socialService.listIncomingFriendRequests(viewerId, {
      page: req.query.page,
      pageSize: req.query.pageSize,
    });
    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      code: error.code || "NOTIFICATIONS_LIST_FAILED",
      message: error.message || "Failed to load friend requests",
    });
  }
}

async function getUnreadCounts(req, res) {
  try {
    const viewerId = req.auth.userId;
    const data = await unreadCountsService.getUnreadCounts(viewerId);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return res.status(500).json({
      success: false,
      code: error.code || "UNREAD_COUNTS_FAILED",
      message: error.message || "Failed to load unread counts",
    });
  }
}

async function listFriends(req, res) {
  try {
    const viewerId = req.auth.userId;
    const items = await socialService.listFriends(viewerId, {
      sort: req.query.sort,
    });
    return res.status(200).json({
      success: true,
      data: { items },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      code: error.code || "FRIENDS_LIST_FAILED",
      message: error.message || "Failed to load friends",
    });
  }
}

async function undoIncomingFriendRequestIgnore(req, res) {
  try {
    const viewerId = req.auth.userId;
    const fromUserId = req.params.fromUserId;
    await socialService.undoIncomingFriendRequestIgnore(viewerId, fromUserId);
    emitUnreadCountsUpdated(viewerId).catch(() => {});
    return res.status(200).json({
      success: true,
      message: "Request restored",
    });
  } catch (error) {
    const status = error.code === "REQUEST_UNDO_NOT_FOUND" ? 404 : 500;
    return res.status(status).json({
      success: false,
      code: error.code || "REQUEST_UNDO_FAILED",
      message: error.message || "Failed to undo ignore",
    });
  }
}

async function respondToRequest(req, res) {
  try {
    const viewerId = req.auth.userId;
    const fromUserId = req.params.fromUserId;
    const { decision } = req.body || {};
    const profile = await socialService.respondToRequest(viewerId, fromUserId, decision);
    emitUnreadCountsUpdated(viewerId).catch(() => {});
    emitUnreadCountsUpdated(fromUserId).catch(() => {});
    return res.status(200).json({
      success: true,
      message: "Request updated",
      data: profile,
    });
  } catch (error) {
    const status =
      error.code === "REQUEST_NOT_FOUND"
        ? 404
        : error.code === "INVALID_REQUEST_DECISION"
          ? 400
          : 500;
    return res.status(status).json({
      success: false,
      code: error.code || "REQUEST_RESPONSE_FAILED",
      message: error.message || "Failed to update request",
    });
  }
}

async function unfriendUser(req, res) {
  try {
    const viewerId = req.auth.userId;
    const targetUserId = req.params.userId;
    await socialService.unfriendUser(viewerId, targetUserId);
    return res.status(200).json({ success: true, message: "Unfriended" });
  } catch (error) {
    const status = error.code === "INVALID_TARGET_USER" ? 400 : 500;
    return res.status(status).json({
      success: false,
      code: error.code || "UNFRIEND_FAILED",
      message: error.message || "Failed to unfriend",
    });
  }
}

async function blockUser(req, res) {
  try {
    const viewerId = req.auth.userId;
    const targetUserId = req.params.userId;
    const reason = req.body?.reason || "";
    await socialService.blockUser(viewerId, targetUserId, reason);
    return res.status(200).json({ success: true, message: "Blocked" });
  } catch (error) {
    const status = error.code === "INVALID_TARGET_USER" ? 400 : 500;
    return res.status(status).json({
      success: false,
      code: error.code || "BLOCK_FAILED",
      message: error.message || "Failed to block user",
    });
  }
}

async function reportUser(req, res) {
  try {
    const viewerId = req.auth.userId;
    const targetUserId = req.params.userId;
    const reason = req.body?.reason || "";
    const contentType = req.body?.contentType || "PROFILE";
    const threadId = req.body?.threadId || "";
    const data = await socialService.reportUser(viewerId, targetUserId, { reason, contentType, threadId });
    return res.status(200).json({ success: true, message: "Reported", data });
  } catch (error) {
    const status =
      error.code === "INVALID_TARGET_USER" || error.code === "REPORT_REASON_REQUIRED" ? 400 : 500;
    return res.status(status).json({
      success: false,
      code: error.code || "REPORT_FAILED",
      message: error.message || "Failed to report user",
    });
  }
}

async function updateOnboardingStep(req, res) {
  try {
    const userId = req.auth.userId;
    const { onboardingStep, completed = false } = req.body;
    if (!onboardingStep || typeof onboardingStep !== "string") {
      return res.status(400).json({
        success: false,
        message: "onboardingStep is required",
      });
    }

    const result = await query(
      `UPDATE users
       SET onboarding_step = $2,
           onboarding_updated_at = NOW(),
           onboarding_completed_at = CASE WHEN $3::boolean THEN NOW() ELSE onboarding_completed_at END,
           updated_at = NOW()
       WHERE id = $1
       RETURNING id, onboarding_step, onboarding_completed_at`,
      [userId, onboardingStep, Boolean(completed)]
    );

    if (Boolean(completed)) {
      await query(
        `UPDATE users
         SET gender_main = gender,
             updated_at = NOW()
         WHERE id = $1
           AND gender_main IS NULL
           AND NULLIF(TRIM(gender), '') IS NOT NULL`,
        [userId]
      );
    }

    debugLog("onboarding_step_saved", {
      userId,
      onboardingStep,
      completed: Boolean(completed),
      row: result.rows[0],
    });

    return res.status(200).json({
      success: true,
      message: "Onboarding step updated",
      data: result.rows[0],
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to update onboarding step",
      error: error.message,
    });
  }
}

async function updateProfileCore(req, res) {
  try {
    const userId = req.auth.userId;
    const body = req.body || {};
    const {
      latitude,
      longitude,
      locationGranted,
      dateOfBirth,
      ageYears,
      livingInCityMode,
    } = body;
    if (hasOwn(body, "name")) {
      const rawName = String(body.name || "").trim();
      if (!rawName) {
        return res.status(400).json({
          success: false,
          code: "INVALID_NAME",
          message: "Name is required",
        });
      }
      if (!isAlphabeticName(rawName)) {
        return res.status(400).json({
          success: false,
          code: "INVALID_NAME",
          message: "Name can contain only alphabets and spaces",
        });
      }
    }
    const hasCoordinates =
      Number.isFinite(Number(latitude)) && Number.isFinite(Number(longitude));
    const currentUserRes = await query(
      `SELECT 1 AS ok
       FROM users
       WHERE id = $1
       LIMIT 1`,
      [userId]
    );
    if (!currentUserRes.rows[0]) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }
    const requestedLivingInCityMode = hasOwn(body, "livingInCityMode")
      ? normalizeLivingInCityMode(livingInCityMode)
      : null;
    if (hasOwn(body, "livingInCityMode") && !requestedLivingInCityMode) {
      return res.status(400).json({
        success: false,
        message: "livingInCityMode must be FOLLOW_DEVICE or MANUAL_SWITCH",
      });
    }

    const shouldPersistLocation = locationGranted === true && hasCoordinates;
    const cityState = shouldPersistLocation
      ? await geocoderService.getCityAndState(Number(latitude), Number(longitude))
      : null;
    if (locationGranted === true) {
      debugLog("onboarding_profile_core_location_input", {
        userId,
        latitude: hasCoordinates ? Number(latitude) : null,
        longitude: hasCoordinates ? Number(longitude) : null,
        hasCoordinates,
        geocoderCityState: cityState?.cityStateLabel || null,
      });
    }

    if (hasOwn(body, "dateOfBirth") && dateOfBirth) {
      const dob = new Date(dateOfBirth);
      if (!Number.isNaN(dob.getTime())) {
        const turn18 = new Date(dob);
        turn18.setFullYear(turn18.getFullYear() + 18);
        if (turn18.getTime() > Date.now()) {
          await query(
            `UPDATE users
             SET date_of_birth = $2::date,
                 account_state = 'UNDERAGE_BLOCKED'::account_state_enum,
                 underage_attempted_at = NOW(),
                 underage_until = $3::timestamptz,
                 updated_at = NOW()
             WHERE id = $1`,
            [userId, dateOfBirth, turn18.toISOString()]
          );
          debugLog("onboarding_profile_core_underage_dob", { userId });
          return res.status(403).json({
            success: false,
            code: "UNDERAGE_BLOCKED",
            message: "You must be 18 to use Dater",
          });
        }
      }
    }

    if (hasOwn(body, "ageYears") && typeof ageYears === "number" && ageYears < 18) {
      const yearsUntil18 = Math.max(1, 18 - ageYears);
      await query(
        `UPDATE users
         SET age_years = $2,
             account_state = 'UNDERAGE_BLOCKED'::account_state_enum,
             underage_attempted_at = NOW(),
             underage_until = NOW() + ($3 || ' years')::interval,
             updated_at = NOW()
         WHERE id = $1`,
        [userId, ageYears, yearsUntil18]
      );

      debugLog("onboarding_profile_core_underage_age", { userId, ageYears });
      return res.status(403).json({
        success: false,
        code: "UNDERAGE_BLOCKED",
        message: "You must be 18 to use Dater",
      });
    }

    const values = [userId];
    const setClauses = [];
    const addSet = (sqlExpr, value) => {
      values.push(value);
      setClauses.push(`${sqlExpr} = $${values.length}`);
    };

    const stringFieldMap = {
      name: "name",
      gender: "gender",
      maritalStatus: "marital_status",
      drinking: "drinking",
      smoking: "smoking",
      exercise: "exercise",
      religion: "religion",
      education: "education",
      starSign: "star_sign",
      kids: "kids",
      politicalLeanings: "political_leanings",
      pets: "pets",
      bio: "bio",
      presetMessage: "preset_message",
      ethnicity: "ethnicity",
      occupationJobTitle: "occupation_job_title",
      occupationCompany: "occupation_company",
      educationInstitution: "education_institution_name",
      livingInCity: "living_in_city",
      homeTownCity: "home_town_city",
    };

    for (const [apiKey, dbColumn] of Object.entries(stringFieldMap)) {
      if (!hasOwn(body, apiKey)) continue;
      addSet(dbColumn, coalescePatchString(body[apiKey]));
    }

    if (hasOwn(body, "ageYears")) addSet("age_years", body.ageYears ?? null);
    if (hasOwn(body, "dateOfBirth")) addSet("date_of_birth", body.dateOfBirth ?? null);
    if (hasOwn(body, "heightInches")) addSet("height_inches", coalescePatchHeightInches(body.heightInches));
    if (hasOwn(body, "educationPassingYear")) {
      addSet("education_passing_year", coalescePatchEducationPassingYear(body.educationPassingYear));
    }
    if (hasOwn(body, "locationGranted")) addSet("location_granted", body.locationGranted ?? null);
    if (hasOwn(body, "livingInCityMode")) addSet("living_in_city_mode", requestedLivingInCityMode);

    const shouldTouchAgeAgreement =
      (hasOwn(body, "ageYears") && Number(body.ageYears) >= 18) ||
      (hasOwn(body, "dateOfBirth") && body.dateOfBirth != null);
    if (shouldTouchAgeAgreement) {
      setClauses.push("age_agreement_timestamp = COALESCE(age_agreement_timestamp, NOW())");
    }
    if (shouldPersistLocation) {
      values.push(Number(longitude), Number(latitude));
      setClauses.push(
        `location = ST_SetSRID(ST_MakePoint($${values.length - 1}::double precision, $${values.length}::double precision), 4326)`
      );
    }
    setClauses.push("updated_at = NOW()");

    const result = await query(
      `UPDATE users
       SET ${setClauses.join(",\n           ")}
       WHERE id = $1
       RETURNING id, name, age_years, gender, onboarding_step, location_granted, living_in_city`,
      values
    );

    const touchedKeys = Object.keys(body).filter((k) => k !== "latitude" && k !== "longitude");
    if (Number.isFinite(Number(latitude)) && Number.isFinite(Number(longitude))) {
      touchedKeys.push("coordinates");
    }
    debugLog("onboarding_profile_core_saved", {
      userId,
      touchedFields: touchedKeys,
      locationGranted: result.rows[0]?.location_granted,
      livingInCity: result.rows[0]?.living_in_city,
    });
    const profileCompletionPercent = await profileMeExtension.recomputeAndPersistProfileCompletion(
      userId
    );
    if (locationGranted === true || hasCoordinates) {
      debugLog("onboarding_profile_core_location_output", {
        userId,
        latitude: hasCoordinates ? Number(latitude) : null,
        longitude: hasCoordinates ? Number(longitude) : null,
        geocoderCityState: cityState?.cityStateLabel || null,
        savedLivingInCity: result.rows[0]?.living_in_city || null,
      });
    }

    return res.status(200).json({
      success: true,
      message: "Profile core updated",
      data: {
        ...result.rows[0],
        profileCompletionPercent:
          profileCompletionPercent != null ? profileCompletionPercent : undefined,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to update profile core",
      error: error.message,
    });
  }
}

async function updateOnboardingData(req, res) {
  const userId = req.auth.userId;
  const body = req.body || {};
  const genderMoreOptionsPatch = parseStringArrayPatch(body.genderMoreOptions);
  const interestedInGendersPatch = parseStringArrayPatch(body.interestedInGenders);
  const lookingForOptionsPatch = parseStringArrayPatch(body.lookingForOptions);
  const interestsPatch = parseStringArrayPatch(body.interests);
  const selectedLanguagesPatch = parseStringArrayPatch(body.selectedLanguages);
  const selectedPronounsPatch = parseStringArrayPatch(body.selectedPronouns);
  const writtenPromptsPatch = parseWrittenPromptsPatch(body.writtenPrompts);
  const hasInvalidArrayPatch = [
    genderMoreOptionsPatch,
    interestedInGendersPatch,
    lookingForOptionsPatch,
    interestsPatch,
    selectedLanguagesPatch,
    selectedPronounsPatch,
    writtenPromptsPatch,
  ].some((p) => p.invalid === true);
  if (hasInvalidArrayPatch) {
    return res.status(400).json({
      success: false,
      message: "Invalid payload type for one or more array fields",
    });
  }

  const defaultDatingOptions = ["Woman", "Man", "Nonbinary"];
  let finalDatingPrefs = null;
  if (interestedInGendersPatch.present) {
    finalDatingPrefs = interestedInGendersPatch.values;
  } else if (hasOwn(body, "interestedInEveryone") && body.interestedInEveryone === true) {
    finalDatingPrefs = defaultDatingOptions;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const scalarSet = [];
    const scalarValues = [userId];
    const addScalarSet = (column, value) => {
      scalarValues.push(value);
      scalarSet.push(`${column} = $${scalarValues.length}`);
    };
    if (hasOwn(body, "genderMain")) addScalarSet("gender_main", body.genderMain ?? null);
    if (hasOwn(body, "showGenderOnProfile")) {
      addScalarSet(
        "show_gender_on_profile",
        typeof body.showGenderOnProfile === "boolean" ? body.showGenderOnProfile : null
      );
    }
    if (hasOwn(body, "maritalStatus")) addScalarSet("marital_status", body.maritalStatus ?? null);
    if (hasOwn(body, "notificationsGranted")) {
      addScalarSet(
        "notifications_granted",
        typeof body.notificationsGranted === "boolean" ? body.notificationsGranted : null
      );
    }
    if (hasOwn(body, "beKindAccepted") && body.beKindAccepted === true) {
      scalarSet.push("be_kind_accepted_at = COALESCE(be_kind_accepted_at, NOW())");
    }
    if (scalarSet.length > 0) {
      scalarSet.push("onboarding_updated_at = NOW()");
      scalarSet.push("updated_at = NOW()");
      await client.query(
        `UPDATE users
         SET ${scalarSet.join(",\n             ")}
         WHERE id = $1`,
        scalarValues
      );
    }

    if (genderMoreOptionsPatch.present) {
      await replaceUserRows(client, {
        table: "user_gender_more_options",
        column: "gender_option",
        userId,
        values: genderMoreOptionsPatch.values,
      });
    }

    if (finalDatingPrefs !== null) {
      await replaceUserRows(client, {
        table: "user_dating_preferences",
        column: "preferred_gender",
        userId,
        values: finalDatingPrefs,
      });

      await ensureUserFiltersRow(client, userId);
      await replaceUserRows(client, {
        table: "user_filter_preferred_genders",
        column: "gender",
        userId,
        values: finalDatingPrefs,
      });
    }

    if (lookingForOptionsPatch.present) {
      await replaceUserRows(client, {
        table: "user_looking_for",
        column: "looking_for_option",
        userId,
        values: lookingForOptionsPatch.values,
      });
    }

    if (interestsPatch.present) {
      await replaceUserRows(client, {
        table: "user_interests",
        column: "interest",
        userId,
        values: interestsPatch.values,
      });
    }
    if (selectedLanguagesPatch.present) {
      await replaceUserRows(client, {
        table: "user_languages",
        column: "language",
        userId,
        values: selectedLanguagesPatch.values,
      });
    }
    if (selectedPronounsPatch.present) {
      await replaceUserRows(client, {
        table: "user_pronouns",
        column: "pronoun",
        userId,
        values: selectedPronounsPatch.values,
      });
    }
    if (writtenPromptsPatch.present) {
      await replaceUserWrittenPrompts(client, {
        userId,
        prompts: writtenPromptsPatch.values,
      });
    }
    const profileCompletionPercent =
      await profileMeExtension.recomputeAndPersistProfileCompletion(userId, client);

    await client.query("COMMIT");
    debugLog("onboarding_data_saved", {
      userId,
      sections: {
        genderMain: hasOwn(body, "genderMain"),
        genderMoreOptions: genderMoreOptionsPatch.present,
        showGenderOnProfile: hasOwn(body, "showGenderOnProfile"),
        datingPreferences: finalDatingPrefs != null,
        lookingFor: lookingForOptionsPatch.present,
        interests: interestsPatch.present,
        selectedLanguages: selectedLanguagesPatch.present,
        selectedPronouns: selectedPronounsPatch.present,
        writtenPrompts: writtenPromptsPatch.present,
        maritalStatus: hasOwn(body, "maritalStatus"),
        notificationsGranted: hasOwn(body, "notificationsGranted"),
        beKindAccepted: hasOwn(body, "beKindAccepted") && body.beKindAccepted === true,
      },
    });
    return res.status(200).json({
      success: true,
      message: "Onboarding data updated",
      data: {
        profileCompletionPercent:
          profileCompletionPercent != null ? profileCompletionPercent : undefined,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    return res.status(500).json({
      success: false,
      message: "Failed to update onboarding data",
      error: error.message,
    });
  } finally {
    client.release();
  }
}

async function reverseGeocodeLocation(req, res) {
  try {
    const userId = req.auth.userId;
    const { latitude, longitude } = req.body || {};
    const lat = Number(latitude);
    const lng = Number(longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({
        success: false,
        message: "Valid latitude and longitude are required",
      });
    }
    const cityState = await geocoderService.getCityAndState(lat, lng);
    debugLog("profile_reverse_geocode_lookup", {
      userId,
      latitude: lat,
      longitude: lng,
      geocoderCityState: cityState?.cityStateLabel || null,
    });
    return res.status(200).json({
      success: true,
      message: "Reverse geocode resolved",
      data: {
        cityLabel: cityState?.cityStateLabel || null,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to reverse geocode coordinates",
      error: error.message,
    });
  }
}

async function listIndianCities(req, res) {
  try {
    const q = String(req.query.q || "").trim();
    const page = req.query.page;
    const pageSize = req.query.pageSize;
    const country = String(req.query.country ?? "").trim();
    const selected = String(req.query.selected || "").trim();

    const result = await geocoderService.searchCities({
      q,
      page,
      pageSize,
      countryIso2: country,
      selectedLabel: selected,
    });

    return res.status(200).json({
      success: true,
      message: "Cities fetched",
      data: {
        cities: result.cities,
        pagination: {
          page: result.page,
          pageSize: result.pageSize,
          total: result.total,
          hasMore: result.hasMore,
        },
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch cities",
      error: error.message,
    });
  }
}

async function createVerifyLivenessSession(req, res) {
  try {
    const userId = req.auth.userId;
    const { sessionId, region } = await verificationService.createLivenessSessionForUser(userId);
    return res.status(200).json({
      success: true,
      message: "Face liveness session created",
      data: { sessionId, region },
    });
  } catch (error) {
    debugLog("verify_liveness_session_error", { error: error.message, code: error.code });
    return res.status(502).json({
      success: false,
      code: error.code || "AWS_TEMPORARY_ERROR",
      message: error.message || "Could not create liveness session",
    });
  }
}

async function previewVerifyLiveness(req, res) {
  try {
    const userId = req.auth.userId;
    const sessionId = String(req.body?.sessionId || "").trim();
    if (!sessionId) {
      return res.status(400).json({ success: false, message: "sessionId is required" });
    }
    const preview = await verificationService.getLivenessPreviewForUser(userId, sessionId);
    return res.status(200).json({
      success: true,
      message: "Liveness preview",
      data: preview,
    });
  } catch (error) {
    const code = error.code || "LIVENESS_FAILED";
    const status = code === "SESSION_NOT_FOUND" ? 404 : 400;
    debugLog("verify_liveness_preview_error", { error: error.message, code });
    const payload = {
      success: false,
      code,
      message: error.message || "Liveness preview failed",
      details: error.details || undefined,
    };
    if (error.previewImageBase64) {
      payload.data = {
        previewImageBase64: error.previewImageBase64,
        contentType: error.previewContentType || "image/jpeg",
      };
    }
    return res.status(status).json(payload);
  }
}

async function completeVerifyLiveness(req, res) {
  try {
    const userId = req.auth.userId;
    const sessionId = String(req.body?.sessionId || "").trim();
    if (!sessionId) {
      return res.status(400).json({ success: false, message: "sessionId is required" });
    }
    const outcome = await verificationService.completeLivenessVerification(userId, sessionId);
    if (!outcome.ok) {
      await profileMeExtension.recomputeAndPersistProfileCompletion(userId);
      return res.status(200).json({
        success: false,
        code: outcome.code,
        message: outcome.message,
        data: {
          accountState: outcome.accountState,
          isVerified: outcome.isVerified,
          userPhotos: outcome.userPhotos,
          matchedCount: outcome.matchedCount,
          removedCount: outcome.removedCount,
        },
      });
    }

    const profileCompletionPercent = await profileMeExtension.recomputeAndPersistProfileCompletion(userId);

    return res.status(200).json({
      success: true,
      message: "Verification complete",
      data: {
        accountState: outcome.accountState,
        isVerified: outcome.isVerified,
        userPhotos: outcome.userPhotos,
        matchedCount: outcome.matchedCount,
        removedCount: outcome.removedCount,
        profileCompletionPercent: Math.round(Number(profileCompletionPercent ?? 0)),
      },
    });
  } catch (error) {
    const code = error.code || "VERIFICATION_ERROR";
    debugLog("verify_liveness_complete_error", { error: error.message, code });
    const status =
      code === "SESSION_NOT_FOUND"
        ? 404
        : code === "NO_APPROVED_PHOTOS" || code === "LIVENESS_FAILED"
          ? 400
          : 502;
    return res.status(status).json({
      success: false,
      code,
      message: error.message || "Verification failed",
    });
  }
}

/**
 * Account privacy: hide-my-name, premium-gated privacy mode, pause (timed or manual), distinct from moderation hidden.
 */
async function patchAccountSettings(req, res) {
  try {
    const userId = req.auth.userId;
    const body = req.body || {};
    const hasHide = Object.prototype.hasOwnProperty.call(body, "hideMyName");
    const hasPrivacy = Object.prototype.hasOwnProperty.call(body, "privacyMode");
    const hasPause = Object.prototype.hasOwnProperty.call(body, "pauseAccount");
    const pauseDuration = body.pauseDuration != null ? String(body.pauseDuration).trim() : "";
    const pausedUntilIso =
      body.pausedUntil != null && String(body.pausedUntil).trim() !== ""
        ? String(body.pausedUntil).trim()
        : null;

    if (!hasHide && !hasPrivacy && !hasPause) {
      return res.status(400).json({
        success: false,
        code: "EMPTY_PATCH",
        message: "No account settings supplied",
      });
    }

    const rowRes = await query(
      `SELECT id, account_state, is_premium, premium_started_at, premium_expires_at, premium_status, paused_until
       FROM users
       WHERE id = $1::uuid AND deleted_at IS NULL
       LIMIT 1`,
      [userId]
    );
    const row = rowRes.rows[0];
    if (!row) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    let hideMyName = null;
    if (hasHide) {
      if (typeof body.hideMyName !== "boolean") {
        return res.status(400).json({ success: false, message: "hideMyName must be a boolean" });
      }
      hideMyName = body.hideMyName;
    }

    let nextState = String(row.account_state || "ACTIVE");
    let pausedUntil = row.paused_until;

    if (hasPause) {
      if (typeof body.pauseAccount !== "boolean") {
        return res.status(400).json({ success: false, message: "pauseAccount must be a boolean" });
      }
      if (body.pauseAccount === true) {
        if (nextState === "HIDDEN_BY_MODERATION" || nextState === "BANNED" || nextState === "DELETED") {
          return res.status(409).json({
            success: false,
            code: "ACCOUNT_STATE_LOCKED",
            message: "Account cannot be paused in the current state",
          });
        }
        nextState = "PAUSED";
        if (pausedUntilIso) {
          const t = new Date(pausedUntilIso);
          if (Number.isNaN(t.getTime())) {
            return res.status(400).json({ success: false, message: "pausedUntil must be a valid ISO timestamp" });
          }
          pausedUntil = t.toISOString();
        } else if (pauseDuration) {
          const mapped = accountLifecycle.pauseDurationToUntilIso(pauseDuration);
          if (mapped.error) {
            return res.status(400).json({ success: false, code: mapped.error, message: "Invalid pause duration" });
          }
          pausedUntil = mapped.pausedUntilIso;
        } else {
          pausedUntil = null;
        }
      } else {
        if (nextState === "PAUSED") {
          nextState = "ACTIVE";
        }
        pausedUntil = null;
      }
    }

    if (hasPrivacy) {
      if (typeof body.privacyMode !== "boolean") {
        return res.status(400).json({ success: false, message: "privacyMode must be a boolean" });
      }
      if (body.privacyMode === true) {
        if (!hasPremiumAccess(row)) {
          return res.status(402).json({
            success: false,
            code: "PREMIUM_REQUIRED",
            message: "Privacy mode is a Premium feature",
          });
        }
        if (nextState === "HIDDEN_BY_MODERATION" || nextState === "BANNED" || nextState === "DELETED") {
          return res.status(409).json({
            success: false,
            code: "ACCOUNT_STATE_LOCKED",
            message: "Privacy mode is not available in the current account state",
          });
        }
        nextState = "PRIVACY_MODE";
        pausedUntil = null;
      } else if (body.privacyMode === false && nextState === "PRIVACY_MODE") {
        nextState = "ACTIVE";
      }
    }

    const sets = ["account_state = $1::account_state_enum", "paused_until = $2", "updated_at = NOW()"];
    const params = [nextState, pausedUntil];
    if (hideMyName !== null) {
      sets.push(`hide_my_name = $${params.length + 1}`);
      params.push(hideMyName);
    }
    params.push(userId);
    await query(
      `UPDATE users SET ${sets.join(", ")}
       WHERE id = $${params.length}::uuid AND deleted_at IS NULL`,
      params
    );

    const out = await query(
      `SELECT account_state, paused_until, hide_my_name
       FROM users WHERE id = $1::uuid LIMIT 1`,
      [userId]
    );
    const u = out.rows[0] || {};
    return res.status(200).json({
      success: true,
      message: "Account settings updated",
      data: {
        accountState: u.account_state,
        pausedUntil: u.paused_until ? new Date(u.paused_until).toISOString() : null,
        hideMyName: u.hide_my_name === true,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to update account settings",
    });
  }
}

/**
 * Hard-delete account while preserving a 6-month retention audit row.
 * Counterpart chat threads are marked as DELETED_ACCOUNT before user removal.
 */
async function deleteAccount(req, res) {
  const client = await pool.connect();
  try {
    const userId = req.auth.userId;
    await client.query("BEGIN");
    const uRes = await client.query(
      `SELECT id, phone_e164, account_state
       FROM users
       WHERE id = $1::uuid
       LIMIT 1
       FOR UPDATE`,
      [userId]
    );
    const u = uRes.rows[0];
    if (!u) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "User not found" });
    }
    if (String(u.account_state) === "BANNED") {
      await client.query("ROLLBACK");
      return res.status(403).json({ success: false, message: "Account is banned" });
    }
    const deletedAt = new Date().toISOString();

    // Mark counterpart thread state so chat surfaces show deleted-account state.
    await client.query(
      `UPDATE chat_thread_user_state s
       SET relationship_state = 'DELETED_ACCOUNT'::chat_relationship_state_enum,
           relationship_state_set_at = NOW(),
           relationship_state_expires_at = NULL,
           can_report = false,
           can_view_profile = false,
           pinned_to_bottom = true,
           updated_at = NOW()
       FROM chat_thread_participants p_self
       JOIN chat_thread_participants p_other
         ON p_other.thread_id = p_self.thread_id
        AND p_other.user_id <> p_self.user_id
       WHERE p_self.user_id = $1::uuid
         AND s.thread_id = p_other.thread_id
         AND s.user_id = p_other.user_id`,
      [userId]
    );

    await client.query(
      `INSERT INTO user_account_deletion_audit (user_id, phone_e164, account_deleted_at, data_retention_until)
       VALUES ($1::uuid, $2, $3::timestamptz, ($3::timestamptz + interval '6 months'))`,
      [userId, u.phone_e164 || null, deletedAt]
    );

    // Hard-delete active account row; ON DELETE rules clear active app graph/state.
    await client.query(`DELETE FROM users WHERE id = $1::uuid`, [userId]);

    await client.query("COMMIT");
    return res.status(200).json({
      success: true,
      message: "Account deleted",
      data: {
        accountState: "DELETED",
        accountDeletedAt: deletedAt ? new Date(deletedAt).toISOString() : null,
        dataRetentionUntil: deletedAt
          ? new Date(new Date(deletedAt).getTime() + 180 * 24 * 60 * 60 * 1000).toISOString()
          : null,
      },
    });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to delete account",
    });
  } finally {
    client.release();
  }
}

/** Foreground app ping — updates scoring-related activity timestamp. */
async function pingHeartbeat(req, res) {
  try {
    const userId = req.auth.userId;
    await query(
      `UPDATE users
       SET last_active_at = NOW(),
           updated_at = NOW()
       WHERE id = $1
         AND (
           last_active_at IS NULL
           OR last_active_at < NOW() - INTERVAL '45 seconds'
         )`,
      [userId]
    );
    return res.status(200).json({ success: true, message: "ok" });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || "Heartbeat failed",
    });
  }
}

async function getNotificationPreferences(req, res) {
  try {
    const userId = req.auth.userId;
    const prefRes = await query(
      `SELECT push_friend_request_received,
              push_friend_request_accepted,
              push_chat_dm,
              push_comment,
              inapp_friend_request_received,
              inapp_friend_request_accepted,
              inapp_chat_dm,
              inapp_comment
       FROM user_notification_preferences
       WHERE user_id = $1::uuid
       LIMIT 1`,
      [userId]
    );
    const row = prefRes.rows[0];
    return res.status(200).json({
      success: true,
      message: "ok",
      data: {
        pushFriendRequestReceived: row ? row.push_friend_request_received : true,
        pushFriendRequestAccepted: row ? row.push_friend_request_accepted : true,
        pushChatDm: row ? row.push_chat_dm : true,
        pushComment: row ? row.push_comment : true,
        inAppFriendRequestReceived: row ? row.inapp_friend_request_received : true,
        inAppFriendRequestAccepted: row ? row.inapp_friend_request_accepted : true,
        inAppChatDm: row ? row.inapp_chat_dm : true,
        inAppComment: row ? row.inapp_comment : true,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to load notification preferences",
    });
  }
}

async function patchNotificationPreferences(req, res) {
  try {
    const userId = req.auth.userId;
    const body = req.body || {};
    const toBool = (v) => (typeof v === "boolean" ? v : null);

    const patch = {
      push_friend_request_received: toBool(body.pushFriendRequestReceived),
      push_friend_request_accepted: toBool(body.pushFriendRequestAccepted),
      push_chat_dm: toBool(body.pushChatDm),
      push_comment: toBool(body.pushComment),
      inapp_friend_request_received: toBool(body.inAppFriendRequestReceived),
      inapp_friend_request_accepted: toBool(body.inAppFriendRequestAccepted),
      inapp_chat_dm: toBool(body.inAppChatDm),
      inapp_comment: toBool(body.inAppComment),
    };

    await query(
      `INSERT INTO user_notification_preferences (
            user_id,
            push_friend_request_received,
            push_friend_request_accepted,
            push_chat_dm,
            push_comment,
            inapp_friend_request_received,
            inapp_friend_request_accepted,
            inapp_chat_dm,
            inapp_comment,
            updated_at
        )
       VALUES (
            $1::uuid,
            COALESCE($2::boolean, TRUE),
            COALESCE($3::boolean, TRUE),
            COALESCE($4::boolean, TRUE),
            COALESCE($5::boolean, TRUE),
            COALESCE($6::boolean, TRUE),
            COALESCE($7::boolean, TRUE),
            COALESCE($8::boolean, TRUE),
            COALESCE($9::boolean, TRUE),
            NOW()
        )
       ON CONFLICT (user_id) DO UPDATE SET
            push_friend_request_received = COALESCE($2::boolean, user_notification_preferences.push_friend_request_received),
            push_friend_request_accepted = COALESCE($3::boolean, user_notification_preferences.push_friend_request_accepted),
            push_chat_dm = COALESCE($4::boolean, user_notification_preferences.push_chat_dm),
            push_comment = COALESCE($5::boolean, user_notification_preferences.push_comment),
            inapp_friend_request_received = COALESCE($6::boolean, user_notification_preferences.inapp_friend_request_received),
            inapp_friend_request_accepted = COALESCE($7::boolean, user_notification_preferences.inapp_friend_request_accepted),
            inapp_chat_dm = COALESCE($8::boolean, user_notification_preferences.inapp_chat_dm),
            inapp_comment = COALESCE($9::boolean, user_notification_preferences.inapp_comment),
            updated_at = NOW()
       RETURNING push_friend_request_received,
                 push_friend_request_accepted,
                 push_chat_dm,
                 push_comment,
                 inapp_friend_request_received,
                 inapp_friend_request_accepted,
                 inapp_chat_dm,
                 inapp_comment`,
      [
        userId,
        patch.push_friend_request_received,
        patch.push_friend_request_accepted,
        patch.push_chat_dm,
        patch.push_comment,
        patch.inapp_friend_request_received,
        patch.inapp_friend_request_accepted,
        patch.inapp_chat_dm,
        patch.inapp_comment,
      ]
    );

    // Re-read (single source of truth).
    return getNotificationPreferences(req, res);
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to update notification preferences",
    });
  }
}

async function registerPushToken(req, res) {
  try {
    const userId = req.auth.userId;
    const token = String(req.body?.token || "").trim();
    if (!token) {
      return res.status(400).json({ success: false, message: "Missing token" });
    }
    const platform = String(req.body?.platform || "ANDROID").trim().toUpperCase() || "ANDROID";
    const deviceId = String(req.body?.deviceId || "").trim();

    // One FCM installation token maps to one device; rebinding must clear prior accounts on this token.
    await query(
      `UPDATE user_push_tokens
       SET is_active = FALSE,
           last_seen_at = NOW()
       WHERE token = $1
         AND user_id <> $2::uuid`,
      [token, userId]
    );

    await query(
      `INSERT INTO user_push_tokens (user_id, token, platform, device_id, is_active, last_seen_at)
       VALUES ($1::uuid, $2, $3, $4, TRUE, NOW())
       ON CONFLICT (user_id, token) DO UPDATE SET
         platform = EXCLUDED.platform,
         device_id = EXCLUDED.device_id,
         is_active = TRUE,
         last_seen_at = NOW()`,
      [userId, token, platform, deviceId]
    );

    return res.status(200).json({ success: true, message: "ok" });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to register push token",
    });
  }
}

async function revokePushToken(req, res) {
  try {
    const userId = req.auth.userId;
    const token = String(req.body?.token || "").trim();
    if (!token) {
      return res.status(400).json({ success: false, message: "Missing token" });
    }
    await query(
      `UPDATE user_push_tokens
       SET is_active = FALSE,
           last_seen_at = NOW()
       WHERE user_id = $1::uuid
         AND token = $2`,
      [userId, token]
    );
    return res.status(200).json({ success: true, message: "ok" });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to revoke push token",
    });
  }
}

module.exports = {
  getMe,
  ackModerationWarning,
  patchAccountSettings,
  getNotificationPreferences,
  patchNotificationPreferences,
  registerPushToken,
  revokePushToken,
  deleteAccount,
  getMyFilters,
  getPublicProfile,
  pingHeartbeat,
  sendFriendRequest,
  sendCommentRequest,
  ignoreProfile,
  listIncomingFriendRequests,
  getUnreadCounts,
  listFriends,
  unfriendUser,
  blockUser,
  reportUser,
  undoIncomingFriendRequestIgnore,
  respondToRequest,
  updateMyFilters,
  updateOnboardingStep,
  updateProfileCore,
  updateOnboardingData,
  reverseGeocodeLocation,
  listIndianCities,
  createVerifyLivenessSession,
  previewVerifyLiveness,
  completeVerifyLiveness,
};
