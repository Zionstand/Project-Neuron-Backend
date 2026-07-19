// Applies the "Field Capture Guide dataset parity" schema changes to Neon:
//   - 6 dimension/reference tables (Zone, Lga, ClassLevel, QualificationType,
//     SubjectArea, MediaCategory)
//   - additive FK columns on the fact tables (kept alongside existing strings)
//   - School GPS metadata + dateEstablished
//   - SchoolMedia video/EXIF/lifecycle columns
//   - Verified_By / Verification_Date on every fact table
//
// prisma migrate fails P1001 here → hand-applied via the Neon WS driver, then
// `pnpm prisma generate`. Autocommit per statement. Idempotent.
import 'dotenv/config';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';

neonConfig.webSocketConstructor = ws;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, params) => pool.query(text, params);

// [table, columnDefSql]
const ADD_COLUMNS = [
  // School — LGA/Zone FKs, GPS metadata, dateEstablished.
  ['School', '"lgaId" TEXT'],
  ['School', '"zoneId" TEXT'],
  ['School', '"dateEstablished" INTEGER'],
  ['School', '"gpsAccuracyMetres" DOUBLE PRECISION'],
  ['School', '"gpsSampleCount" INTEGER'],
  ['School', '"gpsCaptureTimestamp" TIMESTAMP(3)'],
  ['School', '"gpsVerified" BOOLEAN NOT NULL DEFAULT false'],
  // ASC
  ['AscRecord', '"classLevelId" TEXT'],
  ['AscRecord', '"verifiedById" TEXT'],
  ['AscRecord', '"verifiedAt" TIMESTAMP(3)'],
  // Students
  ['StudentRecord', '"classLevelId" TEXT'],
  ['StudentRecord', '"verifiedById" TEXT'],
  ['StudentRecord', '"verifiedAt" TIMESTAMP(3)'],
  // Staff
  ['StaffRecord', '"qualId" TEXT'],
  ['StaffRecord', '"subjectId" TEXT'],
  ['StaffRecord', '"verifiedById" TEXT'],
  ['StaffRecord', '"verifiedAt" TIMESTAMP(3)'],
  // Security profile
  ['SchoolSecurityProfile', '"verifiedById" TEXT'],
  ['SchoolSecurityProfile', '"verifiedAt" TIMESTAMP(3)'],
  // Media
  ['SchoolMedia', '"mediaCategoryId" TEXT'],
  ['SchoolMedia', '"videoDurationSecs" INTEGER'],
  ['SchoolMedia', '"captureTimestamp" TIMESTAMP(3)'],
  ['SchoolMedia', '"isFlagged" BOOLEAN NOT NULL DEFAULT false'],
  ['SchoolMedia', '"flagReason" TEXT'],
  ['SchoolMedia', '"isActive" BOOLEAN NOT NULL DEFAULT true'],
  ['SchoolMedia', '"verifiedById" TEXT'],
  ['SchoolMedia', '"verifiedAt" TIMESTAMP(3)'],
];

// Dimension FK constraints: [constraintName, table, column, refTable, refCol]
const DIM_FKS = [
  ['Lga_zoneId_fkey', 'Lga', 'zoneId', 'Zone', 'id'],
  ['School_lgaId_fkey', 'School', 'lgaId', 'Lga', 'id'],
  ['School_zoneId_fkey', 'School', 'zoneId', 'Zone', 'id'],
  ['AscRecord_classLevelId_fkey', 'AscRecord', 'classLevelId', 'ClassLevel', 'id'],
  ['StudentRecord_classLevelId_fkey', 'StudentRecord', 'classLevelId', 'ClassLevel', 'id'],
  ['StaffRecord_qualId_fkey', 'StaffRecord', 'qualId', 'QualificationType', 'id'],
  ['StaffRecord_subjectId_fkey', 'StaffRecord', 'subjectId', 'SubjectArea', 'id'],
  ['SchoolMedia_mediaCategoryId_fkey', 'SchoolMedia', 'mediaCategoryId', 'MediaCategory', 'id'],
];

try {
  // 1. Dimension tables.
  await q(`CREATE TABLE IF NOT EXISTS "Zone" (
    "id" TEXT PRIMARY KEY,
    "code" TEXT NOT NULL UNIQUE,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT now()
  )`);
  await q(`CREATE TABLE IF NOT EXISTS "Lga" (
    "id" TEXT PRIMARY KEY,
    "code" TEXT NOT NULL UNIQUE,
    "name" TEXT NOT NULL UNIQUE,
    "zoneId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT now()
  )`);
  await q(`CREATE TABLE IF NOT EXISTS "ClassLevel" (
    "id" TEXT PRIMARY KEY,
    "code" TEXT NOT NULL UNIQUE,
    "name" TEXT NOT NULL,
    "educationLevel" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT now()
  )`);
  await q(`CREATE TABLE IF NOT EXISTS "QualificationType" (
    "id" TEXT PRIMARY KEY,
    "code" TEXT NOT NULL UNIQUE,
    "name" TEXT NOT NULL,
    "rank" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT now()
  )`);
  await q(`CREATE TABLE IF NOT EXISTS "SubjectArea" (
    "id" TEXT PRIMARY KEY,
    "name" TEXT NOT NULL UNIQUE,
    "category" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT now()
  )`);
  await q(`CREATE TABLE IF NOT EXISTS "MediaCategory" (
    "id" TEXT PRIMARY KEY,
    "code" TEXT NOT NULL UNIQUE,
    "name" TEXT NOT NULL,
    "appliesToModule" TEXT,
    "mediaTypeAllowed" TEXT NOT NULL DEFAULT 'image',
    "maxFilesAllowed" INTEGER,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT now()
  )`);
  await q(`CREATE INDEX IF NOT EXISTS "Zone_isActive_idx" ON "Zone"("isActive")`);
  await q(`CREATE INDEX IF NOT EXISTS "Lga_zoneId_idx" ON "Lga"("zoneId")`);
  await q(`CREATE INDEX IF NOT EXISTS "Lga_isActive_idx" ON "Lga"("isActive")`);
  await q(`CREATE INDEX IF NOT EXISTS "ClassLevel_isActive_idx" ON "ClassLevel"("isActive")`);
  await q(`CREATE INDEX IF NOT EXISTS "QualificationType_isActive_idx" ON "QualificationType"("isActive")`);
  await q(`CREATE INDEX IF NOT EXISTS "SubjectArea_isActive_idx" ON "SubjectArea"("isActive")`);
  await q(`CREATE INDEX IF NOT EXISTS "MediaCategory_isActive_idx" ON "MediaCategory"("isActive")`);
  console.log('✓ 6 dimension tables');

  // 2. Additive columns on facts + School.
  for (const [table, colDef] of ADD_COLUMNS) {
    await q(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS ${colDef}`);
  }
  await q(`CREATE INDEX IF NOT EXISTS "School_lgaId_idx" ON "School"("lgaId")`);
  await q(`CREATE INDEX IF NOT EXISTS "School_zoneId_idx" ON "School"("zoneId")`);
  console.log(`✓ ${ADD_COLUMNS.length} additive columns`);

  // 3. FK constraints (ON DELETE SET NULL so editing a dim never deletes facts).
  for (const [name, table, col, refTable, refCol] of DIM_FKS) {
    await q(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}') THEN
        ALTER TABLE "${table}" ADD CONSTRAINT "${name}"
          FOREIGN KEY ("${col}") REFERENCES "${refTable}"("${refCol}")
          ON DELETE SET NULL ON UPDATE CASCADE;
      END IF;
    END $$;`);
  }
  console.log(`✓ ${DIM_FKS.length} dimension FK constraints`);

  console.log('\nDDL applied. Now run: pnpm prisma generate');
} catch (e) {
  console.error('DDL FAILED:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
