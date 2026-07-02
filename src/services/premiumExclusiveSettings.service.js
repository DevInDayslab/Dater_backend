const { debugLog } = require("../utils/serverDebugLog");

const ADVANCED_FILTER_JUNCTION_TABLES = [
  "user_filter_marital_statuses",
  "user_filter_looking_for",
  "user_filter_drinking_preferences",
  "user_filter_smoking_preferences",
  "user_filter_exercise_preferences",
  "user_filter_religion_preferences",
  "user_filter_education_preferences",
  "user_filter_star_sign_preferences",
  "user_filter_kids_preferences",
  "user_filter_political_preferences",
  "user_filter_pet_preferences",
  "user_filter_ethnicity_preferences",
  "user_filter_pronoun_preferences",
];

/** Premium-only filter rows + height / show-other scalars — safe to call repeatedly. */
async function clearAdvancedFilterPreferencesFromDb(client, userId) {
  for (const table of ADVANCED_FILTER_JUNCTION_TABLES) {
    await client.query(`DELETE FROM ${table} WHERE user_id = $1`, [userId]);
  }
  await client.query(
    `UPDATE user_filters
     SET min_height_inches = NULL,
         max_height_inches = NULL,
         show_other_people_if_run_out = TRUE,
         updated_at = NOW()
     WHERE user_id = $1`,
    [userId]
  );
}

/** Response-only mask for non-premium clients — does not mutate DB (preserves settings across renewal). */
function stripPremiumExclusiveFiltersFromSnapshot(filters) {
  if (!filters) return filters;
  return {
    ...filters,
    selectedLocation: "__CURRENT_LOCATION__",
    usingSwitchCity: false,
    minHeightInches: null,
    maxHeightInches: null,
    showOtherPeopleIfRunOut: true,
    maritalStatuses: [],
    lookingFor: [],
    drinkingPreferences: [],
    smokingPreferences: [],
    exercisePreferences: [],
    religionPreferences: [],
    educationPreferences: [],
    starSignPreferences: [],
    kidsPreferences: [],
    politicalPreferences: [],
    petPreferences: [],
    ethnicityPreferences: [],
    pronounPreferences: [],
  };
}

/** Turn off privacy mode when premium access ends — always, including lazy /me sync. Idempotent. */
async function clearPrivacyModeOnPremiumLoss(client, userId) {
  const privacyRes = await client.query(
    `UPDATE users
     SET account_state = 'ACTIVE',
         updated_at = NOW()
     WHERE id = $1
       AND account_state = 'PRIVACY_MODE'
     RETURNING id`,
    [userId]
  );
  if (privacyRes.rowCount) {
    debugLog("premium_privacy_mode_cleared", { userId });
  }
  return Boolean(privacyRes.rowCount);
}

/**
 * Clears subscription-exclusive settings when premium access ends (filters + switch city + privacy).
 * Idempotent — use on confirmed Google EXPIRED / ON_HOLD / PAUSED only.
 */
async function revertPremiumExclusiveSettings(client, userId) {
  await client.query(
    `UPDATE user_filters
     SET preferred_location_city = NULL,
         updated_at = NOW()
     WHERE user_id = $1`,
    [userId]
  );
  await clearAdvancedFilterPreferencesFromDb(client, userId);
  const privacyModeCleared = await clearPrivacyModeOnPremiumLoss(client, userId);
  debugLog("premium_exclusive_settings_reverted", {
    userId,
    privacyModeCleared,
  });
}

module.exports = {
  ADVANCED_FILTER_JUNCTION_TABLES,
  clearAdvancedFilterPreferencesFromDb,
  clearPrivacyModeOnPremiumLoss,
  stripPremiumExclusiveFiltersFromSnapshot,
  revertPremiumExclusiveSettings,
};
