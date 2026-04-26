require("dotenv").config();

const { Client } = require("pg");
const { randomUUID } = require("crypto");

const CITY_POINTS = [
  { city: "Delhi, DL", lat: 28.6139, lng: 77.209 },
  { city: "Gurugram, HR", lat: 28.4595, lng: 77.0266 },
  { city: "Noida, UP", lat: 28.5355, lng: 77.391 },
];

const GENDER_CYCLE = ["Woman", "Man", "Nonbinary"];

const NAMES = {
  Woman: [
    "Aanya Kapoor", "Diya Sharma", "Riya Malhotra", "Myra Gupta", "Suhani Arora", "Anaya Jain",
    "Kiara Bhatia", "Ira Khanna", "Meher Sethi", "Navya Mehta", "Tara Nair", "Prisha Arora",
  ],
  Man: [
    "Arjun Malhotra", "Kabir Sharma", "Vivaan Mehta", "Aarav Jain", "Reyansh Gupta", "Ivaan Arora",
    "Abeer Khanna", "Yuvaan Sethi", "Neil Bhatia", "Rohan Kapoor", "Laksh Nair", "Advik Taneja",
  ],
  Nonbinary: [
    "Sam Roy", "Alex Verma", "Ari Singh", "Jordan Das", "Kai Mehta", "Rin Kapoor",
    "Noor Sen", "Skye Batra", "Ishan Dev", "Tenzin Rao", "Sage Ahuja", "Milan Bose",
  ],
};

const INTERESTS = [
  "Travel", "Fitness", "Music", "Movies", "Food", "Pets", "Reading", "Art",
  "Photography", "Writing", "Hiking", "Coffee", "Cooking", "Tech", "Dancing", "Cycling",
  "Board games", "Live gigs", "Theatre", "Volunteering",
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
  "Software Engineer", "Product Manager", "UX Designer", "Doctor", "Lawyer", "Marketing Lead",
  "Analyst", "Architect", "Founder", "Consultant", "Teacher", "Content Creator",
];
const COMPANIES = [
  "Google", "Microsoft", "Zomato", "Swiggy", "Deloitte", "Accenture",
  "TCS", "Infosys", "CRED", "Meesho", "Urban Company", "Paytm",
];
const COLLEGES = [
  "Delhi University", "IIT Delhi", "JNU", "Amity University", "IP University", "Ashoka University",
  "BITS Pilani", "IIM Ahmedabad", "Symbiosis", "SRCC", "NIFT", "Jamia Millia Islamia",
];
const HOMETOWNS = [
  "Delhi, DL", "Jaipur, RJ", "Lucknow, UP", "Chandigarh, CH", "Bhopal, MP", "Indore, MP",
  "Pune, MH", "Kolkata, WB", "Hyderabad, TS", "Ahmedabad, GJ",
];

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

function buildPhotoUrls(gender, index) {
  const folder = gender === "Woman" ? "women" : "men";
  const p1 = (index % 60) + 1;
  const p2 = ((index + 19) % 60) + 1;
  return [
    `https://randomuser.me/api/portraits/${folder}/${p1}.jpg`,
    `https://randomuser.me/api/portraits/${folder}/${p2}.jpg`,
  ];
}

function targetGenderFor(gender, index) {
  if (gender === "Woman") return index % 4 === 0 ? "Nonbinary" : "Man";
  if (gender === "Man") return index % 4 === 0 ? "Nonbinary" : "Woman";
  return index % 2 === 0 ? "Woman" : "Man";
}

async function upsertUser(client, profileIndex, cityInfo, cityLocalIndex) {
  const gender = pick(GENDER_CYCLE, profileIndex);
  const nameBase = pick(NAMES[gender], cityLocalIndex);
  const displayName = `${nameBase} ${pick(["A", "B", "C", "D", "E"], profileIndex)}.`;
  const firstName = displayName.split(" ")[0];
  const cityShort = cityInfo.city.split(",")[0].trim();
  const ageYears = 22 + (profileIndex % 15);
  const isVerified = profileIndex % 3 !== 0;
  const isPremium = profileIndex % 5 === 0;
  const showGenderOnProfile = profileIndex % 7 !== 0;
  const [photo1, photo2] = buildPhotoUrls(gender, profileIndex);
  const profileCompletion = 70 + (profileIndex % 28);
  const phone = `+91888${String(profileIndex).padStart(7, "0")}`;

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
       CASE WHEN $20 THEN NOW() + INTERVAL '2 days' ELSE NULL END
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
      profileIndex % 30,
      profileIndex % 5 === 0,
    ]
  );

  const userId = userRes.rows[0].id;
  const interests = pickUnique(INTERESTS, profileIndex * 3, 6);
  const languages = pickUnique(LANGUAGES, profileIndex * 2, 4);
  const filterLanguages = pickUnique(languages, profileIndex + 3, Math.min(3, languages.length));
  const lookingFor = pickUnique(LOOKING_FOR, profileIndex, 2);

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
      clip(`${firstName}, ${ageYears}, based in ${cityInfo.city}. Into ${interests.slice(0, 3).join(", ").toLowerCase()} and meaningful conversations.`, 900),
      clip(`Let's meet for coffee and explore ${cityShort}.`, 240),
      58 + (profileIndex % 16),
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
      2011 + (profileIndex % 12),
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
    [userId, 28 + (profileIndex % 35), 18, 65, cityInfo.city, 58, 80]
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

  await client.query(`DELETE FROM user_photos WHERE user_id = $1`, [userId]);
  await client.query(
    `INSERT INTO user_photos (user_id, photo_url, photo_order, is_primary)
     VALUES ($1, $2, 1, TRUE), ($1, $3, 2, FALSE)`,
    [userId, photo1, photo2]
  );

  return { city: cityInfo.city, userId, name: displayName, gender };
}

async function main() {
  const rawPerCity = Number.parseInt(String(process.argv[2] || "80"), 10);
  const perCityCount = Number.isFinite(rawPerCity) ? Math.max(1, Math.min(500, rawPerCity)) : 80;
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
          perCityCount,
          totalSeeded: seeded.length,
          countsByCity: counts,
          preferencesSeededAsInclusive: GENDER_CYCLE,
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
