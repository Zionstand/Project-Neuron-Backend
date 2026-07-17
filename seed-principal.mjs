// Seeds one ACTIVE school PRINCIPAL bound to a seeded Ibadan North school so the
// self-service portal can be demoed immediately. Re-runnable (upsert by email).
//
//   Login:  principal@oyomoest.ng / ChangeMe@2026   (school: OY-IBN-001)
import 'dotenv/config';
import { Pool, neonConfig } from '@neondatabase/serverless';
import bcrypt from 'bcrypt';
import ws from 'ws';

neonConfig.webSocketConstructor = ws;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, params) => pool.query(text, params);

const EMAIL = 'principal@oyomoest.ng';
const PASSWORD = 'ChangeMe@2026';
const SCHOOL_CODE = 'OY-IBN-001';

try {
  const school = (
    await q(`SELECT id, name FROM "School" WHERE code=$1`, [SCHOOL_CODE])
  ).rows[0];
  if (!school) {
    throw new Error(
      `School ${SCHOOL_CODE} not found — run seed-module1.mjs first.`,
    );
  }

  const hash = await bcrypt.hash(PASSWORD, 10);

  await q(
    `INSERT INTO "User"
       (id, "firstName","lastName","username","email","phoneNumber","password",
        "requiresPasswordChange","role","assignedSchoolId","accountStatus","updatedAt")
     VALUES (gen_random_uuid(), 'Grace','Adeyemi','principal-oyibn001',$1,'0803 111 2222',$2,
        false,'PRINCIPAL'::"Role",$3,'ACTIVE'::"AccountStatus", now())
     ON CONFLICT (email) DO UPDATE SET
       role='PRINCIPAL'::"Role",
       "assignedSchoolId"=EXCLUDED."assignedSchoolId",
       "accountStatus"='ACTIVE'::"AccountStatus",
       "requiresPasswordChange"=false,
       "password"=EXCLUDED."password",
       "updatedAt"=now()`,
    [EMAIL, hash, school.id],
  );

  console.log(
    `Seed OK — PRINCIPAL ${EMAIL} bound to "${school.name}" (${SCHOOL_CODE}). Password: ${PASSWORD}`,
  );
} catch (e) {
  console.error('SEED FAILED:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
