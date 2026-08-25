// Post-provisioning sanity check on the target database.
//   node scripts/verify-provision.js
const { Pool, neonConfig } = require('@neondatabase/serverless');
const ws = require('ws');
const { announce } = require('./_target');
neonConfig.webSocketConstructor = ws;

(async () => {
  const pool = new Pool({ connectionString: announce('Verifying') });
  const one = async (label, sql) => {
    const { rows } = await pool.query(sql);
    console.log(`  ${label.padEnd(34)} ${Object.values(rows[0])[0]}`);
  };
  try {
    await one('tables', `SELECT count(*) FROM information_schema.tables WHERE table_schema='public'`);
    await one('zones', `SELECT count(*) FROM "Zone"`);
    await one('LGAs', `SELECT count(*) FROM "Lga"`);
    await one('schools', `SELECT count(*) FROM "School"`);
    await one('schools missing an LGA link', `SELECT count(*) FROM "School" WHERE "lgaId" IS NULL`);
    await one('schools missing a zone link', `SELECT count(*) FROM "School" WHERE "zoneId" IS NULL`);
    await one('sys admins', `SELECT count(*) FROM "User" WHERE role='SYS_ADMIN'`);
    await one('principals', `SELECT count(*) FROM "User" WHERE role='PRINCIPAL'`);
    await one('principals not ACTIVE', `SELECT count(*) FROM "User" WHERE role='PRINCIPAL' AND "accountStatus"<>'ACTIVE'`);
    await one('principals forced to reset', `SELECT count(*) FROM "User" WHERE role='PRINCIPAL' AND "requiresPasswordChange"`);
    await one('principals with no school', `SELECT count(*) FROM "User" WHERE role='PRINCIPAL' AND "assignedSchoolId" IS NULL`);
    await one('schools with no principal', `SELECT count(*) FROM "School" s WHERE NOT EXISTS (SELECT 1 FROM "User" u WHERE u."assignedSchoolId"=s.id)`);
    await one('current sessions', `SELECT count(*) FROM "Session" WHERE "isCurrent"`);
    await one('current capture periods', `SELECT count(*) FROM "CapturePeriod" WHERE "isCurrent"`);
    await one('exposureScore column present', `SELECT count(*) FROM information_schema.columns WHERE table_name='SchoolSecurityProfile' AND column_name='exposureScore'`);
    await one('security profiles (expect 0)', `SELECT count(*) FROM "SchoolSecurityProfile"`);
  } finally { await pool.end(); }
})().catch(e => { console.error('✗', e.message); process.exit(1); });
