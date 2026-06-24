import 'dotenv/config';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';

neonConfig.webSocketConstructor = ws;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const TARGET_LGA = 'Ibadan North';
const SESSION_NAME = '2025/2026';

// A small worklist for the LIE dashboard. status maps to SchoolVisit.overallStatus;
// SKIP means no visit row (renders as NOT_STARTED in the worklist).
const SCHOOLS = [
  { code: 'OY-IBN-001', name: 'Ibadan North Grammar School', type: 'COMBINED_JSS_SSS', ownership: 'PUBLIC', category: 'DAY', gender: 'MIXED', ward: 'Agbowo', community: 'Agbowo', lat: 7.4412, lng: 3.9021, status: 'VERIFIED' },
  { code: 'OY-IBN-002', name: 'Saint Patrick Primary School', type: 'PRIMARY', ownership: 'MISSION', category: 'DAY', gender: 'MIXED', ward: 'Sango', community: 'Sango', lat: 7.4385, lng: 3.8901, status: 'SUBMITTED' },
  { code: 'OY-IBN-003', name: 'Queen of Apostles Girls College', type: 'SSS', ownership: 'MISSION', category: 'BOARDING', gender: 'GIRLS_ONLY', ward: 'Bodija', community: 'Bodija', lat: 7.4301, lng: 3.9105, status: 'SUBMITTED' },
  { code: 'OY-IBN-004', name: 'Bodija Estate Junior School', type: 'JSS', ownership: 'PUBLIC', category: 'DAY', gender: 'MIXED', ward: 'Bodija', community: 'Bodija', lat: 7.4290, lng: 3.9140, status: 'DRAFT' },
  { code: 'OY-IBN-005', name: 'Sango Community Primary School', type: 'PRIMARY', ownership: 'PUBLIC', category: 'DAY', gender: 'MIXED', ward: 'Sango', community: 'Sango', lat: 7.4360, lng: 3.8850, status: 'DRAFT' },
  { code: 'OY-IBN-006', name: 'University of Ibadan Staff School', type: 'PRIMARY', ownership: 'PRIVATE', category: 'DAY', gender: 'MIXED', ward: 'UI', community: 'UI Campus', lat: 7.4440, lng: 3.9000, status: 'SKIP' },
  { code: 'OY-IBN-007', name: 'Mokola High School', type: 'COMBINED_PRY_SSS', ownership: 'PUBLIC', category: 'DAY', gender: 'MIXED', ward: 'Mokola', community: 'Mokola', lat: 7.4015, lng: 3.8870, status: 'SKIP' },
  { code: 'OY-IBN-008', name: 'Aleshinloye Boys Secondary School', type: 'SSS', ownership: 'PUBLIC', category: 'DAY', gender: 'BOYS_ONLY', ward: 'Aleshinloye', community: 'Aleshinloye', lat: 7.3895, lng: 3.8770, status: 'SKIP' },
];

const sectionsFor = (overall) => {
  // Plausible per-section states given the overall rollup.
  switch (overall) {
    case 'VERIFIED':
      return { asc: 'VERIFIED', students: 'VERIFIED', staff: 'VERIFIED', security: 'VERIFIED', media: 'VERIFIED' };
    case 'SUBMITTED':
      return { asc: 'SUBMITTED', students: 'SUBMITTED', staff: 'SUBMITTED', security: 'SUBMITTED', media: 'SUBMITTED' };
    case 'DRAFT':
      return { asc: 'SUBMITTED', students: 'DRAFT', staff: 'NOT_STARTED', security: 'NOT_STARTED', media: 'NOT_STARTED' };
    default:
      return { asc: 'NOT_STARTED', students: 'NOT_STARTED', staff: 'NOT_STARTED', security: 'NOT_STARTED', media: 'NOT_STARTED' };
  }
};

const q = (text, params) => pool.query(text, params);

try {
  // 1. Find the LIE; assign the target LGA only if none is set yet.
  const lie = (await q(`SELECT id, "assignedLga" FROM "User" WHERE role='LIE' ORDER BY "createdAt" LIMIT 1`)).rows[0];
  if (!lie) throw new Error('No LIE user found to attach visits to.');
  if (!lie.assignedLga) {
    await q(`UPDATE "User" SET "assignedLga"=$1, "updatedAt"=now() WHERE id=$2`, [TARGET_LGA, lie.id]);
    console.log(`Assigned LGA "${TARGET_LGA}" to LIE ${lie.id}`);
  }
  const lga = lie.assignedLga || TARGET_LGA;

  // 2. Current session (single isCurrent row).
  await q(`UPDATE "Session" SET "isCurrent"=false WHERE "isCurrent"=true AND name<>$1`, [SESSION_NAME]);
  await q(
    `INSERT INTO "Session" (id, name, "startDate", "endDate", "isCurrent", "updatedAt")
     VALUES (gen_random_uuid(), $1, '2025-09-15', '2026-07-31', true, now())
     ON CONFLICT (name) DO UPDATE SET "isCurrent"=true, "updatedAt"=now()`,
    [SESSION_NAME],
  );
  const session = (await q(`SELECT id FROM "Session" WHERE name=$1`, [SESSION_NAME])).rows[0];

  // 3. Schools + visits.
  let visitsMade = 0;
  for (const s of SCHOOLS) {
    await q(
      `INSERT INTO "School" (id, code, name, type, ownership, category, "genderCategory", "lgaName", "lgaCode", ward, community, latitude, longitude, "isActive", "updatedAt")
       VALUES (gen_random_uuid(), $1,$2,$3::"SchoolType",$4::"SchoolOwnership",$5::"SchoolCategory",$6::"GenderCategory",$7,$8,$9,$10,$11,$12,true, now())
       ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name, "lgaName"=EXCLUDED."lgaName", "updatedAt"=now()`,
      [s.code, s.name, s.type, s.ownership, s.category, s.gender, lga, 'IBN', s.ward, s.community, s.lat, s.lng],
    );
    const school = (await q(`SELECT id FROM "School" WHERE code=$1`, [s.code])).rows[0];

    if (s.status === 'SKIP') continue;
    const sec = sectionsFor(s.status);
    await q(
      `INSERT INTO "SchoolVisit" (id, "schoolId", "sessionId", "inspectorId", "ascStatus","studentsStatus","staffStatus","securityStatus","mediaStatus","overallStatus","updatedAt")
       VALUES (gen_random_uuid(), $1,$2,$3, $4::"CaptureStatus",$5::"CaptureStatus",$6::"CaptureStatus",$7::"CaptureStatus",$8::"CaptureStatus",$9::"CaptureStatus", now())
       ON CONFLICT ("schoolId","sessionId") DO UPDATE SET
         "inspectorId"=EXCLUDED."inspectorId",
         "ascStatus"=EXCLUDED."ascStatus","studentsStatus"=EXCLUDED."studentsStatus",
         "staffStatus"=EXCLUDED."staffStatus","securityStatus"=EXCLUDED."securityStatus",
         "mediaStatus"=EXCLUDED."mediaStatus","overallStatus"=EXCLUDED."overallStatus","updatedAt"=now()`,
      [school.id, session.id, lie.id, sec.asc, sec.students, sec.staff, sec.security, sec.media, s.status],
    );
    visitsMade++;
  }

  console.log(`Seed OK — session "${SESSION_NAME}", ${SCHOOLS.length} schools in "${lga}", ${visitsMade} visits.`);
} catch (e) {
  console.error('SEED FAILED:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
