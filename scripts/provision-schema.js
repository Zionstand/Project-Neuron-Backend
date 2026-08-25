// Create the full NEURON schema in an empty database.
//
//   node scripts/provision-schema.js [--force]
//
// `prisma migrate` / `db push` can't reach Neon from this machine (P1001), but
// `prisma migrate diff --from-empty --to-schema` renders the entire schema to
// SQL with no connection at all. That output is applied here over the serverless
// driver, which does connect.
//
// Refuses to run against a database that already has tables unless --force, so a
// mistyped target can't drop work on the floor.

const { execFileSync } = require('child_process');
const path = require('path');
const { Pool, neonConfig } = require('@neondatabase/serverless');
const ws = require('ws');
const { announce } = require('./_target');

neonConfig.webSocketConstructor = ws;

// Relative on purpose: the repo path contains a space ("Project Neuron"), and
// the shell needed for npx.cmd would split an absolute path on it.
const SCHEMA = 'prisma/schema.prisma';

function renderDdl() {
  // npx on Windows is a .cmd, so it needs a shell.
  const out = execFileSync(
    'npx',
    [
      'prisma',
      'migrate',
      'diff',
      '--from-empty',
      '--to-schema',
      SCHEMA,
      '--script',
    ],
    { encoding: 'utf-8', shell: true, cwd: path.join(__dirname, '..') },
  );
  if (!/CREATE TABLE/i.test(out)) {
    throw new Error('prisma produced no DDL — schema path wrong?');
  }
  return out;
}

async function main() {
  const force = process.argv.includes('--force');
  const url = announce('Provisioning schema');

  const ddl = renderDdl();
  const tables = (ddl.match(/CREATE TABLE/gi) || []).length;
  console.log(`  rendered: ${tables} tables, ${ddl.split('\n').length} lines`);

  const pool = new Pool({ connectionString: url });
  try {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    if (rows[0].n > 0 && !force) {
      throw new Error(
        `target already has ${rows[0].n} tables — refusing. Re-run with --force only if you mean to add to it.`,
      );
    }

    // One transaction: a half-applied schema is worse than none, and this is
    // pure DDL, which Postgres is happy to roll back.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(ddl);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    const after = await pool.query(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    console.log(`✓ schema applied — ${after.rows[0].n} tables now present`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error('✗', e.message);
  process.exit(1);
});
