/**
 * Seeds rich profiles for Delhi + Gurugram only, using local portraits from
 * DaterApp/app/src/main/assets/mock_people_images/ uploaded to S3.
 *
 * Requires: DATABASE_URL, AWS credentials, S3_MEDIA_BUCKET (same as other photo seeds).
 *
 * From backend/:
 *   npm run seed:feed:delhi-gurugram-rich
 *   npm run seed:feed:delhi-gurugram-rich -- 50    # per city (default 45)
 */
require("dotenv").config();
const path = require("path");
const fs = require("fs");

const { Client } = require("pg");
const { randomUUID } = require("crypto");
const s3Media = require("../services/s3Media.service");

const CITY_POINTS = [
  { city: "Delhi, DL", lat: 28.6139, lng: 77.209 },
  { city: "Gurugram, HR", lat: 28.4595, lng: 77.0266 },
];

const GENDER_CYCLE = ["Woman", "Man", "Nonbinary"];

const NAMES = {
  Woman: [
    "Aanya Kapoor", "Diya Sharma", "Riya Malhotra", "Myra Gupta", "Suhani Arora", "Anaya Jain",
    "Kiara Bhatia", "Ira Khanna", "Meher Sethi", "Navya Mehta", "Tara Nair", "Prisha Arora",
    "Vanya Oberoi", "Saanvi Talwar", "Ahana Khurana", "Mira Sen",
  ],
  Man: [
    "Arjun Malhotra", "Kabir Sharma", "Vivaan Mehta", "Aarav Jain", "Reyansh Gupta", "Ivaan Arora",
    "Abeer Khanna", "Yuvaan Sethi", "Neil Bhatia", "Rohan Kapoor", "Laksh Nair", "Advik Taneja",
    "Vihaan Oberoi", "Shaurya Talwar", "Dev Khurana", "Karan Sen",
  ],
  Nonbinary: [
    "Sam Roy", "Alex Verma", "Ari Singh", "Jordan Das", "Kai Mehta", "Rin Kapoor",
    "Noor Sen", "Skye Batra", "Ishan Dev", "Tenzin Rao", "Sage Ahuja", "Milan Bose",
    "Indra Gill", "Remy Rao", "Blair Sen", "River Das",
  ],
};

const INTERESTS = [
  "Travel", "Fitness", "Music", "Movies", "Food", "Pets", "Reading", "Art",
  "Photography", "Writing", "Hiking", "Coffee", "Cooking", "Tech", "Dancing", "Cycling",
  "Wine tasting", "Cricket", "Stand-up comedy", "Meditation",
];
const LANGUAGES = [
  "Hindi", "English", "Punjabi", "Urdu", "Bengali", "Marathi", "Tamil", "Telugu",
  "Gujarati", "Kannada", "Spanish", "French",
];
const LOOKING_FOR = ["Marriage", "Long-term relationship", "Meaningful connection", "Casual dating"];
const RELIGIONS = ["Hindu", "Muslim", "Sikh", "Christian", "Spiritual", "Prefer not to say"];
const EDUCATION = ["Undergraduate degree", "Postgraduate degree", "MBA", "Doctorate"];
const EXERCISE = ["Gym", "Yoga", "Running", "Sports", "Active lifestyle"];
const DRINKING = ["Never", "Sometimes", "Socially"];
const SMOKING = ["Never", "Occasionally"];
const STAR_SIGNS = ["Aries", "Taurus", "Gemini", "Leo", "Libra", "Scorpio", "Sagittarius", "Pisces"];
const KIDS = ["Want someday", "Open to kids", "Don't want more", "Not sure yet"];
const POLITICS = ["Moderate", "Apolitical", "Liberal", "Conservative"];
const PETS = ["Dog lover", "Cat lover", "Pet friendly", "No pets"];
const ETHNICITIES = ["Indian", "Punjabi", "Bengali", "South Indian", "North Indian", "Mixed"];
const JOBS = [
  "Partner", "Director", "VP Engineering", "Orthopedic Surgeon", "Senior Counsel",
  "Software Engineer", "Product Manager", "UX Designer", "Marketing Lead", "Founder",
  "Investment Analyst", "Architect", "Consultant", "Creative Director",
];
const COMPANIES = [
  "McKinsey", "Goldman Sachs", "Google", "Microsoft", "Deloitte", "BCG",
  "CRED", "Zomato", "Swiggy", "Infosys", "TCS", "Paytm", "Axis Bank", "LEK",
];
const COLLEGES = [
  "IIM Ahmedabad", "IIT Delhi", "SRCC", "St. Stephen's", "Ashoka University",
  "Delhi University", "BITS Pilani", "ISB", "NLSIU", "AIIMS Delhi",
];
const HOMETOWNS = [
  "Delhi, DL", "Jaipur, RJ", "Lucknow, UP", "Chandigarh, CH", "Bhopal, MP", "Indore, MP",
  "Pune, MH", "Kolkata, WB", "Hyderabad, TS", "Ahmedabad, GJ",
];

const PROMPT_PAIRS = [
  {
    q1: "My simple pleasures",
    a1: (first, cityShort) => `${first}: slow mornings, good playlists, and ${cityShort} dining.`,
    q2: "I'm convinced that",
    a2: () => "The best connections start with curiosity and consistency.",
  },
  {
    q1: "The key to my heart is",
    a1: () => "Honesty, humor, and someone who shows up.",
    q2: "Together, we could",
    a2: (_first, cityShort) => `Explore ${cityShort}, try new spots, and plan trips without overthinking.`,
  },
];

const PRONOUN_BY_MAIN = {
  Woman: ["She/Her"],
  Man: ["He/Him"],
  Nonbinary: ["They/Them"],
};

const mockPeopleImagesDir = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "DaterApp",
  "app",
  "src",
  "main",
  "assets",
  "mock_people_images"
);

const mockPeopleImageFiles = (() => {
  try {
    return fs
      .readdirSync(mockPeopleImagesDir)
      .filter((f) => /\.(jpg|jpeg|png|webp)$/i.test(f))
      .sort();
  } catch (_e) {
    return [];
  }
})();

function pickSeedPhotoFiles(index) {
  return [
    mockPeopleImageFiles[index % mockPeopleImageFiles.length],
    mockPeopleImageFiles[(index + 11) % mockPeopleImageFiles.length],
  ];
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

function pick(list, index) {
  return list[index % list.length];
}

function jitter(base, delta = 0.09) {
  return base + (Math.random() * 2 - 1) * delta;
}

function clip(value, maxLen) {
  const s = String(value || "").trim();
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen - 1)}…`;
}

function pickUnique(list, seed, count) {
  const out = [];
  let i = 0;
  while (out.length < count && i < list.length * 5) {
    const item = pick(list, seed + i);
    i += 1;
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

async function upsertUser(client, profileIndex, cityInfo, cityLocalIndex) {
  const gender = pick(GENDER_CYCLE, profileIndex);
  const nameBase = pick(NAMES[gender], cityLocalIndex);
  const displayName = `${nameBase} ${pick(["I", "II", "III"], profileIndex)}`;
  const firstName = displayName.split(" ")[0];
  const cityShort = cityInfo.city.split(",")[0].trim();
  const ageYears = 24 + (profileIndex % 14);
  const isVerified = profileIndex % 11 !== 0;
  const isPremium = profileIndex % 3 !== 0;
  const showGenderOnProfile = profileIndex % 9 !== 0;
  const profileCompletion = 90 + (profileIndex % 10);
  const phone = `+919770${String(profileIndex).padStart(7, "0")}`;

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
       ST_SetSRID(ST_MakePoint($13::double precision, $14::double precision), 4326), TRUE, 'main', NOW(),
       $15, $16, $17,
       NOW() - ($18 * INTERVAL '1 hour'), NOW(), NOW() - ($19 * INTERVAL '1 minute'),
       CASE WHEN $20 THEN NOW() + INTERVAL '3 days' ELSE NULL END
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
      phone.slice(3),
      phone,
      displayName,
      ageYears,
      ageYears,
      gender,
      gender,
      pick(["Single", "Separated", "Divorced"], profileIndex),
      showGenderOnProfile,
      isVerified,
      isPremium,
      jitter(cityInfo.lng),
      jitter(cityInfo.lat),
      profileCompletion,
      cityInfo.city,
      "FOLLOW_DEVICE",
      profileIndex % 120,
      profileIndex % 60,
      profileIndex % 6 === 0,
    ]
  );

  const userId = userRes.rows[0].id;
  const interests = pickUnique(INTERESTS, profileIndex * 3, 7);
  const languages = pickUnique(LANGUAGES, profileIndex * 2, 5);
  const filterLanguages = pickUnique(languages, profileIndex + 3, Math.min(3, languages.length));
  const lookingFor = pickUnique(LOOKING_FOR, profileIndex, 3);

  await client.query(
    `UPDATE users SET
       bio = $2,
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
      clip(
        `${firstName} — ${gender}, ${ageYears}, rooted in ${cityInfo.city}. ${interests.slice(0, 4).join(", ")}. ` +
          `${pick(JOBS, profileIndex)} energy; weekends are for ${pick(interests, profileIndex + 2).toLowerCase()} and great food.`,
        900
      ),
      clip(`Coffee or cocktails in ${cityShort} — let's keep it honest and fun.`, 240),
      58 + (profileIndex % 14),
      pick(DRINKING, profileIndex),
      pick(SMOKING, profileIndex + 1),
      pick(EXERCISE, profileIndex + 2),
      pick(RELIGIONS, profileIndex),
      pick(EDUCATION, profileIndex),
      pick(STAR_SIGNS, profileIndex),
      pick(KIDS, profileIndex),
      pick(POLITICS, profileIndex),
      pick(PETS, profileIndex),
      pick(ETHNICITIES, profileIndex),
      pick(JOBS, profileIndex),
      pick(COMPANIES, profileIndex),
      pick(COLLEGES, profileIndex),
      2008 + (profileIndex % 14),
      pick(HOMETOWNS, profileIndex),
    ]
  );

  await client.query(`INSERT INTO user_filters (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [userId]);
  await client.query(`DELETE FROM user_dating_preferences WHERE user_id = $1`, [userId]);
  await client.query(`DELETE FROM user_filter_preferred_genders WHERE user_id = $1`, [userId]);
  for (const g of GENDER_CYCLE) {
    await client.query(
      `INSERT INTO user_dating_preferences (user_id, preferred_gender) VALUES ($1, $2)`,
      [userId, g]
    );
    await client.query(
      `INSERT INTO user_filter_preferred_genders (user_id, gender) VALUES ($1, $2)`,
      [userId, g]
    );
  }
  await client.query(
    `UPDATE user_filters SET
       distance_pref_km = $2,
       age_min = $3,
       age_max = $4,
       expand_age_range = TRUE,
       expand_distance = TRUE,
       only_verified_profiles = FALSE,
       preferred_location_city = $5,
       min_height_inches = $6,
       max_height_inches = $7,
       show_other_people_if_run_out = TRUE,
       updated_at = NOW()
     WHERE user_id = $1`,
    [userId, 22 + (profileIndex % 45), 18, 65, cityInfo.city, 58, 80]
  );

  await client.query(`DELETE FROM user_interests WHERE user_id = $1`, [userId]);
  for (const interest of interests) {
    await client.query(
      `INSERT INTO user_interests (user_id, interest) VALUES ($1, $2)
       ON CONFLICT (user_id, interest) DO NOTHING`,
      [userId, interest]
    );
  }

  await client.query(`DELETE FROM user_languages WHERE user_id = $1`, [userId]);
  for (const language of languages) {
    await client.query(
      `INSERT INTO user_languages (user_id, language) VALUES ($1, $2)
       ON CONFLICT (user_id, language) DO NOTHING`,
      [userId, language]
    );
  }

  await client.query(`DELETE FROM user_filter_languages WHERE user_id = $1`, [userId]);
  for (const language of filterLanguages) {
    await client.query(
      `INSERT INTO user_filter_languages (user_id, language) VALUES ($1, $2)
       ON CONFLICT (user_id, language) DO NOTHING`,
      [userId, language]
    );
  }

  await client.query(`DELETE FROM user_looking_for WHERE user_id = $1`, [userId]);
  await client.query(`DELETE FROM user_filter_looking_for WHERE user_id = $1`, [userId]);
  for (const lf of lookingFor) {
    await client.query(`INSERT INTO user_looking_for (user_id, looking_for_option) VALUES ($1, $2)`, [userId, lf]);
    await client.query(`INSERT INTO user_filter_looking_for (user_id, looking_for_option) VALUES ($1, $2)`, [userId, lf]);
  }

  await client.query(`DELETE FROM user_pronouns WHERE user_id = $1`, [userId]);
  for (const p of PRONOUN_BY_MAIN[gender] || ["They/Them"]) {
    await client.query(
      `INSERT INTO user_pronouns (user_id, pronoun) VALUES ($1, $2)
       ON CONFLICT (user_id, pronoun) DO NOTHING`,
      [userId, p]
    );
  }

  await client.query(`DELETE FROM user_written_prompts WHERE user_id = $1`, [userId]);
  const pair = pick(PROMPT_PAIRS, profileIndex);
  await client.query(
    `INSERT INTO user_written_prompts (user_id, prompt_order, prompt_question, prompt_answer)
     VALUES ($1, 1, $2, $3), ($1, 2, $4, $5)`,
    [
      userId,
      pair.q1,
      clip(pair.a1(firstName, cityShort), 180),
      pair.q2,
      clip(pair.a2(firstName, cityShort), 180),
    ]
  );

  const [f1, f2] = pickSeedPhotoFiles(profileIndex);
  const first = await uploadSeedPhotoToS3({ userId, filename: f1 });
  const second = await uploadSeedPhotoToS3({ userId, filename: f2 });

  await client.query(`DELETE FROM user_photos WHERE user_id = $1`, [userId]);
  await client.query(
    `INSERT INTO user_photos (user_id, photo_url, photo_order, is_primary, moderation_status, s3_key)
     VALUES ($1, $2, 1, TRUE, 'APPROVED', $4), ($1, $3, 2, FALSE, 'APPROVED', $5)`,
    [userId, first.photoUrl, second.photoUrl, first.s3Key, second.s3Key]
  );

  await client.query(`DELETE FROM premium_boosts WHERE user_id = $1`, [userId]);
  if (profileIndex % 5 === 0) {
    await client.query(
      `INSERT INTO premium_boosts (user_id, started_at, expires_at)
       VALUES ($1, NOW() - INTERVAL '5 minutes', NOW() + INTERVAL '45 minutes')`,
      [userId]
    );
  }

  return { city: cityInfo.city, userId, name: displayName, gender };
}

async function main() {
  if (mockPeopleImageFiles.length === 0) {
    console.error(
      `No images in ${mockPeopleImagesDir}. Add JPG/PNG/WebP under DaterApp/app/src/main/assets/mock_people_images/`
    );
    process.exitCode = 1;
    return;
  }

  const rawPerCity = Number.parseInt(String(process.argv[2] || "45"), 10);
  const perCityCount = Number.isFinite(rawPerCity) ? Math.max(1, Math.min(250, rawPerCity)) : 45;
  const cityBuckets = CITY_POINTS.map((c) => ({ ...c, count: perCityCount }));

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await client.query("BEGIN");
    const seeded = [];
    let profileIndex = 1;
    for (const cityInfo of cityBuckets) {
      for (let i = 0; i < cityInfo.count; i += 1) {
        seeded.push(await upsertUser(client, profileIndex, cityInfo, i));
        profileIndex += 1;
      }
    }
    await client.query("COMMIT");

    const counts = seeded.reduce((acc, row) => {
      acc[row.city] = (acc[row.city] || 0) + 1;
      return acc;
    }, {});

    console.log(
      JSON.stringify(
        {
          success: true,
          mockPeopleImagesDir,
          imageCount: mockPeopleImageFiles.length,
          perCityCount,
          totalSeeded: seeded.length,
          countsByCity: counts,
        },
        null,
        2
      )
    );
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Seed failed:", error.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();
