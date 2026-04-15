const { pool, query } = require("../config/db");
const geocoderService = require("../services/geocoder.service");
const photoMaintenance = require("../services/photoMaintenance.service");
const { debugLog } = require("../utils/serverDebugLog");
const { resolveUserAppRoute } = require("../utils/resolveUserAppRoute");
const profileMeExtension = require("../services/profileMeExtension.service");
const s3Media = require("../services/s3Media.service");
const entitlementsService = require("../services/entitlements.service");

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
    const entitlementSnapshot = await entitlementsService.getEntitlementsSnapshot(userId);
    const result = await query(
      `SELECT id, phone_e164, account_state, onboarding_step, onboarding_completed_at, onboarding_updated_at,
              location_granted, living_in_city, home_town_city, notifications_granted,
              is_verified, is_premium, is_phone_verified,
              premium_started_at, premium_expires_at, premium_plan_code, premium_status,
              created_at, new_here_until,
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
    if (!user.is_premium && user.living_in_city_mode === "MANUAL_SWITCH") {
      const lat = Number(user.location_latitude);
      const lng = Number(user.location_longitude);
      const cityState =
        Number.isFinite(lat) && Number.isFinite(lng)
          ? geocoderService.getCityAndState(lat, lng)
          : null;
      const fallbackCity = cityState?.cityStateLabel || user.living_in_city || null;
      const downgraded = await query(
        `UPDATE users
         SET living_in_city_mode = 'FOLLOW_DEVICE',
             living_in_city = COALESCE($2, living_in_city),
             updated_at = NOW()
         WHERE id = $1
         RETURNING living_in_city, living_in_city_mode`,
        [userId, fallbackCity]
      );
      user.living_in_city = downgraded.rows[0]?.living_in_city || user.living_in_city;
      user.living_in_city_mode =
        downgraded.rows[0]?.living_in_city_mode || "FOLLOW_DEVICE";
      debugLog("living_in_city_mode_downgraded_to_follow_device", {
        userId,
        reason: "premium_expired",
        fallbackCity: user.living_in_city,
      });
    }

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    await photoMaintenance.expireStalePendingPhotosForUser(userId);

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
         AND profile_completion_percentage IS DISTINCT FROM $2`,
      [userId, profileCompletionPercent]
    );

    const nextRoute = resolveUserAppRoute(user);
    const createdAtMs = user.created_at ? new Date(user.created_at).getTime() : null;
    const existingNewHereUntilMs = user.new_here_until ? new Date(user.new_here_until).getTime() : null;
    const fallbackNewHereUntilMs =
      Number.isFinite(createdAtMs) ? createdAtMs + 72 * 60 * 60 * 1000 : null;
    const effectiveNewHereUntilMs =
      Number.isFinite(existingNewHereUntilMs) ? existingNewHereUntilMs : fallbackNewHereUntilMs;
    const isNewHere =
      Number.isFinite(effectiveNewHereUntilMs) && Date.now() < effectiveNewHereUntilMs;
    const newHereUntilIso = Number.isFinite(effectiveNewHereUntilMs)
      ? new Date(effectiveNewHereUntilMs).toISOString()
      : null;

    return res.status(200).json({
      success: true,
      message: "User profile fetched",
      data: {
        userId: user.id,
        phoneE164: user.phone_e164,
        accountState: user.account_state,
        onboardingStep: user.onboarding_step,
        onboardingCompletedAt: user.onboarding_completed_at,
        isVerified: user.is_verified,
        isPremium: user.is_premium,
        isPhoneVerified: user.is_phone_verified,
        locationGranted: user.location_granted,
        livingInCity: user.living_in_city,
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
      suppressLivingInAutofill,
      livingInCityMode,
    } = body;
    const hasCoordinates =
      Number.isFinite(Number(latitude)) && Number.isFinite(Number(longitude));
    const currentUserRes = await query(
      `SELECT living_in_city_mode, is_premium, premium_started_at, premium_expires_at
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
    const currentLivingInCityMode = currentUserRes.rows[0].living_in_city_mode || "FOLLOW_DEVICE";
    const premiumStartMs = currentUserRes.rows[0].premium_started_at
      ? new Date(currentUserRes.rows[0].premium_started_at).getTime()
      : null;
    const premiumExpiryMs = currentUserRes.rows[0].premium_expires_at
      ? new Date(currentUserRes.rows[0].premium_expires_at).getTime()
      : null;
    const nowMs = Date.now();
    const hasActivePremiumWindow =
      Number.isFinite(premiumStartMs) &&
      Number.isFinite(premiumExpiryMs) &&
      premiumStartMs <= nowMs &&
      nowMs < premiumExpiryMs;
    const isPremiumUser = currentUserRes.rows[0].is_premium === true || hasActivePremiumWindow;
    const requestedLivingInCityMode = hasOwn(body, "livingInCityMode")
      ? normalizeLivingInCityMode(livingInCityMode)
      : null;
    if (hasOwn(body, "livingInCityMode") && !requestedLivingInCityMode) {
      return res.status(400).json({
        success: false,
        message: "livingInCityMode must be FOLLOW_DEVICE or MANUAL_SWITCH",
      });
    }
    if (requestedLivingInCityMode === "MANUAL_SWITCH" && !isPremiumUser) {
      return res.status(403).json({
        success: false,
        code: "PREMIUM_REQUIRED",
        message: "Manual city switch requires an active premium window",
      });
    }
    const effectiveLivingInCityMode = requestedLivingInCityMode || currentLivingInCityMode;

    const shouldPersistLocation = locationGranted === true && hasCoordinates;
    const cityState = shouldPersistLocation
      ? geocoderService.getCityAndState(Number(latitude), Number(longitude))
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
      if (
        !hasOwn(body, "livingInCity") &&
        effectiveLivingInCityMode === "FOLLOW_DEVICE" &&
        suppressLivingInAutofill !== true
      ) {
        addSet("living_in_city", cityState?.cityStateLabel ?? null);
      }
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

      await client.query(
        `INSERT INTO user_filters (user_id) VALUES ($1)
         ON CONFLICT (user_id) DO NOTHING`,
        [userId]
      );
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
    const cityState = geocoderService.getCityAndState(lat, lng);
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
    const cities = geocoderService.getAllIndianCities();
    return res.status(200).json({
      success: true,
      message: "Indian cities fetched",
      data: {
        cities,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch Indian cities",
      error: error.message,
    });
  }
}

module.exports = {
  getMe,
  updateOnboardingStep,
  updateProfileCore,
  updateOnboardingData,
  reverseGeocodeLocation,
  listIndianCities,
};
