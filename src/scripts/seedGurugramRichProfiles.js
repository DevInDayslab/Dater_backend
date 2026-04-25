require("dotenv").config();
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const { Client } = require("pg");
const { randomUUID } = require("crypto");

const CITY = { city: "Gurugram, HR", lat: 28.4595, lng: 77.0266 };
const SEED_PHONE_PREFIX = "977440";

const WOMEN = [
  "Kiara Malhotra", "Myra Sethi", "Aarohi Khanna", "Naina Bhasin", "Rhea Anand", "Ira Kapoor",
  "Shanaya Ahuja", "Tara Mehra", "Prisha Oberoi", "Eesha Nanda", "Navya Chawla", "Mehak Arora",
  "Diya Juneja", "Anika Talwar", "Suhani Bajaj", "Riddhi Kohli", "Avni Puri", "Lavanya Sahni",
];
const MEN = [
  "Vivaan Malhotra", "Reyansh Sethi", "Abeer Khanna", "Laksh Bhasin", "Armaan Anand", "Yuvaan Kapoor",
  "Kabir Ahuja", "Veer Mehra", "Advik Oberoi", "Ivaan Nanda", "Rohan Chawla", "Neil Arora",
  "Krish Juneja", "Aryan Talwar", "Samar Bajaj", "Rishabh Kohli", "Ayaan Puri", "Dhruv Sahni",
];

const LOOKING_FOR = ["Marriage", "An everlasting bond", "Hangout, casual meet-up", "Unattached intimacy"];
const INTERESTS = [
  "Travel", "Fitness", "Music", "Movies", "Food", "Pets", "Reading", "Art", "Cricket", "Photography",
  "Writing", "Hiking", "Coffee", "Cooking", "Tech", "Dancing", "Meditation", "Stand-up comedy", "Cycling", "Wine tasting",
];
const LANGUAGES = ["Hindi", "English", "Punjabi", "Bengali", "Marathi", "Tamil", "Telugu", "Urdu", "Gujarati", "Kannada"];
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
const COMPANIES = ["Zomato", "Google", "Accenture", "CRED", "Urban Company", "Paytm", "Nagarro", "American Express"];
const JOBS = ["Product Designer", "Software Engineer", "Marketing Lead", "Founder", "Consultant", "Architect", "Data Analyst"];
const COLLEGES = ["Delhi University", "IIT Delhi", "Amity University", "JNU", "IP University", "Ashoka University"];
const HOMETOWNS = ["Gurugram, HR", "Delhi, DL", "Chandigarh, CH", "Jaipur, RJ", "Lucknow, UP", "Indore, MP"];
const PRONOUN_ROWS = {
  Woman: ["She/Her"],
  Man: ["He/Him"],
};

const PROMPT_PAIRS = [
  {
    q1: "My simple pleasures",
    a1: (first) => `${first}: slow mornings, good playlists, and Gurgaon cafe hopping.`,
    q2: "I'm convinced that",
    a2: () => "The best connections start with curiosity, not trying to impress.",
  },
  {
    q1: "The key to my heart is",
    a1: () => "Honesty, humor, and someone who texts back without playing games.",
    q2: "I'm weirdly attracted to",
    a2: () => "People who read, laugh easily, and remember small details.",
  },
  {
    q1: "Typical Sunday",
    a1: (first) => `${first}: brunch, a long walk, and rewatching comfort shows.`,
    q2: "Together, we could",
    a2: () => "Explore Gurgaon, try new cafes, and keep plans low-pressure.",
  },
];

function clip(str, maxLen) {
  const s = String(str || "").trim();
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen - 1)}…`;
}

function pick(list, index) {
  return list[index % list.length];
}

function pickUnique(list, seed, count) {
  const out = [];
  let offset = 0;
  while (out.length < count && offset < list.length * 4) {
    const item = pick(list, seed + offset);
    offset += 1;
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

function jitter(base, delta = 0.06) {
  return base + (Math.random() * 2 - 1) * delta;
}

function buildPhotoUrls(isWoman, index) {
  const folder = isWoman ? "women" : "men";
  const p1 = (index % 60) + 1;
  const p2 = ((index + 17) % 60) + 1;
  const p3 = ((index + 31) % 60) + 1;
  return [
    `https://randomuser.me/api/portraits/${folder}/${p1}.jpg`,
    `https://randomuser.me/api/portraits/${folder}/${p2}.jpg`,
    `https://randomuser.me/api/portraits/${folder}/${p3}.jpg`,
  ];
}

async function deleteOldBatch(client) {
  await client.query(`DELETE FROM users WHERE phone_e164 LIKE $1`, [`+91${SEED_PHONE_PREFIX}%`]);
}

async function upsertUser(client, seedIndex) {
  const isWoman = seedIndex % 2 === 0;
  const genderIndex = Math.floor((seedIndex - 1) / 2);
  const baseName = pick(isWoman ? WOMEN : MEN, genderIndex);
  const phone = `+91${SEED_PHONE_PREFIX}${String(seedIndex).padStart(5, "0")}`;
  const accountStates = ["ACTIVE", "ACTIVE", "ACTIVE", "ACTIVE", "PAUSED", "PRIVACY_MODE", "HIDDEN_BY_MODERATION"];
  const accountState = pick(accountStates, seedIndex);
  const isVerified = seedIndex % 3 !== 0;
  const isPremium = seedIndex % 5 === 0;
  const ageYears = 23 + (seedIndex % 13);
  const profileCompletion = 66 + (seedIndex % 33);
  const [photoOne, photoTwo, photoThree] = buildPhotoUrls(isWoman, seedIndex);
  const firstName = baseName.split(" ")[0];
  const genderLabel = isWoman ? "Woman" : "Man";
  const showGenderOnProfile = seedIndex % 9 !== 0;

  const bio = clip(
    `${firstName} (${genderLabel.toLowerCase()}, ${ageYears}) lives in ${CITY.city}. ` +
      `Into ${pick(INTERESTS, seedIndex).toLowerCase()}, ${pick(INTERESTS, seedIndex + 3).toLowerCase()}, and ${pick(INTERESTS, seedIndex + 7).toLowerCase()}. ` +
      `${pick(DRINKING, seedIndex)} on drinks, ${pick(SMOKING, seedIndex + 1).toLowerCase()} on smoke, stays active with ${pick(EXERCISE, seedIndex + 2).toLowerCase()}. ` +
      `Usually between Cyber Hub, Golf Course Road, and weekend coffee plans.`,
    900
  );
  const presetMessage = clip(
    `Coffee first, no pressure. If we vibe, maybe ${pick(INTERESTS, seedIndex + 4).toLowerCase()} or a walk in Gurgaon.`,
    240
  );

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
       $10, $11, $12, $13,
       ST_SetSRID(ST_MakePoint($14::double precision, $15::double precision), 4326), TRUE, 'main', NOW(),
       $16, $17, $18,
       NOW() - ($19 * INTERVAL '1 hour'), NOW(), NOW() - ($20 * INTERVAL '1 minute'),
       CASE WHEN $21 THEN NOW() + INTERVAL '3 days' ELSE NULL END
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
       account_state = EXCLUDED.account_state,
       location = EXCLUDED.location,
       location_granted = TRUE,
       profile_completion_percentage = EXCLUDED.profile_completion_percentage,
       living_in_city = EXCLUDED.living_in_city,
       living_in_city_mode = EXCLUDED.living_in_city_mode,
       last_active_at = EXCLUDED.last_active_at,
       new_here_until = EXCLUDED.new_here_until,
       updated_at = NOW()
     RETURNING id`,
    [
      randomUUID(),
      phone.slice(3),
      phone,
      baseName,
      ageYears,
      ageYears,
      genderLabel,
      genderLabel,
      seedIndex % 4 === 0 ? "Single" : "Separated",
      showGenderOnProfile,
      isVerified,
      isPremium,
      accountState,
      jitter(CITY.lng),
      jitter(CITY.lat),
      profileCompletion,
      CITY.city,
      seedIndex % 6 === 0 ? "MANUAL_SWITCH" : "FOLLOW_DEVICE",
      seedIndex % 72,
      seedIndex % 360,
      seedIndex % 4 === 0,
    ]
  );

  const userId = userRes.rows[0].id;
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
      60 + (seedIndex % 14),
      pick(DRINKING, seedIndex),
      pick(SMOKING, seedIndex),
      pick(EXERCISE, seedIndex),
      pick(RELIGIONS, seedIndex),
      pick(EDUCATION, seedIndex),
      pick(STAR_SIGNS, seedIndex),
      pick(KIDS, seedIndex),
      pick(POLITICS, seedIndex),
      pick(PETS, seedIndex),
      pick(ETHNICITIES, seedIndex),
      pick(JOBS, seedIndex),
      pick(COMPANIES, seedIndex),
      pick(COLLEGES, seedIndex),
      2012 + (seedIndex % 11),
      pick(HOMETOWNS, seedIndex),
    ]
  );

  await client.query(`INSERT INTO user_filters (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [userId]);
  await client.query(`DELETE FROM user_dating_preferences WHERE user_id = $1`, [userId]);
  await client.query(`DELETE FROM user_filter_preferred_genders WHERE user_id = $1`, [userId]);
  const targetGender = isWoman ? "Man" : "Woman";
  await client.query(`INSERT INTO user_dating_preferences (user_id, preferred_gender) VALUES ($1, $2)`, [userId, targetGender]);
  await client.query(`INSERT INTO user_dating_preferences (user_id, preferred_gender) VALUES ($1, 'Nonbinary') ON CONFLICT (user_id, preferred_gender) DO NOTHING`, [userId]);
  await client.query(`INSERT INTO user_filter_preferred_genders (user_id, gender) VALUES ($1, $2)`, [userId, targetGender]);
  await client.query(
    `UPDATE user_filters
     SET distance_pref_km = $2,
         age_min = 18,
         age_max = 65,
         expand_age_range = TRUE,
         expand_distance = TRUE,
         only_verified_profiles = FALSE,
         preferred_location_city = $3,
         min_height_inches = $4,
         max_height_inches = $5,
         show_other_people_if_run_out = TRUE,
         updated_at = NOW()
     WHERE user_id = $1`,
    [userId, 35 + (seedIndex % 45), CITY.city, 60, 78]
  );

  await client.query(`DELETE FROM user_looking_for WHERE user_id = $1`, [userId]);
  await client.query(`DELETE FROM user_filter_looking_for WHERE user_id = $1`, [userId]);
  const lfPrimary = pick(LOOKING_FOR, seedIndex);
  let lfSecondary = pick(LOOKING_FOR, seedIndex + 1);
  if (lfSecondary === lfPrimary) lfSecondary = pick(LOOKING_FOR, seedIndex + 2);
  for (const lf of [lfPrimary, lfSecondary]) {
    await client.query(`INSERT INTO user_looking_for (user_id, looking_for_option) VALUES ($1, $2)`, [userId, lf]);
    await client.query(`INSERT INTO user_filter_looking_for (user_id, looking_for_option) VALUES ($1, $2)`, [userId, lf]);
  }

  const interestRows = pickUnique(INTERESTS, seedIndex * 3, 7);
  const languageRows = pickUnique(LANGUAGES, seedIndex * 2 + 1, 5);

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
  const filterLangSubset = pickUnique(languageRows, seedIndex + 2, Math.min(3, languageRows.length));
  for (const language of filterLangSubset) {
    await client.query(
      `INSERT INTO user_filter_languages (user_id, language) VALUES ($1, $2) ON CONFLICT (user_id, language) DO NOTHING`,
      [userId, language]
    );
  }

  await client.query(`DELETE FROM user_pronouns WHERE user_id = $1`, [userId]);
  const pronouns = [...PRONOUN_ROWS[genderLabel]];
  if (seedIndex % 7 === 0) pronouns.push("They/Them");
  for (const pronoun of pronouns) {
    await client.query(
      `INSERT INTO user_pronouns (user_id, pronoun) VALUES ($1, $2) ON CONFLICT (user_id, pronoun) DO NOTHING`,
      [userId, pronoun]
    );
  }

  await client.query(`DELETE FROM user_written_prompts WHERE user_id = $1`, [userId]);
  const pair = pick(PROMPT_PAIRS, seedIndex);
  const promptA1 = clip(pair.a1(firstName), 180);
  const promptA2 = clip(pair.a2(firstName), 180);
  await client.query(
    `INSERT INTO user_written_prompts (user_id, prompt_order, prompt_question, prompt_answer)
     VALUES ($1, 1, $2, $3), ($1, 2, $4, $5)`,
    [userId, pair.q1, promptA1, pair.q2, promptA2]
  );
  if (seedIndex % 3 === 0) {
    await client.query(
      `INSERT INTO user_written_prompts (user_id, prompt_order, prompt_question, prompt_answer)
       VALUES ($1, 3, $2, $3)`,
      [userId, "Green flags I notice fast", "Clear communication, respect, and emotional maturity."]
    );
  }

  await client.query(`DELETE FROM user_photos WHERE user_id = $1`, [userId]);
  await client.query(
    `INSERT INTO user_photos (user_id, photo_url, photo_order, is_primary, moderation_status)
     VALUES
       ($1, $2, 1, TRUE, 'APPROVED'),
       ($1, $3, 2, FALSE, 'APPROVED'),
       ($1, $4, 3, FALSE, 'APPROVED')`,
    [userId, photoOne, photoTwo, photoThree]
  );

  await client.query(`DELETE FROM premium_boosts WHERE user_id = $1`, [userId]);
  if (seedIndex % 8 === 0) {
    await client.query(
      `INSERT INTO premium_boosts (user_id, started_at, expires_at)
       VALUES ($1, NOW() - INTERVAL '8 minutes', NOW() + INTERVAL '24 minutes')`,
      [userId]
    );
  }

  return {
    userId,
    phoneE164: phone,
    name: baseName,
    gender: genderLabel,
    city: CITY.city,
    accountState,
    verified: isVerified,
    premium: isPremium,
  };
}

async function main() {
  const parsedCount = Number.parseInt(String(process.argv[2] || "200"), 10);
  const count = Number.isFinite(parsedCount) ? Math.max(1, Math.min(500, parsedCount)) : 200;

  if (!process.env.DATABASE_URL || String(process.env.DATABASE_URL).trim() === "") {
    console.error("seedGurugramRichProfiles: DATABASE_URL is missing or empty.");
    process.exit(1);
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  try {
    await client.query("BEGIN");
    await deleteOldBatch(client);
    const out = [];
    for (let i = 1; i <= count; i += 1) {
      if (i % 50 === 0) console.error(`[seed:guru] seeded ${i}/${count}`);
      out.push(await upsertUser(client, i));
    }
    await client.query("COMMIT");
    console.log(JSON.stringify({
      success: true,
      city: CITY.city,
      seededUsers: out.length,
      phonePrefix: `+91${SEED_PHONE_PREFIX}`,
      sample: out.slice(0, 10),
    }, null, 2));
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("seedGurugramRichProfiles failed:", error.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();
