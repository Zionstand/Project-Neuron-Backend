// Capture-scope gate — a temporary switch for phased rollouts and pilot tests.
//
// During the pilot only the Security & Vulnerability section is live; the other
// capture sections stay reachable in the UI but must not accept data, so a
// stray URL, a bookmark, or an offline queue draining a pre-pilot draft can't
// leave half-filled rows in the register tables and pollute the test dataset.
//
// Driven by ENABLED_CAPTURE_SECTIONS (comma-separated). Unset => everything is
// enabled, so a fresh deployment behaves normally and this whole mechanism
// disappears once the env var is removed.

export const CAPTURE_SECTIONS = [
  'security',
  'asc',
  'students',
  'staff',
  'media',
] as const;

export type CaptureSectionKey = (typeof CAPTURE_SECTIONS)[number];

// Roles exempt from the gate, so an administrator can still inspect a locked
// section while the pilot is running.
const SCOPE_EXEMPT_ROLES = ['SYS_ADMIN'];

function parseEnabled(): Set<CaptureSectionKey> {
  const raw = process.env.ENABLED_CAPTURE_SECTIONS?.trim();
  if (!raw) return new Set(CAPTURE_SECTIONS);
  const wanted = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return new Set(
    CAPTURE_SECTIONS.filter((s) => wanted.includes(s)),
  ) as Set<CaptureSectionKey>;
}

// Read once per call rather than caching at import time: the env var is the
// operator's off-switch, and a restart is enough to change it either way.
export function isSectionEnabled(section: CaptureSectionKey): boolean {
  return parseEnabled().has(section);
}

export function isScopeExempt(role: string | undefined): boolean {
  return !!role && SCOPE_EXEMPT_ROLES.includes(role);
}

export const OUT_OF_SCOPE_MESSAGE =
  'This section is out of scope for the current exercise.';

// ─── Shared pilot credentials ───────────────────────────────────────────────
//
// Every principal account in the pilot shares one password, handed out on a
// printed credentials sheet. If one of them changes it, that row of the sheet
// silently becomes wrong and there is no way to tell which — so self-service
// password change is closed for PRINCIPAL while the pilot runs.
//
// Off unless PILOT_LOCK_PRINCIPAL_PASSWORD is truthy, so this disappears the
// moment the variable is removed.
export function isPrincipalPasswordChangeLocked(): boolean {
  const v = process.env.PILOT_LOCK_PRINCIPAL_PASSWORD?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

export const PASSWORD_LOCKED_MESSAGE =
  'Password changes are disabled for school accounts during this exercise. Contact the MoEST administrator if you need help signing in.';
