/**
 * Diagnose why viewer can/can't see candidate in feed (both directions).
 *
 * Usage (from backend/ with DATABASE_URL in .env):
 *   node src/scripts/diagnoseFeedPairByPhone.js 9354120990 9811700705
 */
require("dotenv").config();
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const { Client } = require("pg");
const { toE164 } = require("./seedFeedProfilesForViewerPhone");

function yn(v) {
  return v ? "YES" : "NO";
}

async function loadUser(client, phoneE164) {
  const res = await client.query(
    `SELECT u.id,
            u.phone_e164,
            u.name,
            u.gender_main,
            u.age_years,
            u.is_premium,
            u.premium_started_at,
            u.premium_expires_at,
            u.account_state,
            u.location_granted,
            u.location,
            (u.location IS NOT NULL) AS has_location,
            u.living_in_city,
            COALESCE(u.living_in_city_mode, 'FOLLOW_DEVICE') AS living_in_city_mode,
            uf.distance_pref_km,
            uf.expand_distance,
            uf.age_min,
            uf.age_max,
            uf.preferred_location_city
     FROM users u
     JOIN user_filters uf ON uf.user_id = u.id
     WHERE u.phone_e164 = $1
       AND u.deleted_at IS NULL
     LIMIT 1`,
    [phoneE164]
  );
  return res.rows[0] || null;
}

async function computeDistanceKm(client, aId, bId) {
  const res = await client.query(
    `SELECT ST_Distance(a.location::geography, b.location::geography) / 1000.0 AS km
     FROM users a
     JOIN users b ON b.id = $2::uuid
     WHERE a.id = $1::uuid
       AND a.location IS NOT NULL
       AND b.location IS NOT NULL`,
    [aId, bId]
  );
  return res.rows[0]?.km == null ? null : Number(res.rows[0].km);
}

function resolveEffectivePremium(user) {
  if (!user) return false;
  if (user.is_premium === true) return true;
  const start = user.premium_started_at ? new Date(user.premium_started_at).getTime() : null;
  const exp = user.premium_expires_at ? new Date(user.premium_expires_at).getTime() : null;
  const now = Date.now();
  return Number.isFinite(start) && Number.isFinite(exp) && start <= now && now < exp;
}

function normalizeCity(s) {
  return String(s || "").trim().toLowerCase();
}

function firstCityPart(s) {
  const raw = String(s || "").trim();
  if (!raw) return "";
  return raw.split(",")[0].trim().toLowerCase();
}

async function diagnoseDirection(client, viewer, candidate) {
  const out = {
    viewer: { phone: viewer.phone_e164, id: viewer.id, name: viewer.name },
    candidate: { phone: candidate.phone_e164, id: candidate.id, name: candidate.name },
    checks: {},
  };

  const distanceKm = await computeDistanceKm(client, viewer.id, candidate.id);
  out.distanceKm = distanceKm == null ? null : Number(distanceKm.toFixed(2));

  const viewerPremiumEffective = resolveEffectivePremium(viewer);
  const viewerUsingSwitchCity = Boolean(String(viewer.preferred_location_city || "").trim());

  // Candidate reciprocal location logic (feed.service):
  // When both users have coordinates, reciprocal is distance-based (switch-city must not block).
  // When coordinates are missing, we fall back to city-string matching.
  const candidateMode = String(candidate.living_in_city_mode || "FOLLOW_DEVICE").trim().toUpperCase();
  const candidateHasPreferredCity = Boolean(String(candidate.preferred_location_city || "").trim());
  const candidateSwitchCityEffective = String(
    candidateHasPreferredCity ? candidate.preferred_location_city : candidate.living_in_city
  ).trim();

  const viewerCity = String(viewer.living_in_city || "").trim();
  const cityMatch =
    normalizeCity(viewerCity) !== "" &&
    normalizeCity(candidateSwitchCityEffective) !== "" &&
    (normalizeCity(viewerCity) === normalizeCity(candidateSwitchCityEffective) ||
      firstCityPart(viewerCity) === firstCityPart(candidateSwitchCityEffective));

  const viewerDistanceKm = Math.min(
    150,
    Math.max(2, Math.round(Number(viewer.distance_pref_km || 20))) *
      (viewer.expand_distance ? 1.75 : 1)
  );
  const viewerDistancePass = distanceKm != null ? distanceKm <= viewerDistanceKm : false;

  out.checks.viewer_context = {
    premiumEffective: viewerPremiumEffective,
    usingSwitchCity: viewerUsingSwitchCity,
    preferredLocationCity: String(viewer.preferred_location_city || "").trim(),
    livingInCity: viewerCity,
    hasCoords: viewer.has_location === true,
    locationGranted: viewer.location_granted === true,
    distancePrefKm: Number(viewer.distance_pref_km || 0),
    expandDistance: viewer.expand_distance === true,
    resolvedDistanceKm: viewerDistanceKm,
  };

  out.checks.candidate_context = {
    livingInCityMode: candidateMode,
    livingInCity: String(candidate.living_in_city || "").trim(),
    preferredLocationCity: String(candidate.preferred_location_city || "").trim(),
    hasCoords: candidate.has_location === true,
  };

  out.checks.viewer_to_candidate_location_gate = {
    mode: viewerUsingSwitchCity ? "SWITCH_CITY_CITY_MATCH" : "DISTANCE",
    pass:
      viewerUsingSwitchCity
        ? (() => {
            const vPref = String(viewer.preferred_location_city || "").trim();
            const cCity = String(candidate.living_in_city || "").trim();
            return (
              vPref &&
              cCity &&
              (normalizeCity(vPref) === normalizeCity(cCity) ||
                firstCityPart(vPref) === firstCityPart(cCity))
            );
          })()
        : viewerDistancePass,
    details: viewerUsingSwitchCity
      ? {
          viewerPreferredLocationCity: String(viewer.preferred_location_city || "").trim(),
          candidateLivingInCity: String(candidate.living_in_city || "").trim(),
        }
      : {
          distanceKm: out.distanceKm,
          viewerResolvedRadiusKm: viewerDistanceKm,
        },
  };

  out.checks.candidate_reciprocal_location_gate = (() => {
    const cDistBase = Math.min(150, Math.max(2, Number(candidate.distance_pref_km || 20)));
    const cDist = candidate.expand_distance ? Math.round(cDistBase * 1.75) : cDistBase;
    const distancePass = distanceKm != null ? distanceKm <= cDist : false;

    if (viewer.has_location === true && candidate.has_location === true) {
      return {
        mode: "CANDIDATE_DISTANCE",
        pass: distancePass,
        details: {
          distanceKm: out.distanceKm,
          candidateDistancePrefKm: Number(candidate.distance_pref_km || 0),
          candidateExpandDistance: candidate.expand_distance === true,
        },
      };
    }

    return {
      mode: "CANDIDATE_CITY_FALLBACK",
      pass: cityMatch,
      details: {
        viewerLivingInCity: viewerCity,
        candidateSwitchCityEffective,
        cityMatch,
        candidateLivingInCityMode: candidateMode,
      },
    };
  })();

  // Quick top-level killers
  out.checks.top_level = {
    bothActive: viewer.account_state === "ACTIVE" && candidate.account_state === "ACTIVE",
    bothHaveCoords: viewer.has_location === true && candidate.has_location === true,
  };

  return out;
}

async function main() {
  const phoneA = process.argv[2];
  const phoneB = process.argv[3];
  if (!phoneA || !phoneB) {
    console.error("Usage: node src/scripts/diagnoseFeedPairByPhone.js <phoneA> <phoneB>");
    process.exitCode = 2;
    return;
  }
  const aE164 = toE164(phoneA);
  const bE164 = toE164(phoneB);

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    const a = await loadUser(client, aE164);
    const b = await loadUser(client, bE164);
    if (!a || !b) {
      console.log(JSON.stringify({ error: "NO_USER", aE164, bE164, aFound: !!a, bFound: !!b }, null, 2));
      process.exitCode = 1;
      return;
    }

    const aToB = await diagnoseDirection(client, a, b);
    const bToA = await diagnoseDirection(client, b, a);

    console.log(
      JSON.stringify(
        {
          summary: {
            a: { phone: a.phone_e164, name: a.name, mode: a.living_in_city_mode, preferred_location_city: a.preferred_location_city },
            b: { phone: b.phone_e164, name: b.name, mode: b.living_in_city_mode, preferred_location_city: b.preferred_location_city },
          },
          aSeesB: {
            viewerToCandidate: aToB.checks.viewer_to_candidate_location_gate,
            reciprocal: aToB.checks.candidate_reciprocal_location_gate,
          },
          bSeesA: {
            viewerToCandidate: bToA.checks.viewer_to_candidate_location_gate,
            reciprocal: bToA.checks.candidate_reciprocal_location_gate,
          },
          raw: { aToB, bToA },
        },
        null,
        2
      )
    );
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}

