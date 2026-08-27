// Per-LGA pilot passwords: generation, persistence and rotation.
//
// One password per local government, shared by the principals inside it. A
// leaked sheet then costs one LGA (5-20 schools) instead of all 378, and
// rotating it disturbs only that LGA. It buys containment, not attribution —
// principals in the same LGA can still sign in as one another. See the pilot
// notes in seed-principals.js.
//
// Two rules shape the generator:
//
//   * Passwords are random, never derived from the LGA name. A scheme like
//     "IbadanNorth2026" would mean one leaked password hands over the other
//     32, which is exactly the blast radius the split exists to remove.
//   * They are persisted, never regenerated. Every password is printed on a
//     sheet that has already gone out, so a re-run that reshuffled them would
//     silently lock out whole local governments. Existing entries are read
//     back and reused; only an explicit --rotate replaces one.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STORE = path.join(__dirname, 'lga-passwords.json');

// Short, concrete, unmistakable when read aloud down a phone line, and with no
// overlap against Oyo place names — a principal must never be able to guess a
// neighbouring LGA's password by pattern-matching it to their own.
const WORDS = [
  'Anchor', 'Amber', 'Arrow', 'Basket', 'Beacon', 'Bridge', 'Bronze', 'Cactus',
  'Camera', 'Candle', 'Canvas', 'Cedar', 'Chorus', 'Cobalt', 'Compass', 'Copper',
  'Coral', 'Cotton', 'Crayon', 'Crystal', 'Dolphin', 'Ember', 'Falcon', 'Fabric',
  'Feather', 'Forest', 'Garden', 'Granite', 'Harbour', 'Harvest', 'Hazel', 'Indigo',
  'Ivory', 'Jasmine', 'Kettle', 'Lantern', 'Ledger', 'Lemon', 'Lily', 'Linen',
  'Magnet', 'Mango', 'Maple', 'Marble', 'Meadow', 'Mint', 'Mirror', 'Nectar',
  'Olive', 'Orbit', 'Orchid', 'Otter', 'Palm', 'Pebble', 'Pepper', 'Pillar',
  'Pocket', 'Prism', 'Quartz', 'Ribbon', 'River', 'Rocket', 'Saffron', 'Sapphire',
  'Signal', 'Silver', 'Sparrow', 'Spruce', 'Sunset', 'Teak', 'Thunder', 'Timber',
  'Topaz', 'Tulip', 'Velvet', 'Violet', 'Walnut', 'Willow', 'Window', 'Yarn',
];

// TwoWords + three digits: ~5.8M combinations, and typed on a phone in the
// field it costs one keyboard switch, same as the flat password it replaces.
// Rate limiting is what stands between this and a guessing attack; the length
// is chosen for the thumb, not the attacker.
function generate() {
  const a = crypto.randomInt(WORDS.length);
  let b = crypto.randomInt(WORDS.length);
  while (b === a) b = crypto.randomInt(WORDS.length);
  return `${WORDS[a]}${WORDS[b]}${crypto.randomInt(100, 1000)}`;
}

function load(file = STORE) {
  if (!fs.existsSync(file)) return {};
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  return raw.passwords ?? raw;
}

function save(map, file = STORE) {
  const body = {
    note:
      'Plaintext pilot passwords, one per LGA. Not for version control. ' +
      'Regenerating an entry invalidates every credentials sheet already issued ' +
      'for that LGA — rotate deliberately, with scripts/seed-principals.js --rotate.',
    updatedAt: new Date().toISOString(),
    passwords: Object.fromEntries(Object.keys(map).sort().map((k) => [k, map[k]])),
  };
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, 'utf-8');
}

// Fills in any LGA that has no password yet and replaces the ones named in
// `rotate`. Everything else is left exactly as it was found.
function reconcile(map, lgaNames, rotate = []) {
  const next = { ...map };
  const added = [];
  const rotated = [];
  const unknown = rotate.filter((n) => !lgaNames.includes(n));

  const taken = new Set(Object.values(next));
  const fresh = () => {
    // A collision would quietly merge two local governments into one blast
    // radius, which is the one thing this file exists to prevent.
    let p = generate();
    while (taken.has(p)) p = generate();
    taken.add(p);
    return p;
  };

  for (const name of lgaNames) {
    if (rotate.includes(name)) {
      taken.delete(next[name]);
      next[name] = fresh();
      rotated.push(name);
    } else if (!next[name]) {
      next[name] = fresh();
      added.push(name);
    }
  }

  return { map: next, added, rotated, unknown };
}

module.exports = { STORE, generate, load, save, reconcile };
