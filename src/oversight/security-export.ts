// CSV shape for the School Security & Vulnerability export.
//
// Kept separate from the service so the column list reads as a spec: one entry
// per column, in the order an analyst expects them (identity → context → the
// four capture modules in form order → computed scores). Adding a capture field
// to the form means adding one line here, and nothing else.

type Row = Record<string, unknown>;

export interface Column {
  header: string;
  get: (r: Row) => unknown;
}

const plain = (key: string, header: string): Column => ({
  header,
  get: (r) => r[key],
});

// Booleans export as Yes/No rather than true/false: these open in Excel, and a
// column of TRUE/FALSE reads as a formula error to most people opening it.
const yesNo = (key: string, header: string): Column => ({
  header,
  get: (r) => (typeof r[key] === 'boolean' ? (r[key] ? 'Yes' : 'No') : ''),
});

const isoDate = (key: string, header: string): Column => ({
  header,
  get: (r) => {
    const v = r[key];
    if (!v) return '';
    const d = v instanceof Date ? v : new Date(String(v));
    return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
  },
});

const isoDateTime = (key: string, header: string): Column => ({
  header,
  get: (r) => {
    const v = r[key];
    if (!v) return '';
    const d = v instanceof Date ? v : new Date(String(v));
    return Number.isNaN(d.getTime()) ? '' : d.toISOString();
  },
});

export const SECURITY_EXPORT_COLUMNS: Column[] = [
  // ─── Identity ───────────────────────────────────────────────────────────────
  plain('schoolCode', 'School code'),
  plain('schoolName', 'School name'),
  plain('lgaName', 'LGA'),
  plain('lgaCode', 'LGA code'),
  plain('zoneName', 'Zone'),
  plain('ward', 'Ward'),
  plain('community', 'Community'),
  plain('schoolType', 'School type'),
  plain('latitude', 'Latitude'),
  plain('longitude', 'Longitude'),
  plain('gpsAccuracyMetres', 'GPS accuracy (m)'),

  // ─── Capture context ────────────────────────────────────────────────────────
  plain('sessionName', 'Session'),
  plain('periodName', 'Capture period'),
  // Inspector and principal records are both exported; without this column the
  // two sources are indistinguishable and a school appears duplicated.
  plain('source', 'Source'),
  plain('recordStatus', 'Status'),
  isoDateTime('submittedAt', 'Submitted at'),
  plain('collectedByName', 'Collected by'),
  plain('collectedByEmail', 'Collected by email'),

  // ─── Module A0 — School profile ─────────────────────────────────────────────
  plain('ownership', 'Ownership'),
  plain('schoolCategory', 'Boarding status'),
  plain('genderCategory', 'Students served'),

  // ─── Module A — Location & access ───────────────────────────────────────────
  plain('distanceToMajorRoadKm', 'Distance to major road (km)'),
  plain('roadSurfaceType', 'Road surface'),
  plain('roadCondition', 'Road condition'),
  plain('estimatedTravelTimeMins', 'Travel time to LGA HQ (mins)'),
  plain('nearestTown', 'Nearest town'),
  plain('forestProximity', 'Forest proximity'),
  plain('forestDistanceEstimateKm', 'Forest distance (km)'),

  // ─── Module B — Physical infrastructure & perimeter ─────────────────────────
  plain('perimeterFenceStatus', 'Perimeter fence'),
  plain('fenceType', 'Fence type'),
  plain('numberOfEntryPoints', 'Entry points'),
  yesNo('hasFunctionalGate', 'Functional gate'),
  yesNo('hasCctv', 'CCTV'),
  yesNo('hasElectricity', 'Electricity'),
  yesNo('hasSolar', 'Solar'),
  yesNo('hasExternalLighting', 'External lighting'),
  yesNo('hasHealthFacility', 'Health facility'),
  plain('waterSource', 'Water source'),

  // ─── Module C — Communication & emergency capacity ──────────────────────────
  yesNo('hasPhoneNetwork', 'Phone network'),
  plain('networkProvider', 'Network provider'),
  plain('signalStrength', 'Signal strength'),
  yesNo('hasLandline', 'Landline'),
  yesNo('hasRadioSet', 'Radio set'),
  yesNo('hasEmergencyProtocol', 'Emergency protocol'),
  plain('distanceToSecurityPostKm', 'Distance to security post (km)'),
  plain('nearestSecurityPostName', 'Nearest security post'),
  yesNo('hasSecurityGuard', 'Security guard'),

  // ─── Module D — Incident history ────────────────────────────────────────────
  yesNo('hadSecurityIncident', 'Incident in past 5 years'),
  plain('incidentCount', 'Incident count'),
  plain('mostRecentIncidentYear', 'Most recent incident year'),
  plain('mostRecentIncidentType', 'Most recent incident type'),
  yesNo('incidentReportedToAuth', 'Reported to authorities'),
  isoDate('lastInspectionDate', 'Last inspection date'),
  plain('inspectionVisitsLastYear', 'Inspection visits last year'),

  // ─── Computed ───────────────────────────────────────────────────────────────
  plain('isolationScore', 'Isolation score'),
  plain('infrastructureScore', 'Infrastructure score'),
  plain('communicationScore', 'Communication score'),
  plain('exposureScore', 'Exposure score'),
  plain('compositeRiskScore', 'Composite risk score'),
  plain('riskTier', 'Risk tier'),
];

// RFC 4180 quoting. Also guards against CSV injection: Excel and Sheets execute
// a cell beginning =, +, - or @, and school names and free-text fields here are
// operator-entered, so a leading formula character is prefixed with a quote.
function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(rows: Row[], columns = SECURITY_EXPORT_COLUMNS): string {
  const lines = [columns.map((c) => escapeCell(c.header)).join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => escapeCell(c.get(row))).join(','));
  }
  // CRLF and a UTF-8 BOM: without the BOM Excel on Windows renders names with
  // Yoruba diacritics as mojibake, which is most of the school list.
  return `﻿${lines.join('\r\n')}\r\n`;
}
