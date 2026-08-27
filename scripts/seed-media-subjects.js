// Seed the media shot list — the specific subjects a field visit must photograph.
//
//   node scripts/seed-media-subjects.js [--prune]
//
// Before this, media capture offered five buckets (Module A-D / General) and a
// free-text caption, so what actually got photographed was left to whoever held
// the phone. The Ministry asked for named shots instead. Each row below is one
// subject, carrying its own shooting instructions and the assessment module it
// evidences, so the module is DERIVED from the subject rather than chosen — one
// decision in the field instead of two.
//
// The six named by the Ministry are marked ★. The rest are drawn from fields
// Modules A-D already score (fence, lighting, power, water, CCTV, road, comms),
// so every subject here backs a scored answer rather than being decorative.
//
// Coverage is guided, never blocking: a school with no fire extinguisher marks
// the subject "not present" (MediaCoverage) instead of being pushed to
// photograph something else and call it one. Absence is the finding.
//
// Re-runnable: upserts on code. Existing rows keep their id, so any SchoolMedia
// already pointing at one keeps its FK. --prune deactivates codes not listed
// here rather than deleting them, so historical rows still resolve.

const { Pool, neonConfig } = require('@neondatabase/serverless');
const ws = require('ws');
const { announce } = require('./_target');

neonConfig.webSocketConstructor = ws;

// sortOrder is explicit and sparse (10, 20, 30...) so a subject can be slotted
// between two others later without renumbering the list.
const SUBJECTS = [
  // ─── General ──────────────────────────────────────────────────────────────
  {
    code: 'signboard',
    name: 'School signboard', // ★
    appliesToModule: 'General',
    sortOrder: 10,
    maxFilesAllowed: 3,
    description:
      'The main signboard showing the school name. Stand square to it and get the whole board in frame with the name legible — this is what confirms the photo set belongs to this school.',
  },
  {
    code: 'main-building',
    name: 'Main school building', // ★
    appliesToModule: 'General',
    sortOrder: 20,
    maxFilesAllowed: 5,
    description:
      'The main classroom block from the front, far enough back to show the whole structure and its roof. Add a second shot of any block in visibly poor condition.',
  },

  // ─── Module A · Location & Access ─────────────────────────────────────────
  {
    code: 'approach-road',
    name: 'Approach road to the school',
    appliesToModule: 'Module A',
    sortOrder: 30,
    maxFilesAllowed: 3,
    description:
      'The road immediately outside the gate, shot along its length in the direction of the nearest main road. Should show the surface — tarred, graded or earth — because that answer is scored.',
  },

  // ─── Module B · Infrastructure & Perimeter ────────────────────────────────
  {
    code: 'entrance-gate',
    name: 'Entrance gate with security post', // ★
    appliesToModule: 'Module B',
    sortOrder: 40,
    maxFilesAllowed: 4,
    description:
      'The main entrance from outside, including the gate and any guard post or shelter beside it. If the gate has a working lock, photograph it closed.',
  },
  {
    code: 'perimeter-fence',
    name: 'Perimeter fence',
    appliesToModule: 'Module B',
    sortOrder: 50,
    maxFilesAllowed: 6,
    description:
      'A run of the boundary showing what it is built from. Photograph every gap, collapsed section or informal opening separately — those are the entry points the assessment counts.',
  },
  {
    code: 'external-lighting',
    name: 'External / security lighting',
    appliesToModule: 'Module B',
    sortOrder: 60,
    maxFilesAllowed: 3,
    description:
      'Security or floodlights covering the compound and gate. Photograph the fittings in daylight; note in the caption whether they were seen working.',
  },
  {
    code: 'power-installation',
    name: 'Power installation (grid or solar)',
    appliesToModule: 'Module B',
    sortOrder: 70,
    maxFilesAllowed: 4,
    description:
      'The grid connection point, meter, solar array or generator. Include a shot of any solar panels from an angle that shows how many there are.',
  },
  {
    code: 'water-source',
    name: 'Water source',
    appliesToModule: 'Module B',
    sortOrder: 80,
    maxFilesAllowed: 3,
    description:
      'The borehole, well, tap stand or tank the school actually draws from. If it is out of service, photograph it anyway and say so in the caption.',
  },
  {
    code: 'cctv-point',
    name: 'CCTV / surveillance point',
    appliesToModule: 'Module B',
    sortOrder: 90,
    maxFilesAllowed: 3,
    description:
      'Any camera, mounting or recording unit. Photograph the camera itself, not the view it covers.',
  },

  // ─── Module C · Communication & Emergency ─────────────────────────────────
  {
    code: 'emergency-exit',
    name: 'Emergency exit', // ★
    appliesToModule: 'Module C',
    sortOrder: 100,
    maxFilesAllowed: 4,
    description:
      'Designated exits or escape routes from the classroom blocks. Show whether the route is clear and the door opens — a blocked or padlocked exit is exactly what this shot is for.',
  },
  {
    code: 'first-aid',
    name: 'First aid room / box', // ★
    appliesToModule: 'Module C',
    sortOrder: 110,
    maxFilesAllowed: 3,
    description:
      'The sick bay or health corner, plus the first aid box with its lid open so the contents are visible.',
  },
  {
    code: 'fire-extinguisher',
    name: 'Fire extinguisher', // ★
    appliesToModule: 'Module C',
    sortOrder: 120,
    maxFilesAllowed: 4,
    description:
      'Each extinguisher where it is mounted. Get close enough to read the service tag or gauge — an expired unit still counts as present, but the date matters.',
  },
  {
    code: 'emergency-comms',
    name: 'Emergency communication equipment',
    appliesToModule: 'Module C',
    sortOrder: 130,
    maxFilesAllowed: 3,
    description:
      'Two-way radio, fixed telephone line, or the mast the school depends on for signal. Photograph the handset or the equipment itself.',
  },

  // ─── Module D · Incident History ──────────────────────────────────────────
  {
    code: 'incident-evidence',
    name: 'Incident evidence',
    appliesToModule: 'Module D',
    sortOrder: 140,
    maxFilesAllowed: 6,
    description:
      'Physical traces of a past incident — damage, forced entry, repairs. Handle sensitively: photograph property and structures, never people, and never anything identifying a pupil.',
  },

  // ─── Escape hatch ─────────────────────────────────────────────────────────
  {
    code: 'other',
    name: 'Other',
    appliesToModule: 'General',
    sortOrder: 999,
    maxFilesAllowed: 10,
    description:
      'Anything security-relevant the list above does not cover. Say plainly in the caption what it is — these are read one by one, so a vague caption makes the photo useless.',
  },
];

async function main() {
  const prune = process.argv.includes('--prune');
  const url = announce('Seeding media shot list');
  const pool = new Pool({ connectionString: url });

  try {
    let created = 0;
    let updated = 0;

    for (const s of SUBJECTS) {
      const res = await pool.query(
        `INSERT INTO "MediaCategory"
           (id, code, name, "appliesToModule", "mediaTypeAllowed",
            "maxFilesAllowed", description, "sortOrder", "isActive", "updatedAt")
         VALUES (gen_random_uuid(), $1, $2, $3, 'both', $4, $5, $6, true, now())
         ON CONFLICT (code) DO UPDATE SET
           name = EXCLUDED.name,
           "appliesToModule" = EXCLUDED."appliesToModule",
           "maxFilesAllowed" = EXCLUDED."maxFilesAllowed",
           description = EXCLUDED.description,
           "sortOrder" = EXCLUDED."sortOrder",
           "isActive" = true,
           "updatedAt" = now()
         RETURNING (xmax = 0) AS wascreated`,
        [
          s.code,
          s.name,
          s.appliesToModule,
          s.maxFilesAllowed,
          s.description,
          s.sortOrder,
        ],
      );
      res.rows[0].wascreated ? created++ : updated++;
    }

    // Deactivate rather than delete: SchoolMedia.mediaCategoryId points here, so
    // dropping the old Module A-D buckets would orphan any row that used them.
    let retired = 0;
    if (prune) {
      const codes = SUBJECTS.map((s) => s.code);
      const res = await pool.query(
        `UPDATE "MediaCategory" SET "isActive" = false, "updatedAt" = now()
          WHERE "isActive" = true AND NOT (code = ANY($1::text[]))
        RETURNING code`,
        [codes],
      );
      retired = res.rowCount;
      if (retired) {
        console.log(`  retired: ${res.rows.map((r) => r.code).join(', ')}`);
      }
    }

    console.log(`✓ ${created} created, ${updated} updated, ${retired} retired`);

    const { rows } = await pool.query(
      `SELECT code, name, "appliesToModule", "sortOrder"
         FROM "MediaCategory" WHERE "isActive" = true ORDER BY "sortOrder"`,
    );
    console.log(`\n  Active shot list (${rows.length})`);
    let module = null;
    for (const r of rows) {
      if (r.appliesToModule !== module) {
        module = r.appliesToModule;
        console.log(`    ${module}`);
      }
      console.log(`      ${r.code.padEnd(20)} ${r.name}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error('✗', e.message);
  process.exit(1);
});
