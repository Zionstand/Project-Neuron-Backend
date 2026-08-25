// Import the converted school register into the target database.
//
//   node scripts/import-schools.js C:/tmp/schools-import.csv
//
// Takes the CSV produced by convert-school-list.js. Direct-to-database rather
// than through the admin Import dialog so the register can be loaded before the
// app is repointed at the new database.
//
// Resolves lgaId / zoneId against the reference tables by name. A row whose LGA
// can't be resolved is a hard error, not a NULL: a school with no lgaId is
// invisible to every zone- and cluster-scoped inspector, which looks like data
// loss long after the import is forgotten.
//
// Re-runnable — upserts on code.

const fs = require('fs');
const { Pool, neonConfig } = require('@neondatabase/serverless');
const ws = require('ws');
const { announce } = require('./_target');

neonConfig.webSocketConstructor = ws;

// RFC 4180 enough for this file: quoted fields, doubled quotes inside them.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v !== ''));
}

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error('Usage: import-schools.js <converted.csv>');
  const url = announce('Importing school register');

  const rows = parseCsv(fs.readFileSync(file, 'utf-8'));
  const header = rows[0].map((h) => h.trim());
  const records = rows.slice(1).map((r) => {
    const o = {};
    header.forEach((h, i) => (o[h] = (r[i] ?? '').trim()));
    return o;
  });
  console.log(`  ${records.length} rows in ${file}`);

  const pool = new Pool({ connectionString: url });
  try {
    const { rows: lgas } = await pool.query(
      `SELECT id, name, code, "zoneId" FROM "Lga"`,
    );
    const { rows: zones } = await pool.query(`SELECT id, name FROM "Zone"`);
    const lgaBy = new Map(lgas.map((l) => [l.name.toLowerCase(), l]));
    const zoneBy = new Map(zones.map((z) => [z.name.toLowerCase(), z]));

    const unresolved = new Set();
    for (const r of records) {
      if (!lgaBy.has(r.lgaName.toLowerCase())) unresolved.add(r.lgaName);
    }
    if (unresolved.size) {
      throw new Error(
        `LGA not found in reference table: ${[...unresolved].join(', ')}`,
      );
    }

    let inserted = 0;
    let updated = 0;
    for (const r of records) {
      const lga = lgaBy.get(r.lgaName.toLowerCase());
      const zone = zoneBy.get((r.zoneName || '').toLowerCase());
      const res = await pool.query(
        `INSERT INTO "School"
           (id, code, name, type, ownership, category, "genderCategory",
            "lgaName", "lgaCode", "lgaId", "zoneName", "zoneId", ward, community,
            address, setting, "isActive", "updatedAt")
         VALUES (gen_random_uuid(), $1, $2, $3::"SchoolType", $4::"SchoolOwnership",
                 $5::"SchoolCategory", $6::"GenderCategory", $7, $8, $9, $10, $11,
                 NULLIF($12,''), NULLIF($13,''), NULLIF($14,''), NULLIF($15,''), true, now())
         ON CONFLICT (code) DO UPDATE SET
           name = EXCLUDED.name, type = EXCLUDED.type,
           "lgaName" = EXCLUDED."lgaName", "lgaCode" = EXCLUDED."lgaCode",
           "lgaId" = EXCLUDED."lgaId", "zoneName" = EXCLUDED."zoneName",
           "zoneId" = EXCLUDED."zoneId", setting = EXCLUDED.setting,
           "updatedAt" = now()
         RETURNING (xmax = 0) AS created`,
        [
          r.code,
          r.name,
          r.type,
          r.ownership,
          r.category,
          r.genderCategory,
          lga.name,
          lga.code ?? null,
          lga.id,
          zone ? zone.name : null,
          zone ? zone.id : null,
          r.ward,
          r.community,
          r.address,
          r.setting,
        ],
      );
      res.rows[0].created ? inserted++ : updated++;
    }

    const { rows: tot } = await pool.query(
      `SELECT count(*)::int n, count("lgaId")::int with_lga, count("zoneId")::int with_zone FROM "School"`,
    );
    console.log(`✓ ${inserted} inserted, ${updated} updated`);
    console.log(
      `  schools: ${tot[0].n} total · ${tot[0].with_lga} linked to an LGA · ${tot[0].with_zone} to a zone`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error('✗', e.message);
  process.exit(1);
});
