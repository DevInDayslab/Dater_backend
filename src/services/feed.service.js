const crypto = require("crypto");
const {
  advMatchMaritalAnd,
  advMatchDrinkingAnd,
  advMatchSmokingAnd,
  advMatchEthnicityAnd,
} = require("../utils/advancedFilterMatchSql");
const { query } = require("../config/db");
const socialService = require("./social.service");
const { buildRelationshipState } = socialService;
const { displayNameForPrivacy } = require("../utils/displayName");
const { normalizeExpiredPauseForUser } = require("./accountLifecycle.service");
const s3Media = require("./s3Media.service");
const { resolveIndiaBrowseAnchor } = require("./geocoder.service");

const FEED_PAGE_SIZE_DEFAULT = 20;
const FEED_PAGE_SIZE_MAX = 25;

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/** Stable per-session tie-break for feed ordering (client sends same seed for pagination). */
function normalizeFeedShuffleSeed(raw) {
  const s = String(raw ?? "")
    .trim()
    .slice(0, 128);
  return s.length > 0 ? s : "default";
}

function md5TieBreak(seed, userId) {
  return crypto.createHash("md5").update(`${seed}|${userId}`).digest("hex");
}

async function getViewerContext(userId) {
  const res = await query(
    `SELECT u.id,
            u.name,
            u.age_years,
            u.gender_main,
            u.is_verified,
            u.is_premium,
            u.account_state,
            u.location,
            u.location_granted,
            u.living_in_city,
            uf.distance_pref_km,
            uf.age_min,
            uf.age_max,
            uf.expand_age_range,
            uf.expand_distance,
            uf.only_verified_profiles,
            uf.preferred_location_city,
            COALESCE((
              SELECT array_agg(gender ORDER BY gender)
              FROM user_filter_preferred_genders
              WHERE user_id = u.id
            ), ARRAY[]::varchar[]) AS preferred_genders
     FROM users u
     JOIN user_filters uf ON uf.user_id = u.id
     WHERE u.id = $1
     LIMIT 1`,
    [userId]
  );
  return res.rows[0] || null;
}

/** backend_raw.md: default window ±5 from viewer age, hard bounds 18–80, slider min span 4; expand applies ±5 on both sides. */
function resolveFeedAgeBounds(viewer) {
  const selfAge = Number(viewer.age_years);
  let ageMin = Number(viewer.age_min);
  let ageMax = Number(viewer.age_max);
  if (!Number.isFinite(ageMin)) {
    ageMin = Number.isFinite(selfAge) ? Math.max(18, selfAge - 5) : 20;
  }
  if (!Number.isFinite(ageMax)) {
    ageMax = Number.isFinite(selfAge) ? Math.min(80, selfAge + 5) : 36;
  }
  ageMin = clamp(ageMin, 18, 100, 20);
  ageMax = clamp(ageMax, 18, 100, 36);
  if (viewer.expand_age_range === true) {
    ageMin = Math.max(18, Math.round(ageMin - 5));
    ageMax = Math.min(80, Math.round(ageMax + 5));
  }
  if (ageMax - ageMin < 4) {
    const mid = Math.round((ageMin + ageMax) / 2);
    ageMin = Math.max(18, mid - 2);
    ageMax = Math.min(80, mid + 2);
    if (ageMax - ageMin < 4) {
      ageMax = Math.min(80, ageMin + 4);
    }
  }
  if (ageMax < ageMin) {
    const t = ageMin;
    ageMin = ageMax;
    ageMax = t;
  }
  return { ageMin, ageMax };
}

/** backend_raw.md: default 20km, 2–150; expand_distance widens radius (not one-sided). */
function resolveFeedDistanceKm(viewer) {
  let distanceKm = Number(viewer.distance_pref_km) || 20;
  if (distanceKm < 2) distanceKm = 2;
  if (distanceKm > 150) distanceKm = 150;
  if (viewer.expand_distance === true) {
    distanceKm = Math.min(150, Math.round(distanceKm * 1.75));
  }
  return distanceKm;
}

/**
 * Safety backfill: some completed users may have legacy/null gender_main while gender is present.
 * Feed matching relies on gender_main for reciprocal filters, so normalize it lazily.
 */
async function ensureCompletedUsersGenderMainFallback() {
  await query(
    `UPDATE users
     SET gender_main = gender,
         updated_at = NOW()
     WHERE onboarding_completed_at IS NOT NULL
       AND gender_main IS NULL
       AND NULLIF(TRIM(gender), '') IS NOT NULL`
  );
}

async function getFeed(userId, { page = 1, pageSize = FEED_PAGE_SIZE_DEFAULT, shuffleSeed } = {}) {
  const feedShuffleSeed = normalizeFeedShuffleSeed(shuffleSeed);
  await ensureCompletedUsersGenderMainFallback();
  await normalizeExpiredPauseForUser(userId);
  const viewer = await getViewerContext(userId);
  if (!viewer) {
    return { code: "VIEWER_NOT_FOUND", message: "Viewer not found" };
  }

  const normalizedPage = clamp(page, 1, 1000, 1);
  const normalizedPageSize = clamp(pageSize, 1, FEED_PAGE_SIZE_MAX, FEED_PAGE_SIZE_DEFAULT);
  const offset = (normalizedPage - 1) * normalizedPageSize;
  const viewUsage = await socialService.getRollingProfileViewSummary(userId);

  if (String(viewer.account_state) === "PAUSED") {
    const viewerHasActiveBoostRes = await query(
      `SELECT 1
       FROM premium_boosts
       WHERE user_id = $1
         AND started_at <= NOW()
         AND expires_at > NOW()
       LIMIT 1`,
      [userId]
    );
    const hasActiveBoost = viewerHasActiveBoostRes.rowCount > 0;
    return {
      feedPaused: true,
      cards: [],
      sections: [],
      page: normalizedPage,
      pageSize: normalizedPageSize,
      totalRegularPool: 0,
      totalCandidatePool: 0,
      hasMore: false,
      viewer: {
        isVerified: viewer.is_verified === true,
        isPremium: viewer.is_premium === true,
        hasActiveBoost,
        locationGranted: viewer.location_granted === true,
        freeDailyViewLimit: viewUsage.freeDailyViewLimit,
        todayViewCount: viewUsage.rollingCount24h,
        remainingFreeViews: viewUsage.remainingFreeViews,
        profileViewLimitActive: viewUsage.profileViewLimitActive,
        profileViewsUnlockAt: viewUsage.profileViewsUnlockAt,
      },
    };
  }

  const distanceKm = resolveFeedDistanceKm(viewer);
  const { ageMin, ageMax } = resolveFeedAgeBounds(viewer);
  const prefCityRaw = String(viewer.preferred_location_city || "").trim();
  const browseAnchorCoords = prefCityRaw ? resolveIndiaBrowseAnchor(prefCityRaw) : null;
  const browseAnchorLat = browseAnchorCoords != null ? browseAnchorCoords.lat : null;
  const browseAnchorLng = browseAnchorCoords != null ? browseAnchorCoords.lng : null;

  let feedPoolRes = await query(
    `WITH viewer AS (
       SELECT u.id AS user_id,
              $2::integer AS distance_km,
              $3::smallint AS age_min,
              $4::smallint AS age_max,
              $5::boolean AS only_verified,
              COALESCE((
                SELECT array_agg(ufg.gender ORDER BY ufg.gender)
                FROM user_filter_preferred_genders ufg
                WHERE ufg.user_id = u.id
              ), ARRAY[]::varchar[]) AS preferred_genders,
              -- Feed browse locale is filter-only (premium switch city or current GPS); not profile living_in_city.
              uf.preferred_location_city AS preferred_location_city,
              (uf.preferred_location_city IS NOT NULL AND NULLIF(TRIM(uf.preferred_location_city), '') IS NOT NULL) AS using_switch_city,
              (COALESCE(u.is_premium, FALSE)
                OR (u.premium_expires_at IS NOT NULL AND u.premium_expires_at > NOW())) AS premium_effective,
              uf.min_height_inches AS filter_min_height_inches,
              uf.max_height_inches AS filter_max_height_inches,
              COALESCE(uf.show_other_people_if_run_out, TRUE) AS show_other_people_if_run_out,
              COALESCE((
                SELECT array_agg(language ORDER BY language)
                FROM user_filter_languages WHERE user_id = u.id
              ), ARRAY[]::varchar[]) AS filter_languages,
              COALESCE((
                SELECT array_agg(marital_status ORDER BY marital_status)
                FROM user_filter_marital_statuses WHERE user_id = u.id
              ), ARRAY[]::varchar[]) AS filter_marital_statuses,
              COALESCE((
                SELECT array_agg(looking_for_option ORDER BY looking_for_option)
                FROM user_filter_looking_for WHERE user_id = u.id
              ), ARRAY[]::varchar[]) AS filter_looking_for,
              COALESCE((
                SELECT array_agg(drinking_option ORDER BY drinking_option)
                FROM user_filter_drinking_preferences WHERE user_id = u.id
              ), ARRAY[]::varchar[]) AS filter_drinking,
              COALESCE((
                SELECT array_agg(smoking_option ORDER BY smoking_option)
                FROM user_filter_smoking_preferences WHERE user_id = u.id
              ), ARRAY[]::varchar[]) AS filter_smoking,
              COALESCE((
                SELECT array_agg(exercise_option ORDER BY exercise_option)
                FROM user_filter_exercise_preferences WHERE user_id = u.id
              ), ARRAY[]::varchar[]) AS filter_exercise,
              COALESCE((
                SELECT array_agg(religion_option ORDER BY religion_option)
                FROM user_filter_religion_preferences WHERE user_id = u.id
              ), ARRAY[]::varchar[]) AS filter_religion,
              COALESCE((
                SELECT array_agg(education_option ORDER BY education_option)
                FROM user_filter_education_preferences WHERE user_id = u.id
              ), ARRAY[]::varchar[]) AS filter_education,
              COALESCE((
                SELECT array_agg(star_sign_option ORDER BY star_sign_option)
                FROM user_filter_star_sign_preferences WHERE user_id = u.id
              ), ARRAY[]::varchar[]) AS filter_star_sign,
              COALESCE((
                SELECT array_agg(kids_option ORDER BY kids_option)
                FROM user_filter_kids_preferences WHERE user_id = u.id
              ), ARRAY[]::varchar[]) AS filter_kids,
              COALESCE((
                SELECT array_agg(political_option ORDER BY political_option)
                FROM user_filter_political_preferences WHERE user_id = u.id
              ), ARRAY[]::varchar[]) AS filter_political,
              COALESCE((
                SELECT array_agg(pet_option ORDER BY pet_option)
                FROM user_filter_pet_preferences WHERE user_id = u.id
              ), ARRAY[]::varchar[]) AS filter_pets,
              COALESCE((
                SELECT array_agg(ethnicity_option ORDER BY ethnicity_option)
                FROM user_filter_ethnicity_preferences WHERE user_id = u.id
              ), ARRAY[]::varchar[]) AS filter_ethnicity,
              COALESCE((
                SELECT array_agg(pronoun_option ORDER BY pronoun_option)
                FROM user_filter_pronoun_preferences WHERE user_id = u.id
              ), ARRAY[]::varchar[]) AS filter_pronouns,
              (
                uf.min_height_inches IS NOT NULL
                OR uf.max_height_inches IS NOT NULL
                OR EXISTS (SELECT 1 FROM user_filter_marital_statuses WHERE user_id = u.id LIMIT 1)
                OR EXISTS (SELECT 1 FROM user_filter_looking_for WHERE user_id = u.id LIMIT 1)
                OR EXISTS (SELECT 1 FROM user_filter_drinking_preferences WHERE user_id = u.id LIMIT 1)
                OR EXISTS (SELECT 1 FROM user_filter_smoking_preferences WHERE user_id = u.id LIMIT 1)
                OR EXISTS (SELECT 1 FROM user_filter_exercise_preferences WHERE user_id = u.id LIMIT 1)
                OR EXISTS (SELECT 1 FROM user_filter_religion_preferences WHERE user_id = u.id LIMIT 1)
                OR EXISTS (SELECT 1 FROM user_filter_education_preferences WHERE user_id = u.id LIMIT 1)
                OR EXISTS (SELECT 1 FROM user_filter_star_sign_preferences WHERE user_id = u.id LIMIT 1)
                OR EXISTS (SELECT 1 FROM user_filter_kids_preferences WHERE user_id = u.id LIMIT 1)
                OR EXISTS (SELECT 1 FROM user_filter_political_preferences WHERE user_id = u.id LIMIT 1)
                OR EXISTS (SELECT 1 FROM user_filter_pet_preferences WHERE user_id = u.id LIMIT 1)
                OR EXISTS (SELECT 1 FROM user_filter_ethnicity_preferences WHERE user_id = u.id LIMIT 1)
                OR EXISTS (SELECT 1 FROM user_filter_pronoun_preferences WHERE user_id = u.id LIMIT 1)
              ) AS filter_advanced_active,
              $7::double precision AS browse_anchor_lat,
              $8::double precision AS browse_anchor_lng,
              CASE
                WHEN $7::double precision IS NOT NULL AND $8::double precision IS NOT NULL THEN
                  ST_SetSRID(ST_MakePoint($8::double precision, $7::double precision), 4326)::geography
                ELSE NULL::geography
              END AS browse_anchor_geog
       FROM users u
       JOIN user_filters uf ON uf.user_id = u.id
       WHERE u.id = $1::uuid
     ),
     candidate_staging AS (
       SELECT c.id,
              c.name,
              c.hide_my_name,
              c.age_years,
              c.marital_status,
              c.gender,
              c.show_gender_on_profile,
              c.is_verified,
              c.is_premium,
              c.account_state,
              c.profile_completion_percentage,
              c.last_active_at,
              c.new_here_until,
              c.living_in_city,
              COALESCE(pb.boost_active, FALSE) AS boost_active,
              CASE
                WHEN v.using_switch_city = TRUE
                  AND v.browse_anchor_geog IS NOT NULL
                  AND c.location IS NOT NULL THEN
                  ST_Distance(c.location::geography, v.browse_anchor_geog) / 1000.0
                WHEN vu.location IS NOT NULL AND c.location IS NOT NULL THEN
                  ST_Distance(c.location::geography, vu.location::geography) / 1000.0
                ELSE NULL
              END AS distance_km,
              COALESCE((
                SELECT up.photo_url
                FROM user_photos up
                WHERE up.user_id = c.id
                  AND up.deleted_at IS NULL
                ORDER BY up.is_primary DESC, up.photo_order ASC
                LIMIT 1
              ), '') AS primary_photo_url,
              (
                CASE WHEN COALESCE(pb.boost_active, FALSE) THEN 100 ELSE 0 END
                + CASE
                    WHEN c.last_active_at >= NOW() - INTERVAL '2 minutes' THEN 40
                    WHEN c.last_active_at >= NOW() - INTERVAL '5 minutes' THEN 35
                    WHEN c.last_active_at >= NOW() - INTERVAL '30 minutes' THEN 30
                    WHEN c.last_active_at >= NOW() - INTERVAL '1 hour' THEN 25
                    WHEN c.last_active_at >= NOW() - INTERVAL '1 day' THEN 20
                    WHEN c.last_active_at >= NOW() - INTERVAL '3 days' THEN 15
                    WHEN c.last_active_at >= NOW() - INTERVAL '7 days' THEN 10
                    WHEN c.last_active_at >= NOW() - INTERVAL '1 month' THEN 5
                    ELSE 0
                  END
                + LEAST(COALESCE(c.profile_completion_percentage, 0), 100) * 0.3
                + CASE WHEN c.new_here_until IS NOT NULL AND c.new_here_until > NOW() THEN 10 ELSE 0 END
                + CASE WHEN c.is_premium THEN 15 ELSE 0 END
              ) AS score,
              (
                NOT v.premium_effective
                OR (
                  (v.filter_min_height_inches IS NULL OR c.height_inches IS NULL OR c.height_inches >= v.filter_min_height_inches)
                  AND (v.filter_max_height_inches IS NULL OR c.height_inches IS NULL OR c.height_inches <= v.filter_max_height_inches)
${advMatchMaritalAnd}
                  AND (
                    CARDINALITY(v.filter_looking_for) = 0
                    OR EXISTS (
                      SELECT 1
                      FROM user_looking_for clf
                      WHERE clf.user_id = c.id
                        AND clf.looking_for_option = ANY(v.filter_looking_for)
                    )
                  )
${advMatchDrinkingAnd}
${advMatchSmokingAnd}
                  AND (CARDINALITY(v.filter_exercise) = 0 OR (c.exercise IS NOT NULL AND c.exercise = ANY(v.filter_exercise)))
                  AND (CARDINALITY(v.filter_religion) = 0 OR (c.religion IS NOT NULL AND c.religion = ANY(v.filter_religion)))
                  AND (CARDINALITY(v.filter_education) = 0 OR (c.education IS NOT NULL AND c.education = ANY(v.filter_education)))
                  AND (CARDINALITY(v.filter_star_sign) = 0 OR (c.star_sign IS NOT NULL AND c.star_sign = ANY(v.filter_star_sign)))
                  AND (CARDINALITY(v.filter_kids) = 0 OR (c.kids IS NOT NULL AND c.kids = ANY(v.filter_kids)))
                  AND (CARDINALITY(v.filter_political) = 0 OR (c.political_leanings IS NOT NULL AND c.political_leanings = ANY(v.filter_political)))
                  AND (CARDINALITY(v.filter_pets) = 0 OR (c.pets IS NOT NULL AND c.pets = ANY(v.filter_pets)))
${advMatchEthnicityAnd}
                  AND (
                    CARDINALITY(v.filter_pronouns) = 0
                    OR EXISTS (
                      SELECT 1
                      FROM user_pronouns cp
                      WHERE cp.user_id = c.id
                        AND cp.pronoun = ANY(v.filter_pronouns)
                    )
                  )
                )
              ) AS adv_match
       FROM users c
       JOIN users vu ON vu.id = $1::uuid
       CROSS JOIN viewer v
       LEFT JOIN LATERAL (
         SELECT TRUE AS boost_active
         FROM premium_boosts pb
         WHERE pb.user_id = c.id
           AND pb.started_at <= NOW()
           AND pb.expires_at > NOW()
         LIMIT 1
       ) pb ON TRUE
       WHERE c.id <> v.user_id
         AND c.deleted_at IS NULL
         AND c.account_state = 'ACTIVE'
         AND (v.only_verified = FALSE OR c.is_verified = TRUE)
         AND (
           (
             vu.location IS NOT NULL
             AND c.location IS NOT NULL
             AND (
              (
                -- Resolved browse anchor: show everyone within viewer radius of that point (city labels may differ).
                v.using_switch_city = TRUE
                AND v.browse_anchor_geog IS NOT NULL
                AND ST_DWithin(
                  c.location::geography,
                  v.browse_anchor_geog,
                  (v.distance_km * 1000)::double precision
                )
              )
               OR (
                 -- Switch city but anchor could not be resolved: fall back to living_in_city string match.
                 v.using_switch_city = TRUE
                 AND v.browse_anchor_geog IS NULL
                 AND NULLIF(TRIM(c.living_in_city), '') IS NOT NULL
                 AND NULLIF(TRIM(v.preferred_location_city), '') IS NOT NULL
                 AND (
                   LOWER(TRIM(c.living_in_city)) = LOWER(TRIM(v.preferred_location_city))
                   OR LOWER(TRIM(SPLIT_PART(c.living_in_city, ',', 1))) =
                      LOWER(TRIM(SPLIT_PART(v.preferred_location_city, ',', 1)))
                 )
               )
               OR (
                 v.using_switch_city = FALSE
                 AND ST_DWithin(
                   c.location::geography,
                   vu.location::geography,
                   (v.distance_km * 1000)::double precision
                 )
               )
             )
           )
           OR (
             vu.location IS NULL
             AND v.using_switch_city = TRUE
             AND v.browse_anchor_geog IS NOT NULL
             AND c.location IS NOT NULL
             AND ST_DWithin(
               c.location::geography,
               v.browse_anchor_geog,
               (v.distance_km * 1000)::double precision
             )
           )
         )
         AND EXISTS (
           SELECT 1
           FROM user_filters cdf
           WHERE cdf.user_id = c.id
             AND (
               (
                 vu.location IS NOT NULL
                 AND c.location IS NOT NULL
                 AND (
                   (
                     v.using_switch_city = TRUE
                     AND v.browse_anchor_geog IS NOT NULL
                     AND ST_DWithin(
                       c.location::geography,
                       v.browse_anchor_geog,
                       (
                         LEAST(
                           150,
                           CASE
                             WHEN COALESCE(cdf.expand_distance, FALSE)
                               THEN ROUND(LEAST(150, GREATEST(2, COALESCE(cdf.distance_pref_km, 20))) * 1.75)
                             ELSE LEAST(150, GREATEST(2, COALESCE(cdf.distance_pref_km, 20)))
                           END
                         ) * 1000
                       )::double precision
                     )
                   )
                   OR (
                     v.using_switch_city = FALSE
                     AND ST_DWithin(
                       c.location::geography,
                       vu.location::geography,
                       (
                         LEAST(
                           150,
                           CASE
                             WHEN COALESCE(cdf.expand_distance, FALSE)
                               THEN ROUND(LEAST(150, GREATEST(2, COALESCE(cdf.distance_pref_km, 20))) * 1.75)
                             ELSE LEAST(150, GREATEST(2, COALESCE(cdf.distance_pref_km, 20)))
                           END
                         ) * 1000
                       )::double precision
                     )
                   )
                   OR (
                     v.using_switch_city = TRUE
                     AND v.browse_anchor_geog IS NULL
                     AND NULLIF(TRIM(v.preferred_location_city), '') IS NOT NULL
                     AND NULLIF(TRIM(cdf.preferred_location_city), '') IS NOT NULL
                     AND (
                       LOWER(TRIM(v.preferred_location_city)) = LOWER(TRIM(cdf.preferred_location_city))
                       OR LOWER(TRIM(SPLIT_PART(v.preferred_location_city, ',', 1))) =
                          LOWER(TRIM(SPLIT_PART(cdf.preferred_location_city, ',', 1)))
                     )
                   )
                 )
               )
               OR (
                 vu.location IS NULL
                 AND NULLIF(TRIM(v.preferred_location_city), '') IS NOT NULL
                 AND NULLIF(TRIM(cdf.preferred_location_city), '') IS NOT NULL
                 AND (
                   LOWER(TRIM(v.preferred_location_city)) = LOWER(TRIM(cdf.preferred_location_city))
                   OR LOWER(TRIM(SPLIT_PART(v.preferred_location_city, ',', 1))) =
                      LOWER(TRIM(SPLIT_PART(cdf.preferred_location_city, ',', 1)))
                 )
               )
             )
         )
         AND c.age_years BETWEEN v.age_min AND v.age_max
        AND (
          EXISTS (
            SELECT 1
            FROM user_filter_preferred_genders ufg
            WHERE ufg.user_id = v.user_id
              AND ufg.gender = c.gender_main
          )
          OR NOT EXISTS (
            SELECT 1 FROM user_filter_preferred_genders WHERE user_id = v.user_id
          )
        )
        AND (
          EXISTS (
            SELECT 1
            FROM user_filter_preferred_genders cufg
            WHERE cufg.user_id = c.id
              AND cufg.gender = vu.gender_main
          )
          OR NOT EXISTS (
            SELECT 1 FROM user_filter_preferred_genders WHERE user_id = c.id
          )
        )
         AND EXISTS (
           SELECT 1
           FROM user_filters cf
           WHERE cf.user_id = c.id
             AND vu.age_years BETWEEN cf.age_min AND cf.age_max
         )
         AND NOT EXISTS (
           SELECT 1
           FROM friendships f
           WHERE (f.u1_id = v.user_id AND f.u2_id = c.id)
              OR (f.u1_id = c.id AND f.u2_id = v.user_id)
         )
         AND NOT EXISTS (
           SELECT 1
           FROM blocks b
           WHERE (b.blocker_id = v.user_id AND b.blocked_id = c.id)
              OR (b.blocker_id = c.id AND b.blocked_id = v.user_id)
         )
         AND NOT EXISTS (
           SELECT 1
           FROM user_interactions ui
           WHERE ui.user_id = v.user_id
             AND ui.target_id = c.id
             AND (
               (ui.interaction_type IN ('IGNORE', 'VIEWED') AND ui.expires_at > NOW())
              OR (ui.interaction_type IN ('REQUEST', 'COMMENT_REQUEST') AND ui.request_status = 'IGNORED')
              OR (ui.interaction_type IN ('REQUEST', 'COMMENT_REQUEST') AND ui.request_status = 'PENDING')
             )
         )
        -- Mutual-ignore: if either side ignored the other (and it's still active), hide both ways.
        AND NOT EXISTS (
          SELECT 1
          FROM user_interactions ui
          WHERE ui.user_id = c.id
            AND ui.target_id = v.user_id
            AND ui.interaction_type = 'IGNORE'
            AND ui.expires_at > NOW()
        )
         AND NOT EXISTS (
           SELECT 1
           FROM user_interactions ui
           WHERE ui.user_id = c.id
             AND ui.target_id = v.user_id
            AND ui.interaction_type IN ('REQUEST', 'COMMENT_REQUEST')
            AND ui.request_status IN ('IGNORED', 'PENDING')
         )
         AND (
           CARDINALITY(v.filter_languages) = 0
           OR EXISTS (
             SELECT 1
             FROM user_languages cl
             WHERE cl.user_id = c.id
               AND cl.language = ANY(v.filter_languages)
           )
         )
     ),
     candidates AS (
       SELECT
         id,
         name,
         hide_my_name,
         age_years,
         marital_status,
         gender,
         show_gender_on_profile,
         is_verified,
         is_premium,
         account_state,
         profile_completion_percentage,
         last_active_at,
         new_here_until,
         living_in_city,
         boost_active,
         distance_km,
         primary_photo_url,
         score,
         0 AS feed_match_rank
       FROM candidate_staging
       WHERE adv_match
       UNION ALL
       SELECT
         cs.id,
         cs.name,
         cs.hide_my_name,
         cs.age_years,
         cs.marital_status,
         cs.gender,
         cs.show_gender_on_profile,
         cs.is_verified,
         cs.is_premium,
         cs.account_state,
         cs.profile_completion_percentage,
         cs.last_active_at,
         cs.new_here_until,
         cs.living_in_city,
         cs.boost_active,
         cs.distance_km,
         cs.primary_photo_url,
         GREATEST(0::double precision, cs.score - 40::double precision) AS score,
         1 AS feed_match_rank
       FROM candidate_staging cs
       CROSS JOIN viewer v
       WHERE NOT cs.adv_match
         AND v.premium_effective
         AND v.show_other_people_if_run_out
         AND v.filter_advanced_active
     ),
     enriched AS (
       SELECT candidates.*,
              EXISTS (
                SELECT 1
                FROM friendships f
                WHERE f.u1_id = LEAST($1::uuid, candidates.id)
                  AND f.u2_id = GREATEST($1::uuid, candidates.id)
              ) AS is_friend,
              EXISTS (
                SELECT 1
                FROM user_interactions ui
                WHERE ui.user_id = $1::uuid
                  AND ui.target_id = candidates.id
                  AND ui.interaction_type IN ('REQUEST', 'COMMENT_REQUEST')
                  AND ui.request_status = 'PENDING'
              ) AS viewer_sent_pending,
              EXISTS (
                SELECT 1
                FROM user_interactions ui
                WHERE ui.user_id = candidates.id
                  AND ui.target_id = $1::uuid
                  AND ui.interaction_type IN ('REQUEST', 'COMMENT_REQUEST')
                  AND ui.request_status = 'PENDING'
              ) AS target_sent_pending,
              EXISTS (
                SELECT 1
                FROM user_interactions ui
                WHERE ui.user_id = $1::uuid
                  AND ui.target_id = candidates.id
                  AND ui.interaction_type = 'IGNORE'
                  AND ui.expires_at > NOW()
              ) AS viewer_ignored,
              (
                COALESCE((
                  SELECT COUNT(*)
                  FROM user_interests vi
                  JOIN user_interests ci
                    ON ci.user_id = candidates.id
                   AND ci.interest = vi.interest
                  WHERE vi.user_id = $1::uuid
                ), 0)
                + COALESCE((
                  SELECT COUNT(*)
                  FROM user_looking_for vl
                  JOIN user_looking_for cl
                    ON cl.user_id = candidates.id
                   AND cl.looking_for_option = vl.looking_for_option
                  WHERE vl.user_id = $1::uuid
                ), 0)
                + COALESCE((
                  SELECT COUNT(*)
                  FROM user_languages vl
                  JOIN user_languages cl
                    ON cl.user_id = candidates.id
                   AND cl.language = vl.language
                  WHERE vl.user_id = $1::uuid
                ), 0)
              ) AS suggested_score
       FROM candidates
     )
     SELECT *
     FROM enriched
     ORDER BY feed_match_rank ASC,
              score DESC,
              suggested_score DESC,
              md5($6::text || id::text)`,
    [
      userId,
      distanceKm,
      ageMin,
      ageMax,
      viewer.is_verified === true ? viewer.only_verified_profiles === true : false,
      feedShuffleSeed,
      browseAnchorLat,
      browseAnchorLng,
    ]
  );

  const allCandidates = await Promise.all(
    feedPoolRes.rows.map(async (row) => ({
      userId: row.id,
      name: displayNameForPrivacy(row.name, row.hide_my_name === true),
      age: Number(row.age_years || 0),
      gender: row.show_gender_on_profile === false ? "" : row.gender || "",
      status: row.marital_status || "",
      verified: row.is_verified === true,
      premium: row.is_premium === true,
      primaryPhotoUrl: await s3Media.presignReadIfOurS3Object(row.primary_photo_url || ""),
      distanceKm: row.distance_km == null ? null : Number(Number(row.distance_km).toFixed(1)),
      score: Number(Number(row.score || 0).toFixed(2)),
      suggestedScore: Number(row.suggested_score || 0),
      isNewHere: row.new_here_until != null && new Date(row.new_here_until).getTime() > Date.now(),
      livingInCity: row.living_in_city || "",
      relationshipState: buildRelationshipState({
        is_friend: row.is_friend === true,
        target_sent_pending: row.target_sent_pending === true,
        viewer_ignored: row.viewer_ignored === true,
        viewer_sent_pending: row.viewer_sent_pending === true,
      }),
    }))
  );

  const shouldShowSuggested = allCandidates.length >= 30;
  const suggestedProfiles = shouldShowSuggested
    ? [...allCandidates]
        .sort((a, b) => {
          const primary = b.suggestedScore - a.suggestedScore || b.score - a.score;
          if (primary !== 0) return primary;
          return md5TieBreak(feedShuffleSeed, a.userId).localeCompare(md5TieBreak(feedShuffleSeed, b.userId));
        })
        .slice(0, 10)
    : [];
  const suggestedIds = new Set(suggestedProfiles.map((p) => p.userId));
  const regularProfiles = allCandidates.filter((p) => !suggestedIds.has(p.userId));
  const pageProfiles = regularProfiles.slice(offset, offset + normalizedPageSize);
  const viewerHasActiveBoostRes = await query(
    `SELECT 1
     FROM premium_boosts
     WHERE user_id = $1
       AND started_at <= NOW()
       AND expires_at > NOW()
     LIMIT 1`,
    [userId]
  );
  const hasActiveBoost = viewerHasActiveBoostRes.rowCount > 0;

  const sections = [];
  if (shouldShowSuggested) {
    sections.push({
      kind: "suggested",
      insertAfterCards: 10,
      title: "Suggested For You",
      profiles: suggestedProfiles,
    });
  }
  if (viewer.is_verified !== true) {
    sections.push({
      kind: "verify_banner",
      insertAfterCards: shouldShowSuggested ? 16 : 10,
    });
  }
  if (!hasActiveBoost && (viewer.is_verified === true || allCandidates.length >= 30)) {
    sections.push({
      kind: "boost_banner",
      insertAfterCards: shouldShowSuggested ? 28 : viewer.is_verified ? 22 : 0,
    });
  }

  return {
    feedPaused: false,
    cards: pageProfiles,
    sections,
    page: normalizedPage,
    pageSize: normalizedPageSize,
    totalRegularPool: regularProfiles.length,
    totalCandidatePool: allCandidates.length,
    hasMore: offset + normalizedPageSize < regularProfiles.length,
    viewer: {
      isVerified: viewer.is_verified === true,
      isPremium: viewer.is_premium === true,
      hasActiveBoost,
      locationGranted: viewer.location_granted === true,
      freeDailyViewLimit: viewUsage.freeDailyViewLimit,
      todayViewCount: viewUsage.rollingCount24h,
      remainingFreeViews: viewUsage.remainingFreeViews,
      profileViewLimitActive: viewUsage.profileViewLimitActive,
      profileViewsUnlockAt: viewUsage.profileViewsUnlockAt,
    },
  };
}

module.exports = {
  getFeed,
};
