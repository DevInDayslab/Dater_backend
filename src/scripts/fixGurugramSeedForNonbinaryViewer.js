require("dotenv").config();
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const { pool, query } = require("../config/db");

async function main() {
  const pattern = "+91977440%";
  await query(
    `INSERT INTO user_dating_preferences (user_id, preferred_gender)
     SELECT id, 'Nonbinary'
     FROM users
     WHERE phone_e164 LIKE $1
     ON CONFLICT (user_id, preferred_gender) DO NOTHING`,
    [pattern]
  );

  const res = await query(
    `SELECT COUNT(*)::int AS count
     FROM user_dating_preferences udp
     JOIN users u ON u.id = udp.user_id
     WHERE u.phone_e164 LIKE $1
       AND udp.preferred_gender = 'Nonbinary'`,
    [pattern]
  );

  console.log(
    JSON.stringify(
      {
        success: true,
        seededPrefix: pattern,
        usersWithNonbinaryPreference: res.rows[0]?.count || 0,
      },
      null,
      2
    )
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => pool.end());
