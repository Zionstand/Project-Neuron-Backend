/**
 * Convert the Ministry's school register (.xlsx) into the CSV the admin
 * "Import CSV" dialog accepts.
 *
 *   node scripts/convert-school-list.js "path/to/Sch list.xlsx" [out.csv]
 *
 * The conversion is not a straight column rename. Three things in the source
 * would otherwise import "successfully" while producing unusable records:
 *
 *  1. LGA names arrive upper-cased and inconsistently punctuated
 *     ("IBADAN NORTH EAST", "ONA-ARA"). The importer resolves an LGA by exact
 *     name, so an unnormalised value silently yields lgaId = NULL — a school
 *     no zone- or cluster-scoped inspector can see. Every name is mapped onto
 *     the canonical reference-table spelling, and an unrecognised one is a hard
 *     error rather than a null.
 *  2. "ORELOUPE" is a misspelling of Orelope.
 *  3. The register's "Category" column is the school LEVEL (Pre-Primary /
 *     Junior / Senior Secondary), not the DAY/BOARDING category the schema
 *     means by that word. It maps to `type`; `category` is defaulted.
 *
 * No third-party dependency: the reader below handles the subset of the xlsx
 * format this file uses (shared strings, one sheet, no formulas).
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ─── Minimal .xlsx reader ────────────────────────────────────────────────────

function readZipEntries(buf) {
  const entries = {};
  // Walk the central directory backwards from the End Of Central Directory record.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a zip file (no EOCD record).');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);

  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);

    const lnameLen = buf.readUInt16LE(localOff + 26);
    const lextraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lnameLen + lextraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    entries[name] = method === 0 ? raw : zlib.inflateRawSync(raw);

    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

const unescapeXml = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&amp;/g, '&');

function sharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  for (const si of xml.toString('utf8').split('<si>').slice(1)) {
    const chunk = si.split('</si>')[0];
    let text = '';
    for (const m of chunk.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) text += m[1];
    out.push(unescapeXml(text));
  }
  return out;
}

function colIndex(ref) {
  const letters = ref.match(/^([A-Z]+)/)[1];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function readSheet(xml, shared) {
  const rows = [];
  for (const rowXml of xml.toString('utf8').split('<row ').slice(1)) {
    const chunk = rowXml.split('</row>')[0];
    const cells = {};
    for (const m of chunk.matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = m[1];
      const body = m[2] || '';
      const ref = (attrs.match(/r="([A-Z]+\d+)"/) || [])[1];
      if (!ref) continue;
      const type = (attrs.match(/t="([^"]+)"/) || [])[1];
      let value = '';
      const v = body.match(/<v>([\s\S]*?)<\/v>/);
      if (type === 's' && v) value = shared[+v[1]] ?? '';
      else if (type === 'inlineStr') {
        for (const t of body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) value += t[1];
        value = unescapeXml(value);
      } else if (v) value = unescapeXml(v[1]);
      cells[colIndex(ref)] = value.trim();
    }
    const keys = Object.keys(cells).map(Number);
    if (!keys.length) continue;
    const width = Math.max(...keys) + 1;
    rows.push(Array.from({ length: width }, (_, i) => cells[i] ?? ''));
  }
  return rows;
}

// ─── Mapping ─────────────────────────────────────────────────────────────────

// Register spelling → canonical Lga.name in the reference table. Built by
// comparing the register against the live table, so every entry is verified.
// "ORELOUPE" is the register's misspelling of Orelope.
const LGA_CANONICAL = {
  AFIJIO: 'Afijio',
  AKINYELE: 'Akinyele',
  ATIBA: 'Atiba',
  ATISBO: 'Atisbo',
  EGBEDA: 'Egbeda',
  'IBADAN NORTH': 'Ibadan North',
  'IBADAN NORTH EAST': 'Ibadan North-East',
  'IBADAN NORTH WEST': 'Ibadan North-West',
  'IBADAN SOUTH EAST': 'Ibadan South-East',
  'IBADAN SOUTH WEST': 'Ibadan South-West',
  'IBARAPA CENTRAL': 'Ibarapa Central',
  'IBARAPA EAST': 'Ibarapa East',
  'IBARAPA NORTH': 'Ibarapa North',
  IDO: 'Ido',
  IREPO: 'Irepo',
  ISEYIN: 'Iseyin',
  ITESIWAJU: 'Itesiwaju',
  IWAJOWA: 'Iwajowa',
  KAJOLA: 'Kajola',
  LAGELU: 'Lagelu',
  'OGBOMOSO NORTH': 'Ogbomoso North',
  'OGBOMOSO SOUTH': 'Ogbomoso South',
  'OGO OLUWA': 'Ogo Oluwa',
  OLORUNSOGO: 'Olorunsogo',
  OLUYOLE: 'Oluyole',
  'ONA-ARA': 'Ona Ara',
  ORELOUPE: 'Orelope', // register misspelling
  'ORI IRE': 'Ori Ire',
  'OYO EAST': 'Oyo East',
  'OYO WEST': 'Oyo West',
  'SAKI EAST': 'Saki East',
  'SAKI WEST': 'Saki West',
  SURULERE: 'Surulere',
};

// The register's school level → SchoolType.
const TYPE_BY_LEVEL = {
  'Pre-Primary/Primary': 'PRIMARY',
  'Junior Secondary': 'JSS',
  'Senior Secondary': 'SSS',
};

const SETTINGS = new Set(['Rural', 'Urban / Peri-urban']);

// Not present in the register. Ownership is safe (these are Ministry schools);
// boarding status and gender composition are placeholders the field officer
// confirms on site in Module A0, which writes the truth back to the School row.
const DEFAULTS = {
  ownership: 'PUBLIC',
  category: 'DAY',
  genderCategory: 'MIXED',
};

const COLUMNS = [
  'code',
  'name',
  'type',
  'ownership',
  'category',
  'genderCategory',
  'lgaName',
  'lgaCode',
  'zoneName',
  'cluster',
  'ward',
  'community',
  'address',
  'setting',
  'latitude',
  'longitude',
];

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
  const src = process.argv[2];
  if (!src) {
    console.error('Usage: node scripts/convert-school-list.js <xlsx> [out.csv]');
    process.exit(1);
  }
  const out = process.argv[3] || path.join(process.cwd(), 'schools-import.csv');

  const entries = readZipEntries(fs.readFileSync(src));
  const shared = sharedStrings(entries['xl/sharedStrings.xml']);
  const sheetName = Object.keys(entries).find((n) =>
    /^xl\/worksheets\/sheet1\.xml$/.test(n)
  );
  const rows = readSheet(entries[sheetName], shared);

  const header = rows[0].map((h) => h.trim());
  const need = ['Zone', 'LGA', 'NEMIS Code', 'School Name', 'Category', 'Setting'];
  const idx = {};
  for (const col of need) {
    const i = header.indexOf(col);
    if (i < 0) {
      console.error(`Missing expected column "${col}". Found: ${header.join(', ')}`);
      process.exit(1);
    }
    idx[col] = i;
  }

  const errors = [];
  const seen = new Map();
  const output = [];

  rows.slice(1).forEach((r, i) => {
    const line = i + 2; // 1-based, plus the header row
    const get = (c) => (r[idx[c]] || '').trim();

    const code = get('NEMIS Code');
    const name = get('School Name');
    const rawLga = get('LGA');
    const zone = get('Zone');
    const level = get('Category');
    const setting = get('Setting');

    if (!code) return errors.push(`line ${line}: missing NEMIS code`);
    if (!name) return errors.push(`line ${line}: missing school name`);

    const lgaName = LGA_CANONICAL[rawLga.toUpperCase()];
    if (!lgaName) {
      return errors.push(`line ${line}: unrecognised LGA "${rawLga}"`);
    }

    const type = TYPE_BY_LEVEL[level];
    if (!type) {
      return errors.push(`line ${line}: unrecognised category "${level}"`);
    }

    if (setting && !SETTINGS.has(setting)) {
      return errors.push(`line ${line}: unrecognised setting "${setting}"`);
    }

    if (seen.has(code)) {
      return errors.push(
        `line ${line}: duplicate NEMIS code ${code} (first seen line ${seen.get(code)})`
      );
    }
    seen.set(code, line);

    output.push({
      code,
      name,
      type,
      ...DEFAULTS,
      lgaName,
      lgaCode: '',
      zoneName: zone,
      cluster: '',
      ward: '',
      community: '',
      address: '',
      setting,
      latitude: '',
      longitude: '',
    });
  });

  if (errors.length) {
    console.error(`\n${errors.length} row(s) could not be converted:\n`);
    for (const e of errors.slice(0, 40)) console.error('  ' + e);
    if (errors.length > 40) console.error(`  …and ${errors.length - 40} more.`);
    console.error('\nNothing written. Fix the source and re-run.');
    process.exit(1);
  }

  const csv =
    [COLUMNS.join(','), ...output.map((o) => COLUMNS.map((c) => csvCell(o[c])).join(','))].join(
      '\n'
    ) + '\n';
  fs.writeFileSync(out, csv, 'utf8');

  // Summary — what a reviewer needs to see before uploading it.
  const byType = {};
  const byZone = {};
  const bySetting = {};
  for (const o of output) {
    byType[o.type] = (byType[o.type] || 0) + 1;
    byZone[o.zoneName] = (byZone[o.zoneName] || 0) + 1;
    bySetting[o.setting] = (bySetting[o.setting] || 0) + 1;
  }
  console.log(`Wrote ${output.length} rows -> ${out}\n`);
  console.log('By type:   ', byType);
  console.log('By setting:', bySetting);
  console.log('By zone:');
  for (const z of Object.keys(byZone).sort()) {
    console.log(`   ${z.padEnd(18)} ${byZone[z]}`);
  }
  console.log(`\nDefaults applied (not in the source register): ${JSON.stringify(DEFAULTS)}`);
  console.log('Module A0 lets the field officer correct boarding status and gender on site.');
}

main();
