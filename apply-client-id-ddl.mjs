// Applies the offline-batch idempotency key to Neon (prisma migrate fails P1001
// here — see memory neuron-db-migrations). Each statement is autocommit. Idempotent.
//
//   Adds a nullable "clientId" to the three register tables + SchoolMedia, plus
//   a unique index on (schoolId, periodId, source, clientId). The device mints
//   the clientId before a row is first sent, so replaying a queued offline batch
//   upserts the same rows instead of duplicating them. On SchoolMedia it also
//   stops a replayed upload pushing a second copy of the file to Cloudinary.
//
// Nullable is deliberate: Postgres treats NULLs as distinct in a unique index, so
// every row created before this migration (and any created online without a key)
// coexists happily.
//
// GOTCHA (learned): Prisma @@unique is a unique INDEX — create it with
// CREATE UNIQUE INDEX IF NOT EXISTS, not ADD CONSTRAINT.
import 'dotenv/config';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';

neonConfig.webSocketConstructor = ws;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, params) => pool.query(text, params);

// Index names match what Prisma generates for @@unique, so a future
// `prisma migrate diff` sees no drift.
const TABLES = [
  ['AscRecord', 'AscRecord_schoolId_periodId_source_clientId_key'],
  ['StudentRecord', 'StudentRecord_schoolId_periodId_source_clientId_key'],
  ['StaffRecord', 'StaffRecord_schoolId_periodId_source_clientId_key'],
  ['SchoolMedia', 'SchoolMedia_schoolId_periodId_source_clientId_key'],
];

try {
  await q('SELECT 1'); // wake the auto-suspended compute

  for (const [table, indexName] of TABLES) {
    await q(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "clientId" TEXT`);
    await q(
      `CREATE UNIQUE INDEX IF NOT EXISTS "${indexName}"
         ON "${table}" ("schoolId", "periodId", "source", "clientId")`,
    );
    console.log(`✓ ${table}: clientId + unique index`);
  }

  // Confirm via information_schema rather than trusting the DDL silently.
  const { rows } = await q(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_name = ANY($1) AND column_name = 'clientId'
      ORDER BY table_name`,
    [TABLES.map(([t]) => t)],
  );
  console.log(
    `\nVerified ${rows.length}/${TABLES.length} columns:`,
    rows.map((r) => r.table_name).join(', '),
  );
  if (rows.length !== TABLES.length) process.exitCode = 1;
} catch (err) {
  console.error('DDL failed:', err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
