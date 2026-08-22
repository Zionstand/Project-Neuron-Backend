// Adds the Module A0 "School Profile Confirmation" columns to Neon (prisma
// migrate fails P1001 here — see memory neuron-db-migrations). Idempotent.
//
//   SchoolSecurityProfile gains ownership / schoolCategory / genderCategory.
//   These three attributes already exist on the School master record, but only
//   an admin could set them and admins don't have the data — so the field
//   officer now confirms them during the vulnerability assessment and the
//   submit handler writes the answer back onto School.
//
// TEXT (not the SchoolOwnership/SchoolCategory/GenderCategory enum types) to
// match this model's convention of storing categorical capture answers as
// strings validated in the DTO. The values stored ARE the enum codes, so the
// write-back casts cleanly.
//
// Nullable is deliberate: existing drafts and already-submitted profiles keep
// working, they just read NULL for prior capture rounds.
import 'dotenv/config';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';

neonConfig.webSocketConstructor = ws;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, params) => pool.query(text, params);

const TABLE = 'SchoolSecurityProfile';
const COLUMNS = ['ownership', 'schoolCategory', 'genderCategory'];

try {
  await q('SELECT 1'); // wake the auto-suspended compute

  for (const col of COLUMNS) {
    await q(`ALTER TABLE "${TABLE}" ADD COLUMN IF NOT EXISTS "${col}" TEXT`);
    console.log(`✓ ${TABLE}.${col}`);
  }

  // Confirm via information_schema rather than trusting the DDL silently.
  const { rows } = await q(
    `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_name = $1 AND column_name = ANY($2)
      ORDER BY column_name`,
    [TABLE, COLUMNS],
  );
  console.log(`\nVerified ${rows.length}/${COLUMNS.length} columns:`);
  for (const r of rows) {
    console.log(`  ${r.column_name} — ${r.data_type}, nullable=${r.is_nullable}`);
  }
  if (rows.length !== COLUMNS.length) process.exitCode = 1;
} catch (err) {
  console.error('DDL failed:', err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
