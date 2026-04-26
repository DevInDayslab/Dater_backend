/**
 * Seeds feed-compatible profiles for a specific viewer phone (default: 9354120990).
 *
 * - Ensures viewer has user_filter_preferred_genders for Woman, Man, Nonbinary (adds missing only).
 * - Inserts N ACTIVE users near the viewer (default 200; max 500; or same living_in_city if viewer has no GPS).
 * - Each candidate prefers the viewer's gender_main (user_dating_preferences) — required by feed SQL.
 * - Candidate ages sit inside the viewer's effective age window (respects expand_age_range).
 * - Wide inverse filters + distance on candidates so they stay eligible as the viewer changes prefs slightly.
 *
 * From backend/:
 *   npm run inspect:feed:viewer -- 9354120990   # see totalCandidatePool before seeding
 *   npm run seed:feed:viewer -- 9354120990
 *   npm run seed:feed:viewer -- 9354120990 200
 *   npm run seed:feed:viewer -- 9354120990 200 append   # 200 MORE (no delete; continues phone suffixes after existing seed users)
 *
 * Requires DATABASE_URL in .env
 */
require("dotenv").config();
const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const { Client } = require("pg");
const { randomUUID } = require("crypto");
const s3Media = require("../services/s3Media.service");

const SEED_PHONE_PREFIX = "988770"; // +91988770xxxxx — unlikely to collide with real users

const LOOKING_FOR = ["Marriage", "Hangout, casual meet-up", "An everlasting bond", "Unattached intimacy"];
const INTERESTS = [
  "Travel", "Fitness", "Music", "Movies", "Food", "Pets", "Reading", "Art", "Cricket", "Photography",
  "Writing", "Hiking", "Coffee", "Cooking", "Tech", "Dancing",
];
const LANGUAGES = ["Hindi", "English", "Punjabi", "Bengali", "Marathi", "Tamil", "Telugu", "Urdu"];
const DRINKING = ["Never", "Sometimes", "Socially"];
const SMOKING = ["Never", "Occasionally"];
const EXERCISE = ["Gym", "Yoga", "Running", "Active lifestyle"];
const RELIGIONS = ["Hindu", "Sikh", "Spiritual"];
const EDUCATION = ["Undergraduate degree", "Postgraduate degree"];
const STAR_SIGNS = ["Aries", "Gemini", "Leo", "Libra", "Sagittarius"];
const KIDS = ["Want someday", "Open to kids", "Don't want more"];
const POLITICS = ["Moderate", "Apolitical"];
const PETS = ["Dog lover", "Cat lover", "Pet friendly"];
const ETHNICITIES = ["Indian", "Punjabi", "Bengali"];
const COMPANIES = ["Zomato", "Google", "Accenture", "CRED", "Urban Company", "Paytm"];
const JOBS = ["Product Designer", "Software Engineer", "Marketing Lead", "Founder", "Consultant"];
const COLLEGES = ["Delhi University", "IIT Delhi", "Amity University", "JNU", "IP University"];
const HOMETOWNS = ["Delhi, DL", "Chandigarh, CH", "Jaipur, RJ", "Lucknow, UP", "Indore, MP"];
const NAMES = [
  "Asha Verma", "Dev Malik", "Rio Kapoor", "Samaira Joshi", "Jordan Khanna", "Neel Iyer",
  "Kai Menon", "Priya Das", "Adi Bose", "Noor Sheikh", "Ishan Talwar", "Meera Nambiar",
  "Rohan Gill", "Tia Sen", "Omar Bedi", "Zara Qureshi", "Vihaan Dutta", "Anaya Pillai",
  "Rehan Ahuja", "Mira Kulkarni", "Arin Malhotra", "Sia Reddy", "Yash Thakur", "Nia Arora",
  "Kabir Seth", "Ira Menon", "Ved Chawla", "Myra Banerjee", "Neil Dutta", "Rhea Saxena",
];

const PROMPT_PAIRS = [
  {
    q1: "My simple pleasures",
    a1: (first, cityShort) => `${first}: slow mornings and ${cityShort} sunsets.`,
    q2: "I'm convinced that",
    a2: () => "Good dates feel easy, not performative.",
  },
  {
    q1: "Typical Sunday",
    a1: (first) => `${first}: coffee, a walk, and a comfort show.`,
    q2: "Together, we could",
    a2: (_first, cityShort) => `Try new spots around ${cityShort} without a rigid plan.`,
  },
];

const PRONOUN_BY_MAIN = {
  Woman: ["She/Her"],
  Man: ["He/Him"],
  Nonbinary: ["They/Them"],
};

function toE164(raw) {
  const s = String(raw).trim().replace(/\s/g, "");
  if (s.startsWith("+")) return s;
  const digits = s.replace(/\D/g, "");
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  if (digits.length > 0) return `+${digits}`;
  return s;
}

function pick(list, i) {
  return list[i % list.length];
}

function clip(str, maxLen) {
  const s = String(str || "").trim();
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen - 1)}…`;
}

function pickUnique(list, seed, count) {
  const out = [];
  let offset = 0;
  while (out.length < count && offset < list.length * 5) {
    const item = pick(list, seed + offset);
    offset += 1;
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

const mockPeopleImagesDir = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "DaterApp",
  "app",
  "src",
  "main",
  "res",
  "drawable",
  "mock-people-images"
);
const mockPeopleImageFiles = (() => {
  try {
    const files = fs
      .readdirSync(mockPeopleImagesDir)
      .filter((f) => /\.(jpg|jpeg|png|webp)$/i.test(f))
      .sort();
    return files;
  } catch (_e) {
    return [];
  }
})();
if (mockPeopleImageFiles.length === 0) {
  throw new Error(
    `No seed images found in ${mockPeopleImagesDir}. ` +
      "Seeding is restricted to mock-people-images assets only."
  );
}

function pickSeedPhotoFiles(index) {
  if (mockPeopleImageFiles.length > 0) {
    return [
      mockPeopleImageFiles[index % mockPeopleImageFiles.length],
      mockPeopleImageFiles[(index + 9) % mockPeopleImageFiles.length],
    ];
  }
  return [];
}

function contentTypeForFilename(name) {
  const lower = String(name || "").toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}

async function uploadSeedPhotoToS3({ userId, filename }) {
  const src = path.join(mockPeopleImagesDir, filename);
  const body = fs.readFileSync(src);
  const contentType = contentTypeForFilename(filename);
  const ext = path.extname(filename).toLowerCase() || ".jpg";
  const key = s3Media
    .buildUserPhotoObjectKey(userId, s3Media.newPhotoId())
    .replace(/\.webp$/, ext);
  await s3Media.putObjectBytes({ key, body, contentType });
  return {
    photoUrl: s3Media.buildPublicObjectUrl(key),
    s3Key: key,
  };
}

function buildPhotoUrls(genderMain, index) {
  const folder = genderMain === "Man" ? "men" : "women";
  const primary = (index % 60) + 1;
  const secondary = ((index + 19) % 60) + 1;
  return [
    `https://randomuser.me/api/portraits/${folder}/${primary}.jpg`,
    `https://randomuser.me/api/portraits/${folder}/${secondary}.jpg`,
  ];
}

function effectiveAgeRange(viewer) {
  let ageMin = Number(viewer.age_min);
  let ageMax = Number(viewer.age_max);
  if (!Number.isFinite(ageMin)) ageMin = 20;
  if (!Number.isFinite(ageMax)) ageMax = 36;
  if (viewer.expand_age_range === true) {
    ageMin = Math.max(18, Math.round(ageMin - 5));
    ageMax = Math.min(80, Math.round(ageMax + 5));
  }
  if (ageMax < ageMin) {
    const t = ageMin;
    ageMin = ageMax;
    ageMax = t;
  }
  return { ageMin, ageMax };
}

function effectiveDistanceKm(viewer) {
  let d = Number(viewer.distance_pref_km);
  if (!Number.isFinite(d) || d < 2) d = 20;
  if (d > 150) d = 150;
  if (viewer.expand_distance === true) {
    d = Math.min(150, Math.round(d * 1.75));
  }
  return d;
}

function candidateAgeForIndex(viewerAge, ageMin, ageMax, index) {
  const spread = Math.max(0, ageMax - ageMin);
  if (spread === 0) return ageMin;
  const off = index % (spread + 1);
  let a = ageMin + off;
  const v = Number(viewerAge);
  if (Number.isFinite(v) && v >= ageMin && v <= ageMax && index % 4 === 0) {
    a = v;
  }
  return Math.max(ageMin, Math.min(ageMax, a));
}

async function ensureUserFiltersRow(client, userId) {
  await client.query(`INSERT INTO user_filters (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [userId]);
}

async function syncViewerInclusivePreferredGenders(client, viewerId) {
  for (const g of ["Woman", "Man", "Nonbinary"]) {
    await client.query(
      `INSERT INTO user_filter_preferred_genders (user_id, gender) VALUES ($1, $2)
       ON CONFLICT (user_id, gender) DO NOTHING`,
      [viewerId, g]
    );
  }
}

/**
 * @param {object} [options]
 * @param {string} [options.phonePrefix] — default SEED_PHONE_PREFIX; use a distinct prefix for other seed scripts.
 */
async function upsertCompatibleCandidate(client, viewer, index, options = {}) {
  const viewerGenderMain = String(viewer.gender_main || "").trim();
  if (!viewerGenderMain) {
    throw new Error("Viewer gender_main is empty; complete onboarding gender first.");
  }

  const { ageMin, ageMax } = effectiveAgeRange(viewer);
  const distKm = effectiveDistanceKm(viewer);
  const viewerAge = Number(viewer.age_years);
  const ageYears = candidateAgeForIndex(viewerAge, ageMin, ageMax, index);

  const genderCycle = ["Woman", "Man", "Nonbinary"];
  const genderMain = genderCycle[index % 3];
  const showGenderOnProfile = index % 8 !== 0;
  const onlyVerifiedFeed = viewer.only_verified_profiles === true;
  const isVerified = onlyVerifiedFeed ? true : index % 5 !== 0;
  const isPremium = index % 7 === 0;
  const profileCompletion = 58 + (index % 38);

  const phonePrefix = options.phonePrefix ?? SEED_PHONE_PREFIX;
  const phone = `+91${phonePrefix}${String(index).padStart(5, "0")}`;
  const phoneDigits = phone.slice(3);
  const name = pick(NAMES, index);
  const firstName = name.split(" ")[0];

  const livingCity =
    String(viewer.living_in_city || "")
      .trim()
      .replace(/\s+/g, " ") || "Delhi, DL";

  let lng = 77.209;
  let lat = 28.6139;
  let hasCoords = false;
  if (viewer.has_location && viewer.lng != null && viewer.lat != null) {
    hasCoords = true;
    lng = Number(viewer.lng) + ((index % 11) - 5) * 0.006;
    lat = Number(viewer.lat) + ((index % 9) - 4) * 0.006;
  }

  const preferredCityForSwitch =
    String(viewer.preferred_location_city || "").trim() || livingCity;

  const cityForCandidateLiving =
    String(viewer.living_in_city_mode) === "MANUAL_SWITCH" && String(viewer.preferred_location_city || "").trim()
      ? preferredCityForSwitch
      : livingCity;

  const bio = clip(
    `${firstName} (${genderMain}, ${ageYears}) — feed QA profile near you. ` +
      `Into ${pick(INTERESTS, index).toLowerCase()} and ${pick(INTERESTS, index + 4).toLowerCase()}. ` +
      `${pick(DRINKING, index)} on drinks; ${pick(EXERCISE, index + 1)}.`,
    900
  );
  const presetMessage = clip(`Let's grab coffee in ${cityForCandidateLiving.split(",")[0].trim()} and see if we click.`, 240);

  const userRes = await client.query(
    `INSERT INTO users (
       id, phone_country_code, phone_number, phone_e164, is_phone_verified, name,
       age_years, date_of_birth, gender, gender_main, marital_status,
       show_gender_on_profile, is_verified, is_premium, account_state,
       location, location_granted, onboarding_step, onboarding_completed_at,
       profile_completion_percentage, living_in_city, living_in_city_mode,
       created_at, updated_at, last_active_at, new_here_until
     ) VALUES (
       $1, '+91', $2, $3, TRUE, $4,
       $5, CURRENT_DATE - ($6 * INTERVAL '1 year'), $7, $8, $9,
       $10, $11, $12, 'ACTIVE',
       CASE WHEN $18 THEN ST_SetSRID(ST_MakePoint($19::double precision, $20::double precision), 4326) ELSE NULL END,
       CASE WHEN $18 THEN TRUE ELSE FALSE END, 'main', NOW(),
       $13, $14, 'FOLLOW_DEVICE',
       NOW() - ($15 * INTERVAL '1 hour'), NOW(), NOW() - ($16 * INTERVAL '1 minute'),
       CASE WHEN $17 THEN NOW() + INTERVAL '3 days' ELSE NULL END
     )
     ON CONFLICT (phone_e164) DO UPDATE SET
       name = EXCLUDED.name,
       age_years = EXCLUDED.age_years,
       gender = EXCLUDED.gender,
       gender_main = EXCLUDED.gender_main,
       marital_status = EXCLUDED.marital_status,
       show_gender_on_profile = EXCLUDED.show_gender_on_profile,
       is_verified = EXCLUDED.is_verified,
       is_premium = EXCLUDED.is_premium,
       account_state = 'ACTIVE',
       location = EXCLUDED.location,
       location_granted = EXCLUDED.location_granted,
       profile_completion_percentage = EXCLUDED.profile_completion_percentage,
       living_in_city = EXCLUDED.living_in_city,
       living_in_city_mode = EXCLUDED.living_in_city_mode,
       last_active_at = EXCLUDED.last_active_at,
       new_here_until = EXCLUDED.new_here_until,
       updated_at = NOW()
     RETURNING id`,
    [
      randomUUID(),
      phoneDigits,
      phone,
      name,
      ageYears,
      ageYears,
      genderMain,
      genderMain,
      index % 3 === 0 ? "Single" : "Separated",
      showGenderOnProfile,
      isVerified,
      isPremium,
      profileCompletion,
      cityForCandidateLiving,
      index % 20,
      index % 120,
      index % 5 === 0,
      hasCoords,
      lng,
      lat,
    ]
  );

  const userId = userRes.rows[0].id;
  let photoOne = "";
  let photoTwo = "";
  let photoOneS3Key = null;
  let photoTwoS3Key = null;
  const pickedSeedFiles = pickSeedPhotoFiles(index);
  if (pickedSeedFiles.length < 2) {
    throw new Error(
      "Insufficient mock seed images to assign two photos per profile. " +
        "Please add more files to mock-people-images."
    );
  }
  const first = await uploadSeedPhotoToS3({ userId, filename: pickedSeedFiles[0] });
  const second = await uploadSeedPhotoToS3({ userId, filename: pickedSeedFiles[1] });
  photoOne = first.photoUrl;
  photoTwo = second.photoUrl;
  photoOneS3Key = first.s3Key;
  photoTwoS3Key = second.s3Key;

  await client.query(
    `UPDATE users
     SET bio = $2,
         preset_message = $3,
         height_inches = $4,
         drinking = $5,
         smoking = $6,
         exercise = $7,
         religion = $8,
         education = $9,
         star_sign = $10,
         kids = $11,
         political_leanings = $12,
         pets = $13,
         ethnicity = $14,
         occupation_job_title = $15,
         occupation_company = $16,
         education_institution_name = $17,
         education_passing_year = $18,
         home_town_city = $19,
         updated_at = NOW()
     WHERE id = $1`,
    [
      userId,
      bio,
      presetMessage,
      62 + (index % 12),
      pick(DRINKING, index),
      pick(SMOKING, index),
      pick(EXERCISE, index),
      pick(RELIGIONS, index),
      pick(EDUCATION, index),
      pick(STAR_SIGNS, index),
      pick(KIDS, index),
      pick(POLITICS, index),
      pick(PETS, index),
      pick(ETHNICITIES, index),
      pick(JOBS, index),
      pick(COMPANIES, index),
      pick(COLLEGES, index),
      2012 + (index % 10),
      pick(HOMETOWNS, index),
    ]
  );

  await ensureUserFiltersRow(client, userId);

  await client.query(
    `UPDATE user_filters
     SET distance_pref_km = $2,
         age_min = 18,
         age_max = 80,
         expand_age_range = TRUE,
         expand_distance = TRUE,
         only_verified_profiles = FALSE,
         preferred_location_city = $3,
         min_height_inches = 58,
         max_height_inches = 78,
         show_other_people_if_run_out = TRUE,
         updated_at = NOW()
     WHERE user_id = $1`,
    [userId, Math.max(distKm, 50), preferredCityForSwitch]
  );

  await client.query(`DELETE FROM user_dating_preferences WHERE user_id = $1`, [userId]);
  await client.query(`INSERT INTO user_dating_preferences (user_id, preferred_gender) VALUES ($1, $2)`, [
    userId,
    viewerGenderMain,
  ]);

  await client.query(`DELETE FROM user_filter_preferred_genders WHERE user_id = $1`, [userId]);
  await client.query(`INSERT INTO user_filter_preferred_genders (user_id, gender) VALUES ($1, $2)`, [userId, viewerGenderMain]);

  await client.query(`DELETE FROM user_looking_for WHERE user_id = $1`, [userId]);
  await client.query(`DELETE FROM user_filter_looking_for WHERE user_id = $1`, [userId]);
  const lf1 = pick(LOOKING_FOR, index);
  let lf2 = pick(LOOKING_FOR, index + 1);
  if (lf2 === lf1) lf2 = pick(LOOKING_FOR, index + 2);
  for (const lf of [lf1, lf2]) {
    await client.query(`INSERT INTO user_looking_for (user_id, looking_for_option) VALUES ($1, $2)`, [userId, lf]);
    await client.query(`INSERT INTO user_filter_looking_for (user_id, looking_for_option) VALUES ($1, $2)`, [userId, lf]);
  }

  const interestRows = pickUnique(INTERESTS, index * 3, 6);
  const languageRows = pickUnique(LANGUAGES, index * 2 + 1, 5);

  await client.query(`DELETE FROM user_interests WHERE user_id = $1`, [userId]);
  for (const interest of interestRows) {
    await client.query(
      `INSERT INTO user_interests (user_id, interest) VALUES ($1, $2) ON CONFLICT (user_id, interest) DO NOTHING`,
      [userId, interest]
    );
  }

  await client.query(`DELETE FROM user_languages WHERE user_id = $1`, [userId]);
  for (const language of languageRows) {
    await client.query(
      `INSERT INTO user_languages (user_id, language) VALUES ($1, $2) ON CONFLICT (user_id, language) DO NOTHING`,
      [userId, language]
    );
  }

  await client.query(`DELETE FROM user_filter_languages WHERE user_id = $1`, [userId]);
  const filterLangSubset = pickUnique(languageRows, index + 2, Math.min(3, languageRows.length));
  for (const language of filterLangSubset) {
    await client.query(
      `INSERT INTO user_filter_languages (user_id, language) VALUES ($1, $2) ON CONFLICT (user_id, language) DO NOTHING`,
      [userId, language]
    );
  }

  const pronouns = [...(PRONOUN_BY_MAIN[genderMain] || ["They/Them"])];
  if (index % 6 === 0) pronouns.push("They/Them");
  await client.query(`DELETE FROM user_pronouns WHERE user_id = $1`, [userId]);
  for (const p of pronouns) {
    await client.query(
      `INSERT INTO user_pronouns (user_id, pronoun) VALUES ($1, $2) ON CONFLICT (user_id, pronoun) DO NOTHING`,
      [userId, p]
    );
  }

  await client.query(`DELETE FROM user_written_prompts WHERE user_id = $1`, [userId]);
  const pair = pick(PROMPT_PAIRS, index);
  const cityShort = cityForCandidateLiving.split(",")[0].trim();
  const a1 = clip(pair.a1(firstName, cityShort), 180);
  const a2 = clip(pair.a2(firstName, cityShort), 180);
  await client.query(
    `INSERT INTO user_written_prompts (user_id, prompt_order, prompt_question, prompt_answer)
     VALUES ($1, 1, $2, $3), ($1, 2, $4, $5)`,
    [userId, pair.q1, a1, pair.q2, a2]
  );

  await client.query(`DELETE FROM user_photos WHERE user_id = $1`, [userId]);
  await client.query(
    `INSERT INTO user_photos (user_id, photo_url, photo_order, is_primary, moderation_status, s3_key)
     VALUES ($1, $2, 1, TRUE, 'APPROVED', $4), ($1, $3, 2, FALSE, 'APPROVED', $5)`,
    [userId, photoOne, photoTwo, photoOneS3Key, photoTwoS3Key]
  );

  // QA: hide-my-name across feed / friends / notifications (first-letter display for some seed users).
  // Include 100+N indices used by story-repair friend-request seed so Requests tab can show masked names.
  if (
    index % 17 === 0 ||
    index % 23 === 7 ||
    index === 4 ||
    index === 105 ||
    index === 109
  ) {
    await client.query(`UPDATE users SET hide_my_name = TRUE WHERE id = $1::uuid`, [userId]);
  }

  await client.query(`DELETE FROM premium_boosts WHERE user_id = $1`, [userId]);
  if (index % 9 === 0) {
    await client.query(
      `INSERT INTO premium_boosts (user_id, started_at, expires_at)
       VALUES ($1, NOW() - INTERVAL '5 minutes', NOW() + INTERVAL '25 minutes')`,
      [userId]
    );
  }

  return {
    userId,
    phone_e164: phone,
    name,
    genderMain,
    showGenderOnProfile,
    ageYears,
    isVerified,
    isPremium,
    livingInCity: cityForCandidateLiving,
    hasLocation: hasCoords,
    interests: interestRows,
    languages: languageRows,
    prefersViewerGender: viewerGenderMain,
  };
}

async function deleteOldSeedBatch(client) {
  await client.query(
    `DELETE FROM users WHERE phone_e164 LIKE $1`,
    [`+91${SEED_PHONE_PREFIX}%`]
  );
}

/**
 * Next free numeric suffix for phones `+91{phonePrefix}` + 5-digit zero-padded index (see upsertCompatibleCandidate).
 * Uses one aggregate query so we never pull all matching rows into Node (that could look "stuck" on large DBs).
 */
async function nextSeedIndexAfterPrefix(client, phonePrefix) {
  const pattern = `^\\+91${phonePrefix}[0-9]{5}$`;
  const { rows } = await client.query(
    `SELECT COALESCE(MAX(CAST(RIGHT(phone_e164, 5) AS INTEGER)), 0) AS max_suffix
     FROM users
     WHERE phone_e164 ~ $1`,
    [pattern]
  );
  const max = Number(rows[0]?.max_suffix ?? 0);
  return Number.isFinite(max) ? max + 1 : 1;
}

function parseMainArgs(argv) {
  const rest = argv.slice(2).filter(Boolean);
  const append = rest.some((a) => String(a).toLowerCase() === "append" || String(a).toLowerCase() === "--append");
  const filtered = rest.filter((a) => {
    const s = String(a).toLowerCase();
    return s !== "append" && s !== "--append";
  });
  const rawPhone = filtered[0] || "9354120990";
  const rawCount =
    filtered.length > 1 && /^\d+$/.test(String(filtered[1]).trim()) ? String(filtered[1]).trim() : null;
  return { rawPhone, rawCount, append };
}

async function mainFeedSeed() {
  const { rawPhone, rawCount, append } = parseMainArgs(process.argv);
  const phoneE164 = toE164(rawPhone);
  const parsed = rawCount != null ? Number.parseInt(String(rawCount), 10) : 200;
  const candidateCount = Number.isFinite(parsed) ? Math.min(500, Math.max(1, parsed)) : 200;

  if (!process.env.DATABASE_URL || String(process.env.DATABASE_URL).trim() === "") {
    console.error("seedFeedProfilesForViewerPhone: DATABASE_URL is missing or empty (.env in repo root or backend/).");
    process.exitCode = 1;
    return;
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15_000,
    keepAlive: true,
  });

  console.error(
    `[seed:feed:viewer] connecting (15s timeout)… viewer=${phoneE164} count=${candidateCount} append=${append}`
  );
  try {
    await client.connect();
  } catch (e) {
    console.error(
      "[seed:feed:viewer] could not connect to Postgres:",
      e.message || e,
      "| Check DATABASE_URL, VPN, and that the DB allows your IP."
    );
    process.exitCode = 1;
    try {
      await client.end();
    } catch (_) {
      /* ignore */
    }
    return;
  }
  console.error("[seed:feed:viewer] connected.");

  try {
    await client.query("SET statement_timeout = '120000'");
    await client.query("BEGIN");

    const vRes = await client.query(
      `SELECT u.id,
              u.name,
              u.age_years,
              u.gender_main,
              u.living_in_city,
              u.living_in_city_mode,
              u.is_verified,
              (u.location IS NOT NULL) AS has_location,
              ST_X(u.location::geometry) AS lng,
              ST_Y(u.location::geometry) AS lat,
              uf.distance_pref_km,
              uf.age_min,
              uf.age_max,
              uf.expand_age_range,
              uf.expand_distance,
              uf.only_verified_profiles,
              uf.preferred_location_city
       FROM users u
       LEFT JOIN user_filters uf ON uf.user_id = u.id
       WHERE u.phone_e164 = $1
         AND u.deleted_at IS NULL
       LIMIT 1`,
      [phoneE164]
    );

    if (vRes.rows.length === 0) {
      throw new Error(`No user found for phone_e164=${phoneE164}`);
    }

    const viewer = vRes.rows[0];
    viewer.expand_age_range = viewer.expand_age_range === true;
    viewer.expand_distance = viewer.expand_distance === true;
    viewer.only_verified_profiles = viewer.only_verified_profiles === true;

    await ensureUserFiltersRow(client, viewer.id);
    await syncViewerInclusivePreferredGenders(client, viewer.id);

    const ufRes = await client.query(
      `SELECT distance_pref_km, age_min, age_max, expand_age_range, expand_distance,
              only_verified_profiles, preferred_location_city
       FROM user_filters WHERE user_id = $1 LIMIT 1`,
      [viewer.id]
    );
    if (ufRes.rows[0]) {
      Object.assign(viewer, ufRes.rows[0]);
      viewer.expand_age_range = viewer.expand_age_range === true;
      viewer.expand_distance = viewer.expand_distance === true;
      viewer.only_verified_profiles = viewer.only_verified_profiles === true;
    }

    const { ageMin, ageMax } = effectiveAgeRange(viewer);
    const distKm = effectiveDistanceKm(viewer);

    let startIndex = 1;
    if (append) {
      console.error("[seed:feed:viewer] append: resolving next seed index…");
      startIndex = await nextSeedIndexAfterPrefix(client, SEED_PHONE_PREFIX);
      console.error(`[seed:feed:viewer] append: startIndex=${startIndex}`);
    } else {
      console.error("[seed:feed:viewer] replacing seed batch: deleting old +91" + SEED_PHONE_PREFIX + "… users…");
      await deleteOldSeedBatch(client);
      console.error("[seed:feed:viewer] delete done.");
    }

    const endIndex = startIndex + candidateCount - 1;
    if (endIndex > 99999) {
      throw new Error(`Seed index range ${startIndex}..${endIndex} exceeds 99999; lower count or clear old seeds.`);
    }

    const created = [];
    console.error(`[seed:feed:viewer] upserting candidates ${startIndex}…${endIndex}…`);
    for (let i = startIndex; i <= endIndex; i += 1) {
      if ((i - startIndex) % 50 === 0) {
        console.error(`[seed:feed:viewer] … ${i}/${endIndex}`);
      }
      created.push(await upsertCompatibleCandidate(client, viewer, i));
    }

    await client.query("COMMIT");
    console.error("[seed:feed:viewer] commit ok.");

    console.log(
      JSON.stringify(
        {
          success: true,
          viewerPhone: phoneE164,
          viewerId: viewer.id,
          viewerGenderMain: viewer.gender_main,
          viewerLivingInCity: viewer.living_in_city,
          viewerHasLocation: viewer.has_location,
          effectiveFeedWindow: { ageMin, ageMax, distanceKm: distKm },
          append,
          startIndex,
          endIndex,
          note:
            "Added Woman/Man/Nonbinary to viewer user_filter_preferred_genders (missing only). " +
            "Each seeded candidate has user_dating_preferences.preferred_gender = viewer.gender_main." +
            (append ? " Append mode: did not delete prior +91988770… seed users." : ""),
          requestedCandidates: candidateCount,
          seededCandidates: created.length,
          media: {
            source: mockPeopleImageFiles.length > 0 ? "mock-people-images->s3" : "randomuser-fallback",
            count: mockPeopleImageFiles.length,
            s3Bucket: s3Media.s3Bucket,
            s3Region: s3Media.s3Region,
          },
          profiles: created,
        },
        null,
        2
      )
    );
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {
      /* ignore if no transaction */
    }
    console.error("seedFeedProfilesForViewerPhone failed:", e.message);
    process.exitCode = 1;
  } finally {
    try {
      await client.end();
    } catch (_) {
      /* ignore */
    }
  }
}

if (require.main === module) {
  mainFeedSeed();
}

module.exports = {
  toE164,
  ensureUserFiltersRow,
  syncViewerInclusivePreferredGenders,
  upsertCompatibleCandidate,
  nextSeedIndexAfterPrefix,
};
