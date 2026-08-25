// Create the academic session and its capture periods.
//
//   node scripts/seed-session.js
//
// Separate from seed-module1.mjs on purpose: that script also inserts seven
// fictional demo schools and requires an existing LIE user, neither of which
// belongs in the production database. Without a current Session AND a current
// CapturePeriod every capture screen refuses to open ("capture is paused until
// an administrator sets the current session"), so this has to run before the
// register import is of any use.
//
// Re-runnable.

const { Pool, neonConfig } = require('@neondatabase/serverless');
const ws = require('ws');
const { announce } = require('./_target');

neonConfig.webSocketConstructor = ws;

const SESSION = '2025/2026';
const PERIODS = [
  { name: 'Term 1', sequence: 1, isCurrent: true },
  { name: 'Term 2', sequence: 2, isCurrent: false },
  { name: 'Term 3', sequence: 3, isCurrent: false },
];

async function main() {
  const url = announce('Seeding session + capture periods');
  const pool = new Pool({ connectionString: url });
  const q = (t, p) => pool.query(t, p);

  try {
    // Exactly one session may be current.
    await q(`UPDATE "Session" SET "isCurrent" = false WHERE name <> $1`, [
      SESSION,
    ]);
    await q(
      `INSERT INTO "Session" (id, name, "startDate", "endDate", "isCurrent", "updatedAt")
       VALUES (gen_random_uuid(), $1, '2025-09-01', '2026-07-31', true, now())
       ON CONFLICT (name) DO UPDATE SET "isCurrent" = true, "updatedAt" = now()`,
      [SESSION],
    );
    const { rows: s } = await q(`SELECT id FROM "Session" WHERE name = $1`, [
      SESSION,
    ]);
    const sessionId = s[0].id;

    for (const p of PERIODS) {
      await q(
        `INSERT INTO "CapturePeriod" (id, "sessionId", name, sequence, "isCurrent", "updatedAt")
         VALUES (gen_random_uuid(), $1, $2, $3, $4, now())
         ON CONFLICT ("sessionId", name) DO UPDATE
           SET sequence = EXCLUDED.sequence,
               "isCurrent" = EXCLUDED."isCurrent",
               "updatedAt" = now()`,
        [sessionId, p.name, p.sequence, p.isCurrent],
      );
    }

    const { rows } = await q(
      `SELECT name, sequence, "isCurrent" FROM "CapturePeriod"
       WHERE "sessionId" = $1 ORDER BY sequence`,
      [sessionId],
    );
    console.log(`✓ session "${SESSION}"`);
    for (const r of rows) {
      console.log(`  ${r.name} (seq ${r.sequence})${r.isCurrent ? '  ← current' : ''}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error('✗', e.message);
  process.exit(1);
});
