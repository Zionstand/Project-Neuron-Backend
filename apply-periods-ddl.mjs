// Applies the "capture periods" schema changes to Neon (prisma migrate fails P1001
// here — see memory neuron-db-migrations). Each statement is autocommit. Idempotent.
//
//   New CapturePeriod table + periodId on the 6 capture tables, unique keys swapped
//   from sessionId→periodId. Existing data is backfilled onto a default "Term 1"
//   period per session.
//
// GOTCHA (learned): Prisma @@unique is a unique INDEX — drop the old key with
// DROP INDEX IF EXISTS, not DROP CONSTRAINT.
import 'dotenv/config';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';

neonConfig.webSocketConstructor = ws;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, params) => pool.query(text, params);

const SOURCE_TABLES = [
  'SchoolVisit',
  'SchoolSecurityProfile',
  'AscRecord',
  'StudentRecord',
  'StaffRecord',
  'SchoolMedia',
];

// [table, oldUniqueName (sessionId-based), newUniqueName (periodId-based), newColsSql]
const UNIQUE_SWAPS = [
  ['SchoolVisit', 'SchoolVisit_schoolId_sessionId_source_key', 'SchoolVisit_schoolId_periodId_source_key', '"schoolId","periodId","source"'],
  ['SchoolSecurityProfile', 'SchoolSecurityProfile_schoolId_sessionId_source_key', 'SchoolSecurityProfile_schoolId_periodId_source_key', '"schoolId","periodId","source"'],
  ['AscRecord', 'AscRecord_schoolId_sessionId_source_classLevel_gender_key', 'AscRecord_schoolId_periodId_source_classLevel_gender_key', '"schoolId","periodId","source","classLevel","gender"'],
  ['StudentRecord', 'StudentRecord_schoolId_sessionId_source_studentCode_key', 'StudentRecord_schoolId_periodId_source_studentCode_key', '"schoolId","periodId","source","studentCode"'],
  ['StaffRecord', 'StaffRecord_schoolId_sessionId_source_staffCode_key', 'StaffRecord_schoolId_periodId_source_staffCode_key', '"schoolId","periodId","source","staffCode"'],
];

try {
  // 1. CapturePeriod table.
  await q(`CREATE TABLE IF NOT EXISTS "CapturePeriod" (
    "id" TEXT PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL DEFAULT 1,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "isCurrent" BOOLEAN NOT NULL DEFAULT false,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
    CONSTRAINT "CapturePeriod_sessionId_fkey" FOREIGN KEY ("sessionId")
      REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE
  )`);
  await q(`CREATE UNIQUE INDEX IF NOT EXISTS "CapturePeriod_sessionId_name_key" ON "CapturePeriod"("sessionId","name")`);
  await q(`CREATE INDEX IF NOT EXISTS "CapturePeriod_sessionId_idx" ON "CapturePeriod"("sessionId")`);
  await q(`CREATE INDEX IF NOT EXISTS "CapturePeriod_isCurrent_idx" ON "CapturePeriod"("isCurrent")`);
  console.log('✓ CapturePeriod table');

  // 2. Backfill: a default "Term 1" per session, current where the session is current.
  await q(`INSERT INTO "CapturePeriod" (id, "sessionId", name, sequence, "isCurrent", "updatedAt")
           SELECT gen_random_uuid(), s.id, 'Term 1', 1, s."isCurrent", now()
           FROM "Session" s
           WHERE NOT EXISTS (
             SELECT 1 FROM "CapturePeriod" cp WHERE cp."sessionId" = s.id AND cp.name = 'Term 1'
           )`);
  console.log('✓ default Term 1 period per session');

  // 3. periodId on each capture table: add nullable, backfill from the session's
  //    Term 1, then enforce NOT NULL + FK.
  for (const t of SOURCE_TABLES) {
    await q(`ALTER TABLE "${t}" ADD COLUMN IF NOT EXISTS "periodId" TEXT`);
    await q(`UPDATE "${t}" tbl SET "periodId" = cp.id
             FROM "CapturePeriod" cp
             WHERE cp."sessionId" = tbl."sessionId" AND cp.name = 'Term 1'
             AND tbl."periodId" IS NULL`);
    await q(`ALTER TABLE "${t}" ALTER COLUMN "periodId" SET NOT NULL`);
    await q(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${t}_periodId_fkey') THEN
        ALTER TABLE "${t}" ADD CONSTRAINT "${t}_periodId_fkey"
          FOREIGN KEY ("periodId") REFERENCES "CapturePeriod"("id")
          ON DELETE CASCADE ON UPDATE CASCADE;
      END IF;
    END $$;`);
    await q(`CREATE INDEX IF NOT EXISTS "${t}_periodId_idx" ON "${t}"("periodId")`);
  }
  console.log(`✓ periodId column + FK on ${SOURCE_TABLES.length} tables`);

  // 4. Swap unique keys sessionId→periodId (drop old as index; add new).
  for (const [table, oldName, newName, cols] of UNIQUE_SWAPS) {
    await q(`ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "${oldName}"`);
    await q(`DROP INDEX IF EXISTS "${oldName}"`);
    await q(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${newName}') THEN
        ALTER TABLE "${table}" ADD CONSTRAINT "${newName}" UNIQUE (${cols});
      END IF;
    END $$;`);
  }
  console.log(`✓ ${UNIQUE_SWAPS.length} unique keys swapped to periodId`);

  console.log('\nDDL applied. Now run: pnpm prisma generate');
} catch (e) {
  console.error('DDL FAILED:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
