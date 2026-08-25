// Seeds the 6 dimension/reference tables from the Field Capture Guide, then
// backfills the additive FK columns on existing fact rows by matching the stored
// string to the dim row. Re-runnable (upsert by natural key).
//
// ⚠️ The Oyo State LGA→Zone mapping and the Subject list are a best-effort seed —
// confirm with MoEST/Alexander and correct via the /admin/reference screen.
import 'dotenv/config';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';

neonConfig.webSocketConstructor = ws;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, params) => pool.query(text, params);

// ─── Reference data ───────────────────────────────────────────────────────────

// Oyo State education zones (best-effort — confirm names/coverage with MoEST).
const ZONES = [
  { code: 'IBADAN', name: 'Ibadan Zone' },
  { code: 'OYO', name: 'Oyo Zone' },
  { code: 'OGBOMOSO', name: 'Ogbomoso Zone' },
  { code: 'OKE_OGUN', name: 'Oke-Ogun Zone' },
  { code: 'IBARAPA', name: 'Ibarapa Zone' },
];

// 33 Oyo State LGAs mapped to a zone (best-effort grouping).
const LGAS = [
  ['OY-AF', 'Afijio', 'OYO'],
  ['OY-AK', 'Akinyele', 'IBADAN'],
  ['OY-AT', 'Atiba', 'OYO'],
  ['OY-AW', 'Atisbo', 'OKE_OGUN'],
  ['OY-EG', 'Egbeda', 'IBADAN'],
  ['OY-IBN', 'Ibadan North', 'IBADAN'],
  ['OY-IBNE', 'Ibadan North-East', 'IBADAN'],
  ['OY-IBNW', 'Ibadan North-West', 'IBADAN'],
  ['OY-IBSE', 'Ibadan South-East', 'IBADAN'],
  ['OY-IBSW', 'Ibadan South-West', 'IBADAN'],
  ['OY-IBA', 'Ibarapa Central', 'IBARAPA'],
  ['OY-IBE', 'Ibarapa East', 'IBARAPA'],
  ['OY-IBN2', 'Ibarapa North', 'IBARAPA'],
  ['OY-IDO', 'Ido', 'IBADAN'],
  ['OY-IREP', 'Irepo', 'OKE_OGUN'],
  ['OY-ISE', 'Iseyin', 'OKE_OGUN'],
  ['OY-ITE', 'Itesiwaju', 'OKE_OGUN'],
  ['OY-IWA', 'Iwajowa', 'OKE_OGUN'],
  ['OY-KAJ', 'Kajola', 'OKE_OGUN'],
  ['OY-LAG', 'Lagelu', 'IBADAN'],
  ['OY-OGB', 'Ogbomoso North', 'OGBOMOSO'],
  ['OY-OGBS', 'Ogbomoso South', 'OGBOMOSO'],
  ['OY-OGO', 'Ogo Oluwa', 'OGBOMOSO'],
  ['OY-OLO', 'Olorunsogo', 'OGBOMOSO'],
  ['OY-ORE', 'Oluyole', 'IBADAN'],
  ['OY-ONA', 'Ona Ara', 'IBADAN'],
  ['OY-ORI', 'Orelope', 'OKE_OGUN'],
  ['OY-ORIR', 'Ori Ire', 'OGBOMOSO'],
  ['OY-OYOE', 'Oyo East', 'OYO'],
  ['OY-OYOW', 'Oyo West', 'OYO'],
  ['OY-SAK', 'Saki East', 'OKE_OGUN'],
  ['OY-SAKW', 'Saki West', 'OKE_OGUN'],
  ['OY-SUR', 'Surulere', 'OGBOMOSO'],
];

// Class levels — code matches the AscRecord/StudentRecord classLevel string.
const CLASS_LEVELS = [
  // Nursery, captured as a single bucket rather than per nursery year (MoEST,
  // Aug 2026). sortOrder 0 so it lands ahead of Pry1 without renumbering.
  ['Pre-Primary', 'Pre-Primary (Nursery)', 'Pre-Primary', 0],
  ['Pry1', 'Primary 1', 'Primary', 1],
  ['Pry2', 'Primary 2', 'Primary', 2],
  ['Pry3', 'Primary 3', 'Primary', 3],
  ['Pry4', 'Primary 4', 'Primary', 4],
  ['Pry5', 'Primary 5', 'Primary', 5],
  ['Pry6', 'Primary 6', 'Primary', 6],
  ['JSS1', 'JSS 1', 'Junior Secondary', 7],
  ['JSS2', 'JSS 2', 'Junior Secondary', 8],
  ['JSS3', 'JSS 3', 'Junior Secondary', 9],
  ['SSS1', 'SSS 1', 'Senior Secondary', 10],
  ['SSS2', 'SSS 2', 'Senior Secondary', 11],
  ['SSS3', 'SSS 3', 'Senior Secondary', 12],
];

// Qualifications — code matches StaffRecord.qualification string.
const QUALIFICATIONS = [
  ['NCE', 'Nigeria Certificate in Education', 1],
  ['OND', 'Ordinary National Diploma', 2],
  ['HND', 'Higher National Diploma', 3],
  ['BSc', 'Bachelor of Science', 4],
  ['BEd', 'Bachelor of Education', 4],
  ['PGDE', 'Postgraduate Diploma in Education', 5],
  ['MSc', 'Master of Science', 6],
  ['MEd', 'Master of Education', 6],
  ['PhD', 'Doctor of Philosophy', 7],
  ['Other', 'Other', 0],
];

// Subjects — name matches StaffRecord.subject string (best-effort standard list).
const SUBJECTS = [
  ['English Language', 'Languages'],
  ['Mathematics', 'STEM'],
  ['Basic Science', 'STEM'],
  ['Physics', 'STEM'],
  ['Chemistry', 'STEM'],
  ['Biology', 'STEM'],
  ['Further Mathematics', 'STEM'],
  ['Agricultural Science', 'STEM'],
  ['Computer Studies / ICT', 'STEM'],
  ['Economics', 'Social Sciences'],
  ['Government', 'Social Sciences'],
  ['Geography', 'Social Sciences'],
  ['History', 'Humanities'],
  ['Civic Education', 'Humanities'],
  ['Christian Religious Studies', 'Humanities'],
  ['Islamic Religious Studies', 'Humanities'],
  ['Yoruba', 'Languages'],
  ['French', 'Languages'],
  ['Literature in English', 'Languages'],
  ['Fine Arts', 'Creative Arts'],
  ['Music', 'Creative Arts'],
  ['Physical & Health Education', 'Creative Arts'],
  ['Business Studies', 'Vocational'],
  ['Home Economics', 'Vocational'],
  ['Social Studies', 'Social Sciences'],
  ['Other', null],
];

// Media categories — code matches SchoolMedia.category string.
const MEDIA_CATEGORIES = [
  ['Module A', 'Location & Access', 'Module A', 'both', 10, 'Approach road, surroundings, distance markers, nearest landmarks.'],
  ['Module B', 'Infrastructure & Perimeter', 'Module B', 'both', 20, 'Fence, gate, entry points, buildings, lighting, power installations.'],
  ['Module C', 'Communication & Emergency', 'Module C', 'both', 10, 'Network masts, landline/radio equipment, nearest security post.'],
  ['Module D', 'Incident Evidence', 'Module D', 'both', 10, 'Any physical evidence relevant to incident history (handle sensitively).'],
  ['General', 'General / Representative', 'General', 'both', 10, 'General representative photo of the school (signboard, frontage).'],
];

const upsert = async (sql, params) => q(sql, params);

try {
  // 1. Zones.
  for (const z of ZONES) {
    await upsert(
      `INSERT INTO "Zone" (id, code, name, "updatedAt") VALUES (gen_random_uuid(), $1, $2, now())
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, "updatedAt" = now()`,
      [z.code, z.name],
    );
  }
  // 2. LGAs (resolve zone).
  for (const [code, name, zoneCode] of LGAS) {
    const zone = (await q(`SELECT id FROM "Zone" WHERE code = $1`, [zoneCode])).rows[0];
    await upsert(
      `INSERT INTO "Lga" (id, code, name, "zoneId", "updatedAt")
       VALUES (gen_random_uuid(), $1, $2, $3, now())
       ON CONFLICT (name) DO UPDATE SET code = EXCLUDED.code, "zoneId" = EXCLUDED."zoneId", "updatedAt" = now()`,
      [code, name, zone?.id ?? null],
    );
  }
  // 3. Class levels.
  for (const [code, name, level, order] of CLASS_LEVELS) {
    await upsert(
      `INSERT INTO "ClassLevel" (id, code, name, "educationLevel", "sortOrder", "updatedAt")
       VALUES (gen_random_uuid(), $1, $2, $3, $4, now())
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, "educationLevel" = EXCLUDED."educationLevel", "sortOrder" = EXCLUDED."sortOrder", "updatedAt" = now()`,
      [code, name, level, order],
    );
  }
  // 4. Qualifications.
  for (const [code, name, rank] of QUALIFICATIONS) {
    await upsert(
      `INSERT INTO "QualificationType" (id, code, name, rank, "updatedAt")
       VALUES (gen_random_uuid(), $1, $2, $3, now())
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, rank = EXCLUDED.rank, "updatedAt" = now()`,
      [code, name, rank],
    );
  }
  // 5. Subjects.
  for (const [name, category] of SUBJECTS) {
    await upsert(
      `INSERT INTO "SubjectArea" (id, name, category, "updatedAt")
       VALUES (gen_random_uuid(), $1, $2, now())
       ON CONFLICT (name) DO UPDATE SET category = EXCLUDED.category, "updatedAt" = now()`,
      [name, category],
    );
  }
  // 6. Media categories.
  for (const [code, name, module, mediaType, maxFiles, desc] of MEDIA_CATEGORIES) {
    await upsert(
      `INSERT INTO "MediaCategory" (id, code, name, "appliesToModule", "mediaTypeAllowed", "maxFilesAllowed", description, "updatedAt")
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, "appliesToModule" = EXCLUDED."appliesToModule",
         "mediaTypeAllowed" = EXCLUDED."mediaTypeAllowed", "maxFilesAllowed" = EXCLUDED."maxFilesAllowed",
         description = EXCLUDED.description, "updatedAt" = now()`,
      [code, name, module, mediaType, maxFiles, desc],
    );
  }
  console.log('✓ Seeded dimension tables');

  // 7. Backfill fact FKs by matching stored strings → dim rows.
  const backfills = [
    [`UPDATE "AscRecord" a SET "classLevelId" = c.id FROM "ClassLevel" c WHERE a."classLevel" = c.code AND a."classLevelId" IS NULL`, 'AscRecord.classLevelId'],
    [`UPDATE "StudentRecord" s SET "classLevelId" = c.id FROM "ClassLevel" c WHERE s."classLevel" = c.code AND s."classLevelId" IS NULL`, 'StudentRecord.classLevelId'],
    [`UPDATE "StaffRecord" s SET "qualId" = qt.id FROM "QualificationType" qt WHERE s."qualification" = qt.code AND s."qualId" IS NULL`, 'StaffRecord.qualId'],
    [`UPDATE "StaffRecord" s SET "subjectId" = sa.id FROM "SubjectArea" sa WHERE s."subject" = sa.name AND s."subjectId" IS NULL`, 'StaffRecord.subjectId'],
    [`UPDATE "SchoolMedia" m SET "mediaCategoryId" = mc.id FROM "MediaCategory" mc WHERE m."category" = mc.code AND m."mediaCategoryId" IS NULL`, 'SchoolMedia.mediaCategoryId'],
    [`UPDATE "School" sc SET "lgaId" = l.id FROM "Lga" l WHERE sc."lgaName" = l.name AND sc."lgaId" IS NULL`, 'School.lgaId'],
    [`UPDATE "School" sc SET "zoneId" = l."zoneId" FROM "Lga" l WHERE sc."lgaId" = l.id AND sc."zoneId" IS NULL`, 'School.zoneId'],
  ];
  for (const [sql, label] of backfills) {
    const r = await q(sql);
    console.log(`  backfilled ${label}: ${r.rowCount} rows`);
  }

  console.log('Seed OK — reference tables + fact FK backfill complete.');
} catch (e) {
  console.error('SEED FAILED:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
