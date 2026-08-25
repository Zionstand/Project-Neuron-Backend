// Copy the reference/dimension tables from the current database into the new one.
//
//   node scripts/copy-reference.js
//
// Preferred over re-running seed-reference.mjs: that script's zone list predates
// the Ministry's actual zones (it has one "Ibadan Zone" where the register has
// Ibadan Zone 1/2/3), so seeding from it would produce zone names the school
// register can't match. The live database already holds the corrected values —
// 10 zones and 33 LGAs that reconcile exactly with the register — so those are
// the source of truth here.
//
// Rows keep their original UUIDs, which keeps Lga.zoneId and every fact-table FK
// valid without any remapping.

const { Pool, neonConfig } = require('@neondatabase/serverless');
const ws = require('ws');
const { targetUrl, describe } = require('./_target');

neonConfig.webSocketConstructor = ws;
require('dotenv').config();

// Parents before children — Lga.zoneId points at Zone.
const TABLES = [
  'Zone',
  'Lga',
  'ClassLevel',
  'QualificationType',
  'SubjectArea',
  'MediaCategory',
];

const ident = (s) => `"${String(s).replace(/"/g, '""')}"`;

async function copyTable(src, dst, table) {
  const { rows } = await src.query(`SELECT * FROM ${ident(table)}`);
  if (rows.length === 0) return { table, copied: 0, skipped: true };

  const cols = Object.keys(rows[0]);
  const colList = cols.map(ident).join(', ');

  // Reference tables are small and fully owned by this copy, so replacing them
  // wholesale is simpler and more predictable than row-by-row reconciliation.
  await dst.query(`DELETE FROM ${ident(table)}`);

  for (const row of rows) {
    const params = cols.map((c) => row[c]);
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    await dst.query(
      `INSERT INTO ${ident(table)} (${colList}) VALUES (${placeholders})`,
      params,
    );
  }
  return { table, copied: rows.length };
}

async function main() {
  const from = process.env.DATABASE_URL;
  const to = targetUrl();
  if (!from) throw new Error('DATABASE_URL (source) is not set.');
  if (from === to) throw new Error('Source and target are the same database.');

  console.log(`Copying reference data\n  from: ${describe(from)}\n  to:   ${describe(to)}`);

  const src = new Pool({ connectionString: from });
  const dst = new Pool({ connectionString: to });
  try {
    for (const t of TABLES) {
      const r = await copyTable(src, dst, t);
      console.log(
        `  ${t.padEnd(20)} ${r.skipped ? 'source empty — skipped' : r.copied + ' rows'}`,
      );
    }
    const z = await dst.query(`SELECT name FROM "Zone" ORDER BY name`);
    const l = await dst.query(`SELECT count(*)::int n FROM "Lga"`);
    console.log(`\n✓ ${z.rows.length} zones, ${l.rows[0].n} LGAs`);
    console.log('  zones:', z.rows.map((r) => r.name).join(' | '));
  } finally {
    await src.end();
    await dst.end();
  }
}

main().catch((e) => {
  console.error('✗', e.message);
  process.exit(1);
});
