// Adds SchoolSecurityProfile.exposureScore.
//
// `prisma migrate` / `db push` can't reach Neon from this machine (P1001), so
// DDL goes through the serverless driver instead and `prisma generate` is run
// afterwards to refresh the client. Idempotent — safe to re-run.

require('dotenv').config();
const { neon } = require('@neondatabase/serverless');

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set.');
  const sql = neon(url);

  await sql`
    ALTER TABLE "SchoolSecurityProfile"
    ADD COLUMN IF NOT EXISTS "exposureScore" DOUBLE PRECISION
  `;

  const [row] = await sql`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'SchoolSecurityProfile'
      AND column_name = 'exposureScore'
  `;

  if (!row) throw new Error('Column was not created.');
  console.log('OK:', row);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
