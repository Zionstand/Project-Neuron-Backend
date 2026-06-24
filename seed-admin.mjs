import 'dotenv/config';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import bcrypt from 'bcrypt';

neonConfig.webSocketConstructor = ws;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const ADMIN = {
  email: 'admin@oyomoest.ng',
  password: 'ChangeMe@2026',
  firstName: 'System',
  lastName: 'Administrator',
  username: 'system-administrator',
  phone: '+2348000000001',
};

try {
  const hash = await bcrypt.hash(ADMIN.password, 10);
  const res = await pool.query(
    `INSERT INTO "User"
       (id, "firstName", "lastName", username, email, "phoneNumber", password,
        role, "accountStatus", "requiresPasswordChange", "updatedAt")
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6,
        'SYS_ADMIN', 'ACTIVE', false, now())
     ON CONFLICT (email) DO UPDATE
       SET role='SYS_ADMIN', "accountStatus"='ACTIVE', "updatedAt"=now()
     RETURNING (xmax = 0) AS inserted`,
    [ADMIN.firstName, ADMIN.lastName, ADMIN.username, ADMIN.email, ADMIN.phone, hash],
  );
  const inserted = res.rows[0]?.inserted;
  console.log(
    inserted
      ? `Created SYS_ADMIN: ${ADMIN.email} / ${ADMIN.password}`
      : `SYS_ADMIN already existed (${ADMIN.email}) — ensured role=SYS_ADMIN, ACTIVE. Password unchanged.`,
  );
} catch (e) {
  console.error('SEED ADMIN FAILED:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
