// Seed one PRINCIPAL account per school and write the credentials sheet.
//
//   node scripts/seed-principals.js [--out "path/to/logins.csv"]
//                                   [--rotate "Ibadan North"]... | [--rotate-all]
//                                   [--dry-run]
//
// Pilot model, decided with MoEST:
//   * one account per NEMIS code (so the 18 sites that appear as separate Junior
//     and Senior Secondary records get one login each, matching the register)
//   * one shared password per local government, not one for the whole state
//   * requiresPasswordChange = false — a tester covering twenty schools would
//     otherwise hit the change-password wall twenty times
//
// The passwords live in scripts/lga-passwords.json and are reused on every run.
// A leaked sheet costs one LGA (5-20 schools) rather than all 378, and rotating
// it means --rotate "That LGA" and reissuing ~11 rows instead of the whole
// state. It does not buy attribution: principals inside an LGA can still sign
// in as one another, so a disputed capture record still has no defence. That is
// tolerable only while the scope lock keeps student and staff PII out of reach —
// these accounts have to be replaced before the registers open.
//
// The mailboxes at @oyomoest.ng do not exist. Nothing is delivered to them; the
// address is an identifier, and the credentials sheet is the delivery mechanism.
//
// Accounts carry no personal name. Earlier runs generated one by hashing the
// NEMIS code into a word list, which put a fabricated person — "Hannah Peters"
// — against a real school in a government dataset, on a sheet handed to the
// actual holder of the post. Every account is now the post rather than a
// person: firstName "Principal", no surname, and the sheet's Principal column
// is left blank for the real name to be written in. The phone number stays
// synthetic because the column is NOT NULL and unique, and 0800 cannot reach
// anyone. Capturing the real name on first login is the outstanding fix.
//
// Re-runnable: upserts on email, phone numbers are derived from the school
// code, and passwords are read back from the store — so a second run
// reproduces the same sheet rather than churning it and stranding the copies
// already handed out.

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const { Pool, neonConfig } = require('@neondatabase/serverless');
const ws = require('ws');
const { announce } = require('./_target');
const lgaPasswords = require('./lga-passwords');

neonConfig.webSocketConstructor = ws;

// The post, not a person. firstName carries it because that is the field every
// greeting reads ("Welcome, Principal"); an empty surname concatenates away
// cleanly everywhere both are shown together.
const FIRST_NAME = 'Principal';
const LAST_NAME = '';

// 0800 is a Nigerian toll-free range, never a personal mobile — so a stray call
// or SMS can't reach a real person. Unique because the last seven digits of a
// NEMIS code (LGA + level + serial) are unique within the state.
const phoneFor = (code) => `0800${code.slice(-7)}`;

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function parseArgs(argv) {
  const rotate = [];
  let out = null;
  let rotateAll = false;
  let dryRun = false;

  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--out' && argv[i + 1]) out = argv[++i];
    else if (argv[i] === '--rotate' && argv[i + 1]) rotate.push(argv[++i]);
    else if (argv[i] === '--rotate-all') rotateAll = true;
    else if (argv[i] === '--dry-run') dryRun = true;
  }
  return { out, rotate, rotateAll, dryRun };
}

async function main() {
  const args = parseArgs(process.argv);
  const outPath =
    args.out ?? path.join(__dirname, '..', '..', 'NEURON principal logins (pilot).csv');

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

    const lgaNames = [...new Set(schools.map((s) => s.lgaName))].sort();
    console.log(`  ${schools.length} schools across ${lgaNames.length} LGAs`);

    const rotate = args.rotateAll ? lgaNames : args.rotate;
    const { map, added, rotated, unknown } = lgaPasswords.reconcile(
      lgaPasswords.load(),
      lgaNames,
      rotate,
    );
    // A typo in --rotate would otherwise pass silently and leave the LGA the
    // operator meant to rotate still holding its leaked password.
    if (unknown.length) {
      throw new Error(`--rotate names no such LGA: ${unknown.join(', ')}`);
    }

    if (args.dryRun) {
      console.log('  dry run — no accounts written, no sheet written');
    } else {
      lgaPasswords.save(map);
    }

    // One password per LGA, so one bcrypt per LGA. At cost 10 that is ~3s for
    // 33; hashing per row would spend a minute reaching the same 33 answers.
    const hashes = {};
    for (const name of lgaNames) hashes[name] = await bcrypt.hash(map[name], 10);

    const out = [];
    let created = 0;
    let updated = 0;

    for (const s of schools) {
      const email = `${s.code}@oyomoest.ng`;
      // The NEMIS code alone: unique by definition, and it no longer carries a
      // fabricated name the way `hannah-peters-1310610051` did.
      const username = s.code;
      const phone = phoneFor(s.code);

      if (!args.dryRun) {
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
             -- Carried in the update too, or rows seeded before the rename keep
             -- their old name-derived username forever.
             username = EXCLUDED.username,
             password = EXCLUDED.password,
             role = 'PRINCIPAL',
             "accountStatus" = 'ACTIVE',
             "requiresPasswordChange" = false,
             "assignedSchoolId" = EXCLUDED."assignedSchoolId",
             "updatedAt" = now()
           RETURNING (xmax = 0) AS wasCreated`,
          [FIRST_NAME, LAST_NAME, username, email, phone, hashes[s.lgaName], s.id],
        );
        res.rows[0].wascreated ? created++ : updated++;
      }

      out.push([
        s.zoneName ?? '',
        s.lgaName,
        s.code,
        s.name,
        s.type,
        // Deliberately blank — a column for the real name to be written into,
        // not a guess at it.
        '',
        email,
        map[s.lgaName],
      ]);
    }

    if (!args.dryRun) {
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
    }

    const counts = {};
    for (const s of schools) counts[s.lgaName] = (counts[s.lgaName] ?? 0) + 1;
    const width = Math.max(...lgaNames.map((n) => n.length));

    console.log('\n  LGA passwords');
    for (const name of lgaNames) {
      const tag = rotated.includes(name)
        ? ' (rotated)'
        : added.includes(name)
          ? ' (new)'
          : '';
      console.log(
        `    ${name.padEnd(width)}  ${map[name].padEnd(18)}` +
        `${String(counts[name]).padStart(3)} schools${tag}`,
      );
    }

    if (args.dryRun) {
      console.log('\n  dry run complete — nothing was written');
    } else {
      console.log(`\n✓ ${created} created, ${updated} updated`);
      if (rotated.length) {
        console.log(
          `  rotated ${rotated.length} LGA(s) — reissue those rows of the sheet: ` +
          rotated.join(', '),
        );
      }
      console.log(`  password store:    ${lgaPasswords.STORE}`);
      console.log(`  credentials sheet: ${outPath}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error('✗', e.message);
  process.exit(1);
});
