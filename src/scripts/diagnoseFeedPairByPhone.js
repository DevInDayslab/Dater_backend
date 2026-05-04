/**
 * Diagnose why viewer can/can't see candidate in feed (both directions).
 * Mirrors browse_anchor_geog logic: switch-city browsing uses india_cities anchor
 * for viewer→candidate radius and reciprocal ST_DWithin (not viewer GPS ↔ candidate).
 *
 * Usage (from backend/ with DATABASE_URL in .env):
 *   node src/scripts/diagnoseFeedPairByPhone.js <viewerPhone> <candidatePhone>
 *   node src/scripts/diagnoseFeedPairByPhone.js <viewerPhone> <candidatePhone> --integration
 *
 * --integration runs getFeed() for the viewer and checks whether the candidate user id
 * appears in cards or suggested (paginates until found or no more pages).
 */
require("dotenv").config();
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const { Client } = require("pg");
const { toE164 } = require("./seedFeedProfilesForViewerPhone");
const { resolveIndiaBrowseAnchor } = require("../services/geocoder.service");
const { getFeed } = require("../services/feed.service");

/** Same formula as feed.service.js resolveFeedDistanceKm */
function resolveViewerBrowsingDistanceKm(viewer) {
  let distanceKm = Number(viewer.distance_pref_km) || 20;
  if (distanceKm < 2) distanceKm = 2;
  if (distanceKm > 150) distanceKm = 150;
  if (viewer.expand_distance === true) {
    distanceKm = Math.min(150, Math.round(distanceKm * 1.75));
  }
  return distanceKm;
}

/** Candidate-side reciprocal radius (cdf row), matching feed SQL LEAST/ROUND rules */
function resolveCandidateReciprocalRadiusKm(candidate) {
  const inner = Math.min(150, Math.max(2, Number(candidate.distance_pref_km || 20)));
  const km =
    candidate.expand_distance === true ? Math.min(150, Math.round(inner * 1.75)) : inner;
  return km;
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

async function computeDistanceKmGps(client, aId, bId) {
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

async function computeDistanceKmCandidateToAnchor(client, candidateId, anchor) {
  if (!anchor || anchor.lat == null || anchor.lng == null) return null;
  const res = await client.query(
    `SELECT ST_Distance(
              u.location::geography,
              ST_SetSRID(ST_MakePoint($2::double precision, $1::double precision), 4326)::geography
            ) / 1000.0 AS km
     FROM users u
     WHERE u.id = $3::uuid
       AND u.location IS NOT NULL`,
    [anchor.lat, anchor.lng, candidateId]
  );
  return res.rows[0]?.km == null ? null : Number(Number(res.rows[0].km).toFixed(3));
}

async function sqlBool(client, sql, params) {
  const res = await client.query(sql, params);
  return res.rows[0]?.pass === true;
}

/** Viewer→candidate primary location gate when both have coordinates */
async function viewerToCandidatePrimaryGate(client, viewer, candidate, viewerBrowsingKm, browseAnchor, cityMatch) {
  const usingSwitch = Boolean(String(viewer.preferred_location_city || "").trim());

  if (!viewer.has_location || !candidate.has_location) {
    return {
      mode: "NO_PAIR_COORDS_USE_APP_SQL_FALLBACK",
      pass: null,
      note: "Requires vu.location AND c.location for GPS/switch+anchor branch in feed SQL",
    };
  }

  if (!usingSwitch) {
    const pass = await sqlBool(
      client,
      `SELECT ST_DWithin(
              c.location::geography,
              vu.location::geography,
              ($3 * 1000)::double precision
            ) AS pass
       FROM users vu
       JOIN users c ON c.id = $2::uuid
       WHERE vu.id = $1::uuid`,
      [viewer.id, candidate.id, viewerBrowsingKm]
    );
    return {
      mode: "GPS_VIEWER_RADIUS_ST_DWITHIN",
      pass,
      viewerBrowsingKm,
    };
  }

  if (browseAnchor) {
    const pass = await sqlBool(
      client,
      `SELECT ST_DWithin(
              c.location::geography,
              ST_SetSRID(ST_MakePoint($4::double precision, $3::double precision), 4326)::geography,
              ($5 * 1000)::double precision
            ) AS pass
       FROM users vu
       JOIN users c ON c.id = $2::uuid
       WHERE vu.id = $1::uuid`,
      [viewer.id, candidate.id, browseAnchor.lat, browseAnchor.lng, viewerBrowsingKm]
    );
    return {
      mode: "SWITCH_CITY_BROWSE_ANCHOR_ST_DWITHIN",
      pass,
      viewerBrowsingKm,
      browseAnchor: { lat: browseAnchor.lat, lng: browseAnchor.lng },
      livingCityMatchOptional: cityMatch,
      note: "With resolved anchor, feed does not require living_in_city text match.",
    };
  }

  return {
    mode: "SWITCH_CITY_STRING_GATE_ONLY_NO_ANCHOR",
    pass: cityMatch,
    viewerBrowsingKm,
    note: "browse_anchor_geog IS NULL → feed uses living_in_city string match vs preferred_location_city",
  };
}

/** Reciprocal EXISTS: candidate's filters vs viewer location / browse anchor */
async function candidateReciprocalGate(client, viewer, candidate, browseAnchor, viewerUsingSwitchCity) {
  if (!viewer.has_location || !candidate.has_location) {
    return {
      mode: "NO_PAIR_COORDS_CITY_FALLBACK_NOT_MODELED",
      pass: null,
    };
  }

  const reciprocalKm = resolveCandidateReciprocalRadiusKm(candidate);
  const meters = reciprocalKm * 1000;

  if (viewerUsingSwitchCity && browseAnchor) {
    const pass = await sqlBool(
      client,
      `SELECT ST_DWithin(
              c.location::geography,
              ST_SetSRID(ST_MakePoint($3::double precision, $2::double precision), 4326)::geography,
              $4::double precision
            ) AS pass
       FROM users c
       WHERE c.id = $1::uuid`,
      [candidate.id, browseAnchor.lat, browseAnchor.lng, meters]
    );
    return {
      mode: "RECIPROCAL_ST_DWITHIN_CANDIDATE_TO_BROWSE_ANCHOR",
      pass,
      candidateReciprocalRadiusKm: reciprocalKm,
      meters,
      browseAnchor: { lat: browseAnchor.lat, lng: browseAnchor.lng },
    };
  }

  if (!viewerUsingSwitchCity) {
    const pass = await sqlBool(
      client,
      `SELECT ST_DWithin(
              c.location::geography,
              vu.location::geography,
              $3::double precision
            ) AS pass
       FROM users vu
       JOIN users c ON c.id = $2::uuid
       WHERE vu.id = $1::uuid`,
      [viewer.id, candidate.id, meters]
    );
    return {
      mode: "RECIPROCAL_ST_DWITHIN_CANDIDATE_TO_VIEWER_GPS",
      pass,
      candidateReciprocalRadiusKm: reciprocalKm,
    };
  }

  const viewerFilterCity = String(viewer.preferred_location_city || "").trim();
  const candidateFilterCity = String(candidate.preferred_location_city || "").trim();

  const norm = (s) => String(s || "").trim().toLowerCase();
  const first = (s) => norm(s).split(",")[0].trim();
  const cityPass =
    viewerFilterCity &&
    candidateFilterCity &&
    (norm(viewerFilterCity) === norm(candidateFilterCity) ||
      first(viewerFilterCity) === first(candidateFilterCity));

  return {
    mode: "RECIPROCAL_SWITCH_NO_ANCHOR_FILTER_TO_FILTER_STRING",
    pass: cityPass,
    details: {
      viewerFilterPreferredCity: viewerFilterCity,
      candidateFilterPreferredCity: candidateFilterCity,
    },
  };
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

  const gpsKm = await computeDistanceKmGps(client, viewer.id, candidate.id);
  out.distanceKmGpsViewerToCandidate = gpsKm == null ? null : Number(gpsKm.toFixed(2));

  const viewerPremiumEffective = resolveEffectivePremium(viewer);
  const prefRaw = String(viewer.preferred_location_city || "").trim();
  const viewerUsingSwitchCity = Boolean(prefRaw);
  const browseAnchor = prefRaw ? resolveIndiaBrowseAnchor(prefRaw) : null;

  const viewerBrowsingKm = resolveViewerBrowsingDistanceKm(viewer);

  const vPref = prefRaw;
  const cCity = String(candidate.living_in_city || "").trim();
  const cityMatch =
    vPref &&
    cCity &&
    (normalizeCity(vPref) === normalizeCity(cCity) || firstCityPart(vPref) === firstCityPart(cCity));

  const anchorKm =
    browseAnchor && candidate.has_location
      ? await computeDistanceKmCandidateToAnchor(client, candidate.id, browseAnchor)
      : null;

  out.checks.browse_anchor = {
    viewerPreferredLocationCity: prefRaw || null,
    resolved: browseAnchor != null,
    coordinates: browseAnchor ? { lat: browseAnchor.lat, lng: browseAnchor.lng } : null,
    distanceKmCandidateToAnchor: anchorKm,
    feedUsesAnchorForDistanceDisplay:
      viewerUsingSwitchCity && browseAnchor != null && candidate.has_location === true,
  };

  out.checks.viewer_context = {
    premiumEffective: viewerPremiumEffective,
    usingSwitchCity: viewerUsingSwitchCity,
    preferredLocationCity: prefRaw || null,
    livingInCity: String(viewer.living_in_city || "").trim(),
    hasCoords: viewer.has_location === true,
    locationGranted: viewer.location_granted === true,
    distancePrefKm: Number(viewer.distance_pref_km || 0),
    expandDistance: viewer.expand_distance === true,
    resolvedBrowsingDistanceKm: viewerBrowsingKm,
  };

  out.checks.candidate_context = {
    livingInCityMode: String(candidate.living_in_city_mode || "FOLLOW_DEVICE").trim(),
    livingInCity: cCity,
    preferredLocationCity: String(candidate.preferred_location_city || "").trim(),
    hasCoords: candidate.has_location === true,
    distancePrefKm: Number(candidate.distance_pref_km || 0),
    expandDistance: candidate.expand_distance === true,
    resolvedReciprocalRadiusKm: resolveCandidateReciprocalRadiusKm(candidate),
  };

  const primary = await viewerToCandidatePrimaryGate(
    client,
    viewer,
    candidate,
    viewerBrowsingKm,
    browseAnchor,
    cityMatch
  );
  out.checks.viewer_to_candidate_location_gate = {
    cityMatch,
    ...primary,
  };

  const reciprocal = await candidateReciprocalGate(
    client,
    viewer,
    candidate,
    browseAnchor,
    viewerUsingSwitchCity
  );
  out.checks.candidate_reciprocal_location_gate = reciprocal;

  const locationLikelyOk =
    primary.pass === true &&
    reciprocal.pass === true &&
    viewer.account_state === "ACTIVE" &&
    candidate.account_state === "ACTIVE";

  out.checks.location_gates_summary = {
    primaryPass: primary.pass,
    reciprocalPass: reciprocal.pass,
    note:
      viewerUsingSwitchCity && browseAnchor && gpsKm != null && gpsKm > viewerBrowsingKm
        ? "Large GPS separation is OK when browsing by resolved anchor (distance shown vs anchor, reciprocal vs anchor)."
        : null,
  };

  out.checks.top_level = {
    bothActive: viewer.account_state === "ACTIVE" && candidate.account_state === "ACTIVE",
    bothHaveCoords: viewer.has_location === true && candidate.has_location === true,
    locationFiltersOkForFeedSql: locationLikelyOk,
  };

  return out;
}

const INTEGRATION_SEED = "diagnose-feed-pair-integration";

async function integrationFindCandidateInFeed(viewerId, candidateId) {
  let page = 1;
  const pageSize = 25;
  let lastFeed = null;

  while (page <= 120) {
    lastFeed = await getFeed(viewerId, { page, pageSize, shuffleSeed: INTEGRATION_SEED });
    if (lastFeed.code) {
      return {
        ran: true,
        ok: false,
        feedError: lastFeed,
        page,
      };
    }

    const suggestedIds = (lastFeed.sections || [])
      .filter((s) => s.kind === "suggested")
      .flatMap((s) => (s.profiles || []).map((p) => p.userId));

    for (const card of lastFeed.cards || []) {
      if (card.userId === candidateId) {
        return {
          ran: true,
          ok: true,
          where: "cards",
          page,
          totalCandidatePool: lastFeed.totalCandidatePool,
          totalRegularPool: lastFeed.totalRegularPool,
        };
      }
    }
    for (const uid of suggestedIds) {
      if (uid === candidateId) {
        return {
          ran: true,
          ok: true,
          where: "suggested",
          page,
          totalCandidatePool: lastFeed.totalCandidatePool,
          totalRegularPool: lastFeed.totalRegularPool,
        };
      }
    }

    if (!lastFeed.hasMore) break;
    page += 1;
  }

  return {
    ran: true,
    ok: false,
    candidateNotInPagedFeedOutput:
      lastFeed != null
        ? {
            totalCandidatePool: lastFeed.totalCandidatePool,
            totalRegularPool: lastFeed.totalRegularPool,
            scannedPages: page,
          }
        : null,
    hint:
      "If primary+reciprocal pass but candidate missing, check gender/age/advanced filters, blocks, interactions, or pool ranking beyond scanned pages.",
  };
}

async function main() {
  const argv = process.argv.slice(2).filter((a) => a !== "--integration");
  const runIntegration = process.argv.includes("--integration");

  const phoneA = argv[0];
  const phoneB = argv[1];
  if (!phoneA || !phoneB) {
    console.error(
      "Usage: node src/scripts/diagnoseFeedPairByPhone.js <viewerPhone> <candidatePhone> [--integration]"
    );
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

    let integrationASeesB = null;
    if (runIntegration) {
      integrationASeesB = await integrationFindCandidateInFeed(a.id, b.id);
    }

    console.log(
      JSON.stringify(
        {
          summary: {
            viewerA: {
              phone: a.phone_e164,
              name: a.name,
              living_in_city_mode: a.living_in_city_mode,
              preferred_location_city: a.preferred_location_city,
            },
            candidateB: {
              phone: b.phone_e164,
              name: b.name,
              living_in_city_mode: b.living_in_city_mode,
              preferred_location_city: b.preferred_location_city,
            },
          },
          scenarioUSAViewerDelhiSwitchCity: {
            description:
              "Viewer A GPS abroad + preferred_location_city New Delhi; Candidate B GPS in Delhi ~50km reciprocal — reciprocal ST_DWithin uses browse_anchor_geog, not transoceanic GPS.",
            aSeesB_primaryMode: aToB.checks.viewer_to_candidate_location_gate.mode,
            aSeesB_reciprocalMode: aToB.checks.candidate_reciprocal_location_gate.mode,
            expectReciprocalPassWhenAnchorResolved:
              aToB.checks.candidate_reciprocal_location_gate.mode ===
              "RECIPROCAL_ST_DWITHIN_CANDIDATE_TO_BROWSE_ANCHOR",
          },
          aSeesB: {
            viewerToCandidate: aToB.checks.viewer_to_candidate_location_gate,
            reciprocal: aToB.checks.candidate_reciprocal_location_gate,
            browse_anchor: aToB.checks.browse_anchor,
            top_level: aToB.checks.top_level,
          },
          bSeesA: {
            viewerToCandidate: bToA.checks.viewer_to_candidate_location_gate,
            reciprocal: bToA.checks.candidate_reciprocal_location_gate,
            browse_anchor: bToA.checks.browse_anchor,
            top_level: bToA.checks.top_level,
          },
          integration_a_sees_b: integrationASeesB,
          raw: { aToB, bToA },
        },
        null,
        2
      )
    );

    const mismatch =
      runIntegration &&
      integrationASeesB &&
      integrationASeesB.ok === false &&
      aToB.checks.top_level.locationFiltersOkForFeedSql === true;

    if (mismatch) {
      console.error(
        JSON.stringify(
          {
            warning:
              "Location gates suggest visibility but candidate not found in paginated feed output — inspect full feed gates (gender, age, interactions, blocks).",
          },
          null,
          2
        )
      );
      process.exitCode = 3;
    }
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
