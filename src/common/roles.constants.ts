// NEURON LIE Portal — RBAC role constants (NEURON-RBAC-001 v1.1).
// A user holds exactly one role; these arrays express which roles may reach a route.
// They mirror the "@Roles() Decorator" column of the Route Guard Reference (spec Section 5).
//
// NOTE: geographic scoping (LGA / zone / cluster) and media ownership are NOT expressed
// here — they are enforced at the service / route-handler layer (RBAC Rules 3 and 4).

export const ALL_ROLES = [
  'LIE',
  'ZONAL_COORD',
  'EMIS_OFFICER',
  'EXEC_VIEW',
  'SYS_ADMIN',
  'INSPECT_OFFICER',
  'HOD_APPROVE',
  'SERVICE_ACCOUNT',
] as const;

export const ADMIN_ROLES = ['SYS_ADMIN'];

// ─── Module 1 — Vulnerability Assessment ────────────────────────────────────
// POST /inspections — LIE/INSPECT are LGA/cluster-scoped at the service layer.
export const CAN_SUBMIT_INSPECTION = [
  'LIE',
  'ZONAL_COORD',
  'INSPECT_OFFICER',
  'SERVICE_ACCOUNT',
  'SYS_ADMIN',
];

// GET /inspections — ZONAL is zone-scoped; EMIS/HOD are directorate/state-wide.
export const CAN_READ_INSPECTIONS = [
  'ZONAL_COORD',
  'EMIS_OFFICER',
  'HOD_APPROVE',
  'SYS_ADMIN',
];

// GET /inspections/:id (owner check applies to LIE/INSPECT at the handler).
export const CAN_VIEW_INSPECTION = [
  'LIE',
  'ZONAL_COORD',
  'EMIS_OFFICER',
  'INSPECT_OFFICER',
  'HOD_APPROVE',
  'SYS_ADMIN',
];

// POST /inspections/media and GET /inspections/:id/media — owner-scoped (Rule 4).
export const CAN_ACCESS_MEDIA = ['LIE', 'SYS_ADMIN'];

// GET /schools — offline registry seed.
export const CAN_READ_SCHOOL_REGISTRY = [
  'LIE',
  'ZONAL_COORD',
  'INSPECT_OFFICER',
  'EMIS_OFFICER',
  'SYS_ADMIN',
];

// ─── Dashboards (aggregated intelligence only — no PII, no media, Rule 5) ─────
export const CAN_VIEW_DASHBOARD = [
  'ZONAL_COORD',
  'EMIS_OFFICER',
  'EXEC_VIEW',
  'HOD_APPROVE',
  'SYS_ADMIN',
];

// Risk overview is aggregated intelligence — visible to leadership (EXEC) as well
// as the supervisors who can verify.
export const CAN_VIEW_RISK = [
  'ZONAL_COORD',
  'EMIS_OFFICER',
  'EXEC_VIEW',
  'HOD_APPROVE',
  'SYS_ADMIN',
];

// ─── Workflow engine (Zoho integration boundary) ────────────────────────────
export const CAN_SUBMIT_WORKFLOW = ['INSPECT_OFFICER', 'SYS_ADMIN'];
export const CAN_ARCHIVE_WORKFLOW = ['SERVICE_ACCOUNT', 'SYS_ADMIN'];

// ─── Module 4 — Staff & HR (hard PII restriction: EMIS_OFFICER and above only) ─
export const CAN_ACCESS_MODULE4 = ['EMIS_OFFICER', 'SYS_ADMIN'];

// ─── Platform — user management (ZDT SYS_ADMIN only, Rule 6) ─────────────────
export const CAN_MANAGE_USERS = ['SYS_ADMIN'];

// ─── Reference data — academic sessions & school registry (SYS_ADMIN) ────────
export const CAN_MANAGE_REFERENCE_DATA = ['SYS_ADMIN'];
