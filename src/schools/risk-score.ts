// Risk scoring for the School Security & Vulnerability Profile (Field Capture
// Guide §5 "Computed Fields"). The guide specifies the OUTPUTS (Isolation,
// Infrastructure, Communication, Composite, Risk Tier) but not the formula, so
// this is a documented heuristic: every sub-score is 0–100 where HIGHER means
// MORE vulnerable. Each sub-score averages only the factors that were actually
// answered (nulls are skipped), so partial data still yields a usable number.

export interface SecurityInputs {
  // Module A0 — School Profile (intrinsic exposure)
  ownership?: string | null;
  schoolCategory?: string | null;
  genderCategory?: string | null;
  // Module A
  distanceToMajorRoadKm?: number | null;
  roadSurfaceType?: string | null;
  roadCondition?: string | null;
  estimatedTravelTimeMins?: number | null;
  forestProximity?: string | null;
  distanceToSecurityPostKm?: number | null;
  // Module B
  perimeterFenceStatus?: string | null;
  numberOfEntryPoints?: number | null;
  hasFunctionalGate?: boolean | null;
  hasCctv?: boolean | null;
  hasElectricity?: boolean | null;
  hasExternalLighting?: boolean | null;
  hasHealthFacility?: boolean | null;
  waterSource?: string | null;
  // Module C
  hasPhoneNetwork?: boolean | null;
  signalStrength?: string | null;
  hasLandline?: boolean | null;
  hasRadioSet?: boolean | null;
  hasEmergencyProtocol?: boolean | null;
  hasSecurityGuard?: boolean | null;
  // Module D
  hadSecurityIncident?: boolean | null;
  incidentCount?: number | null;
  mostRecentIncidentYear?: number | null;
  incidentReportedToAuth?: boolean | null;
  // NOTE: lastInspectionDate and inspectionVisitsLastYear are deliberately NOT
  // scored. They measure how often the ministry visits, not how exposed the
  // school is — a school nobody has inspected is under-monitored, not in more
  // danger. Folding them in would let an administrative backlog inflate a
  // school's risk tier and push protective resources to the wrong places. They
  // stay captured as oversight data and are reported separately.
}

export interface RiskScores {
  isolationScore: number;
  infrastructureScore: number;
  communicationScore: number;
  exposureScore: number;
  compositeRiskScore: number;
  riskTier: 'High' | 'Moderate' | 'Low';
}

const round1 = (n: number) => Math.round(n * 10) / 10;

// Average the factors that have a value; ignore undefined/null.
const avg = (factors: Array<number | null | undefined>): number => {
  const present = factors.filter((f): f is number => typeof f === 'number');
  if (present.length === 0) return 0;
  return present.reduce((a, b) => a + b, 0) / present.length;
};

const band = (
  value: number | null | undefined,
  thresholds: Array<[number, number]>,
  fallback: number | null,
): number | null => {
  if (typeof value !== 'number') return fallback;
  for (const [limit, score] of thresholds) {
    if (value <= limit) return score;
  }
  return thresholds[thresholds.length - 1][1];
};

const lookup = (
  value: string | null | undefined,
  map: Record<string, number>,
): number | null => {
  if (!value) return null;
  return value in map ? map[value] : null;
};

// false (lacking the protection) is the vulnerable answer → high score.
const toggleRisk = (
  value: boolean | null | undefined,
  riskWhenFalse: number,
): number | null => {
  if (typeof value !== 'boolean') return null;
  return value ? 0 : riskWhenFalse;
};

function isolation(i: SecurityInputs): number {
  return round1(
    avg([
      lookup(i.forestProximity, {
        Adjacent: 100,
        Near: 70,
        Moderate: 40,
        Distant: 10,
      }),
      band(
        i.distanceToMajorRoadKm,
        [
          [0.5, 10],
          [2, 40],
          [5, 70],
        ],
        null,
      ) ?? (typeof i.distanceToMajorRoadKm === 'number' ? 100 : null),
      lookup(i.roadSurfaceType, {
        Tarmac: 10,
        Laterite: 40,
        Gravel: 60,
        'Footpath Only': 90,
        None: 100,
      }),
      // Condition is scored alongside material, not instead of it: a tarred road
      // full of potholes delays a response as surely as an earth one.
      lookup(i.roadCondition, { Good: 10, Fair: 50, Poor: 90 }),
      band(
        i.distanceToSecurityPostKm,
        [
          [2, 10],
          [5, 40],
          [10, 70],
        ],
        null,
      ) ?? (typeof i.distanceToSecurityPostKm === 'number' ? 100 : null),
      band(
        i.estimatedTravelTimeMins,
        [
          [15, 10],
          [30, 35],
          [60, 65],
        ],
        null,
      ) ?? (typeof i.estimatedTravelTimeMins === 'number' ? 100 : null),
    ]),
  );
}

function infrastructure(i: SecurityInputs): number {
  return round1(
    avg([
      lookup(i.perimeterFenceStatus, { None: 100, Partial: 50, Full: 0 }),
      toggleRisk(i.hasFunctionalGate, 100),
      toggleRisk(i.hasCctv, 70),
      toggleRisk(i.hasExternalLighting, 70),
      toggleRisk(i.hasElectricity, 50),
      // No on-site clinic means any injury has to travel the same roads scored
      // in Module A — the two compound.
      toggleRisk(i.hasHealthFacility, 40),
      // Water is a security factor, not a welfare one: where there is no supply
      // on the premises, students and staff leave the compound to fetch it, and
      // that daily walk is the exposure. Seasonal sources score between.
      lookup(i.waterSource, {
        Piped: 10,
        Borehole: 20,
        Well: 60,
        'Rain Water': 60,
        None: 100,
      }),
      typeof i.numberOfEntryPoints === 'number'
        ? Math.min(100, i.numberOfEntryPoints * 20)
        : null,
    ]),
  );
}

function communication(i: SecurityInputs): number {
  return round1(
    avg([
      toggleRisk(i.hasPhoneNetwork, 100),
      lookup(i.signalStrength, { Strong: 0, Weak: 60, None: 100 }),
      toggleRisk(i.hasLandline, 40),
      toggleRisk(i.hasRadioSet, 70),
      toggleRisk(i.hasEmergencyProtocol, 80),
      // The heaviest single factor in this module: a guard is both the on-site
      // deterrent and the first alarm. Every other item here only carries a
      // message once someone has decided to raise one.
      toggleRisk(i.hasSecurityGuard, 90),
    ]),
  );
}

// Module A0 — intrinsic exposure. Unlike the other sub-scores this measures what
// the school *is* rather than what it lacks, so no amount of fencing or phone
// signal changes it. It is the profile most consistently shared by schools
// targeted in Nigerian mass abductions: children resident overnight, girls'
// schools, and public schools with the least on-site protection.
//
// Kept as its own sub-score rather than folded into the composite so an
// inspector can see why a well-equipped school still reads high — an unexplained
// number is one nobody acts on.
function exposure(i: SecurityInputs): number {
  return round1(
    avg([
      // Residency is the dominant factor: a day school empties before dark.
      lookup(i.schoolCategory, {
        BOARDING: 100,
        SEMI_BOARDING: 60,
        DAY: 15,
      }),
      lookup(i.genderCategory, {
        GIRLS_ONLY: 100,
        MIXED: 50,
        BOYS_ONLY: 40,
      }),
      lookup(i.ownership, {
        PUBLIC: 70,
        MISSION: 50,
        PRIVATE: 35,
      }),
    ]),
  );
}

function incidentScore(i: SecurityInputs): number {
  if (!i.hadSecurityIncident) return 0;
  const base = 40;
  const countWeight = Math.min(40, (i.incidentCount ?? 1) * 15);
  const year = i.mostRecentIncidentYear;
  const nowYear = new Date().getFullYear();
  let recency = 0;
  if (typeof year === 'number') {
    if (year >= nowYear - 1) recency = 20;
    else if (year >= nowYear - 3) recency = 10;
  }
  // An unreported incident is a weak link to the authorities who would respond
  // to the next one. Deliberately small — the failure is in the referral chain,
  // not in the school's exposure, and the school head answering honestly here
  // should not be penalised heavily for it.
  const unreported = i.incidentReportedToAuth === false ? 10 : 0;
  return Math.min(100, base + countWeight + recency + unreported);
}

// Composite weights. These sum to 1 and are the policy dial of the whole
// instrument — the tier a school lands in follows directly from them, so they
// belong to MOEST rather than to this file. Documented here so a change is a
// deliberate edit to one visible place.
const WEIGHTS = {
  isolation: 0.25,
  infrastructure: 0.22,
  communication: 0.18,
  exposure: 0.2,
  incident: 0.15,
} as const;

export function computeRiskScores(i: SecurityInputs): RiskScores {
  const isolationScore = isolation(i);
  const infrastructureScore = infrastructure(i);
  const communicationScore = communication(i);
  const exposureScore = exposure(i);
  const incident = incidentScore(i);

  const compositeRiskScore = round1(
    isolationScore * WEIGHTS.isolation +
      infrastructureScore * WEIGHTS.infrastructure +
      communicationScore * WEIGHTS.communication +
      exposureScore * WEIGHTS.exposure +
      incident * WEIGHTS.incident,
  );

  const riskTier =
    compositeRiskScore >= 66
      ? 'High'
      : compositeRiskScore >= 33
        ? 'Moderate'
        : 'Low';

  return {
    isolationScore,
    infrastructureScore,
    communicationScore,
    exposureScore,
    compositeRiskScore,
    riskTier,
  };
}
