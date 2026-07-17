// Applies the "principal self-service portal" schema changes to Neon.
// prisma migrate/db push fail with P1001 on this machine, so DDL is hand-applied
// via the Neon WS driver (see project memory: neuron-db-migrations), then
// `pnpm prisma generate` regenerates the client.
//
// Each statement runs in its own autocommit round-trip. This matters:
// `ALTER TYPE ... ADD VALUE` cannot run inside a transaction block.
//
// Idempotent — safe to re-run.
import 'dotenv/config';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';

neonConfig.webSocketConstructor = ws;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, params) => pool.query(text, params);

// Capture tables that gain a `source` discriminator column.
const SOURCE_TABLES = [
  'SchoolVisit',
  'SchoolSecurityProfile',
  'AscRecord',
  'StudentRecord',
  'StaffRecord',
  'SchoolMedia',
];

// Unique-key swaps: [table, oldConstraintName, newConstraintName, newColsSql]
const UNIQUE_SWAPS = [
  ['SchoolVisit', 'SchoolVisit_schoolId_sessionId_key', 'SchoolVisit_schoolId_sessionId_source_key', '"schoolId","sessionId","source"'],
  ['SchoolSecurityProfile', 'SchoolSecurityProfile_schoolId_sessionId_key', 'SchoolSecurityProfile_schoolId_sessionId_source_key', '"schoolId","sessionId","source"'],
  ['AscRecord', 'AscRecord_schoolId_sessionId_classLevel_gender_key', 'AscRecord_schoolId_sessionId_source_classLevel_gender_key', '"schoolId","sessionId","source","classLevel","gender"'],
  ['StudentRecord', 'StudentRecord_schoolId_sessionId_studentCode_key', 'StudentRecord_schoolId_sessionId_source_studentCode_key', '"schoolId","sessionId","source","studentCode"'],
  ['StaffRecord', 'StaffRecord_schoolId_sessionId_staffCode_key', 'StaffRecord_schoolId_sessionId_source_staffCode_key', '"schoolId","sessionId","source","staffCode"'],
];

try {
  // 1. Role enum += PRINCIPAL (standalone statement — no txn).
  await q(`ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'PRINCIPAL'`);
  console.log('✓ Role += PRINCIPAL');

  // 2. CaptureSource enum (idempotent create).
  await q(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CaptureSource') THEN
      CREATE TYPE "CaptureSource" AS ENUM ('INSPECTOR', 'PRINCIPAL');
    END IF;
  END $$;`);
  console.log('✓ CaptureSource enum');

  // 3. source column on every capture table (existing rows backfill to INSPECTOR).
  for (const t of SOURCE_TABLES) {
    await q(`ALTER TABLE "${t}" ADD COLUMN IF NOT EXISTS "source" "CaptureSource" NOT NULL DEFAULT 'INSPECTOR'`);
  }
  console.log(`✓ source column on ${SOURCE_TABLES.length} tables`);

  // 4. User.assignedSchoolId + FK + index.
  await q(`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "assignedSchoolId" TEXT`);
  await q(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'User_assignedSchoolId_fkey') THEN
      ALTER TABLE "User" ADD CONSTRAINT "User_assignedSchoolId_fkey"
        FOREIGN KEY ("assignedSchoolId") REFERENCES "School"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
  END $$;`);
  await q(`CREATE INDEX IF NOT EXISTS "User_assignedSchoolId_idx" ON "User"("assignedSchoolId")`);
  console.log('✓ User.assignedSchoolId + FK + index');

  // 5. Swap unique keys to include source. Prisma's @@unique is backed by a unique
  // INDEX, so drop the old one as both a constraint AND an index (DROP CONSTRAINT
  // silently no-ops on a bare index).
  for (const [table, oldName, newName, cols] of UNIQUE_SWAPS) {
    await q(`ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "${oldName}"`);
    await q(`DROP INDEX IF EXISTS "${oldName}"`);
    await q(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${newName}') THEN
        ALTER TABLE "${table}" ADD CONSTRAINT "${newName}" UNIQUE (${cols});
      END IF;
    END $$;`);
  }
  console.log(`✓ ${UNIQUE_SWAPS.length} unique constraints swapped to include source`);

  console.log('\nDDL applied. Now run: pnpm prisma generate');
} catch (e) {
  console.error('DDL FAILED:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
