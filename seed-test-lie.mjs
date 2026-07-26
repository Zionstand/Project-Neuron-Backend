// Creates a disposable LIE (field inspector) account for manual testing —
// specifically the offline capture pass, which needs a role that can submit
// inspections and an LGA that actually has schools in it.
//
// Deliberately a separate account rather than a password reset on a real user:
// the LIE rows in this database belong to actual people.
//
// Known-password account: for local/staging verification only. Do not run this
// against a production database.
import 'dotenv/config';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import bcrypt from 'bcrypt';

neonConfig.webSocketConstructor = ws;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const LIE = {
  email: 'lie.test@oyomoest.ng',
  password: 'FieldTest@2026',
  firstName: 'Field',
  lastName: 'Tester',
  username: 'field-tester',
  phone: '+2348000000099',
};

try {
  // Assign to whichever LGA holds the most schools, so there is something to
  // capture the moment you log in.
  const lga = (
    await pool.query(
      `SELECT "lgaName" FROM "School" WHERE "lgaName" IS NOT NULL
       GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`,
    )
  ).rows[0]?.lgaName;
  if (!lga) throw new Error('No schools in the registry — nothing to assign.');

  const hash = await bcrypt.hash(LIE.password, 10);
  const res = await pool.query(
    `INSERT INTO "User"
       (id, "firstName", "lastName", username, email, "phoneNumber", password,
        role, "accountStatus", "requiresPasswordChange", "assignedLga", "updatedAt")
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6,
        'LIE', 'ACTIVE', false, $7, now())
     ON CONFLICT (email) DO UPDATE
       SET role='LIE', "accountStatus"='ACTIVE', "requiresPasswordChange"=false,
           "assignedLga"=EXCLUDED."assignedLga", password=EXCLUDED.password,
           "updatedAt"=now()
     RETURNING (xmax = 0) AS inserted`,
    [LIE.firstName, LIE.lastName, LIE.username, LIE.email, LIE.phone, hash, lga],
  );
  console.log(
    `${res.rows[0]?.inserted ? 'Created' : 'Reset'} test LIE: ${LIE.email} / ${LIE.password} (LGA: ${lga})`,
  );
} catch (e) {
  console.error('SEED TEST LIE FAILED:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
