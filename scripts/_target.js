// Shared target-database resolution for the provisioning scripts.
//
// Everything that writes to the new production database goes through here, so
// there is exactly one place that decides which database is being touched and
// it always says so out loud before writing. Defaulting to DATABASE_URL would
// make a forgotten flag silently rewrite the live database — so it doesn't.

require('dotenv').config();

function targetUrl() {
  const url = process.env.TARGET_DATABASE_URL || process.env.PROD_DATABASE_URL;
  if (!url) {
    throw new Error(
      'No target database. Set TARGET_DATABASE_URL or PROD_DATABASE_URL.',
    );
  }
  return url;
}

// Host only — never print the credential.
function describe(url) {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return '(unparseable url)';
  }
}

function announce(what) {
  const url = targetUrl();
  console.log(`${what}\n  target: ${describe(url)}`);
  if (url === process.env.DATABASE_URL) {
    console.log('  note: target is the SAME database the app is using.');
  }
  return url;
}

module.exports = { targetUrl, describe, announce };
