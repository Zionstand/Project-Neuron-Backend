// Seed one PRINCIPAL account per school and write the credentials sheet.
//
//   node scripts/seed-principals.js [--out "path/to/logins.csv"]
//
// Pilot model, decided with MoEST:
//   * one account per NEMIS code (so the 18 sites that appear as separate Junior
//     and Senior Secondary records get one login each, matching the register)
//   * a single shared password for every account
//   * requiresPasswordChange = false — a tester covering twenty schools would
//     otherwise hit the change-password wall twenty times
//
// The mailboxes at @oyomoest.ng do not exist. Nothing is delivered to them; the
// address is an identifier, and the credentials sheet is the delivery mechanism.
// Names and phone numbers are synthetic placeholders for the same reason.
//
// Re-runnable: upserts on email, and every generated value is derived from the
// school code, so a second run reproduces the same sheet rather than churning it.

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const { Pool, neonConfig } = require('@neondatabase/serverless');
const ws = require('ws');
const { announce } = require('./_target');

neonConfig.webSocketConstructor = ws;

// Optimised for being typed dozens of times on a phone, in the field: no
// ambiguous glyphs, one keyboard switch, and it names itself as disposable.
// Its strength is not the control here — it is printed in the sheet below and
// shared across every account. See the pilot notes.
const PASSWORD = 'NeuronPilot2026';

const FIRST = [
  'John', 'Mary', 'David', 'Grace', 'Peter', 'Sarah', 'Daniel', 'Ruth',
  'Samuel', 'Esther', 'Joseph', 'Rachel', 'Michael', 'Hannah', 'Paul',
  'Deborah', 'Andrew', 'Naomi', 'Stephen', 'Rebecca', 'Thomas', 'Lydia',
  'Emmanuel', 'Joyce', 'Philip', 'Comfort', 'Isaac', 'Patience', 'Benjamin',
  'Rose', 'Timothy', 'Margaret', 'Charles', 'Alice', 'Francis', 'Janet',
];

const LAST = [
  'Adams', 'Bello', 'Clark', 'Daniels', 'Edwards', 'Frank', 'George',
  'Harrison', 'Ibrahim', 'James', 'King', 'Lawson', 'Martins', 'Nelson',
  'Okonkwo', 'Peters', 'Quinn', 'Roberts', 'Simon', 'Thomas', 'Usman',
  'Vincent', 'Williams', 'Young', 'Abraham', 'Bright', 'Cole', 'Dixon',
  'Ellis', 'Fletcher', 'Gordon', 'Hughes', 'Isaacs', 'Jacobs', 'Knight',
  'Lawrence',
];

// Deterministic, so re-running never reshuffles who is who.
function hashCode(s, seed, mult) {
  let h = seed;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, mult) + s.charCodeAt(i)) >>> 0;
  return h;
}

function personFor(code) {
  // Two independent hashes rather than one sliced in half. Codes inside an LGA
  // differ only in their last digits, so a derived second index moves in step
  // with the first and every school in a local government ends up sharing a
  // surname — which reads as obviously generated.
  return {
    firstName: FIRST[hashCode(code, 0x811c9dc5, 31) % FIRST.length],
    lastName: LAST[hashCode([...code].reverse().join(''), 0x1000193, 131) % LAST.length],
  };
}

const slug = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// 0800 is a Nigerian toll-free range, never a personal mobile — so a stray call
// or SMS can't reach a real person. Unique because the last seven digits of a
// NEMIS code (LGA + level + serial) are unique within the state.
const phoneFor = (code) => `0800${code.slice(-7)}`;

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main() {
  const outFlag = process.argv.indexOf('--out');
  const outPath =
    outFlag !== -1 && process.argv[outFlag + 1]
      ? process.argv[outFlag + 1]
      : path.join(__dirname, '..', '..', 'NEURON principal logins (pilot).csv');

  const url = announce('Seeding principal accounts');
  const pool = new Pool({ connectionString: url });

  try {
    const { rows: schools } = await pool.query(
      `SELECT id, code, name, "lgaName", "zoneName", type
         FROM "School"
        WHERE "isActive" = true
        ORDER BY "zoneName", "lgaName", name`,
    );
    if (!schools.length) throw new Error('No schools found — import them first.');
    console.log(`  ${schools.length} schools`);

    // Every account shares one password, so hash once. bcrypt at cost 10 is
    // ~100ms; doing it per row would add a pointless minute for an identical result.
    const hash = await bcrypt.hash(PASSWORD, 10);

    const out = [];
    let created = 0;
    let updated = 0;

    for (const s of schools) {
      const { firstName, lastName } = personFor(s.code);
      const email = `${s.code}@oyomoest.ng`;
      const username = `${slug(`${firstName}-${lastName}`)}-${s.code}`;
      const phone = phoneFor(s.code);

      const res = await pool.query(
        `INSERT INTO "User"
           (id, "firstName", "lastName", username, email, "phoneNumber", password,
            role, "accountStatus", "requiresPasswordChange", "assignedSchoolId",
            "updatedAt")
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6,
                 'PRINCIPAL', 'ACTIVE', false, $7, now())
         ON CONFLICT (email) DO UPDATE SET
           "firstName" = EXCLUDED."firstName",
           "lastName" = EXCLUDED."lastName",
           password = EXCLUDED.password,
           role = 'PRINCIPAL',
           "accountStatus" = 'ACTIVE',
           "requiresPasswordChange" = false,
           "assignedSchoolId" = EXCLUDED."assignedSchoolId",
           "updatedAt" = now()
         RETURNING (xmax = 0) AS wasCreated`,
        [firstName, lastName, username, email, phone, hash, s.id],
      );
      res.rows[0].wascreated ? created++ : updated++;

      out.push([
        s.zoneName ?? '',
        s.lgaName,
        s.code,
        s.name,
        s.type,
        `${firstName} ${lastName}`,
        email,
        PASSWORD,
      ]);
    }

    const header = [
      'Zone', 'LGA', 'School Code', 'School Name', 'Level',
      'Principal', 'Login Email', 'Password',
    ];
    // BOM + CRLF so Excel opens it cleanly on Windows.
    const csv =
      '﻿' +
      [header, ...out].map((r) => r.map(csvCell).join(',')).join('\r\n') +
      '\r\n';
    fs.writeFileSync(outPath, csv, 'utf-8');

    console.log(`✓ ${created} created, ${updated} updated`);
    console.log(`  password (all accounts): ${PASSWORD}`);
    console.log(`  credentials sheet: ${outPath}`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error('✗', e.message);
  process.exit(1);
});
