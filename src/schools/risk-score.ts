// Risk scoring for the School Security & Vulnerability Profile (Field Capture
// Guide §5 "Computed Fields"). The guide specifies the OUTPUTS (Isolation,
// Infrastructure, Communication, Composite, Risk Tier) but not the formula, so
// this is a documented heuristic: every sub-score is 0–100 where HIGHER means
// MORE vulnerable. Each sub-score averages only the factors that were actually
// answered (nulls are skipped), so partial data still yields a usable number.

export interface SecurityInputs {
  // Module A
  distanceToMajorRoadKm?: number | null;
  roadSurfaceType?: string | null;
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
  // Module C
  hasPhoneNetwork?: boolean | null;
  signalStrength?: string | null;
  hasLandline?: boolean | null;
  hasRadioSet?: boolean | null;
  hasEmergencyProtocol?: boolean | null;
  // Module D
  hadSecurityIncident?: boolean | null;
  incidentCount?: number | null;
  mostRecentIncidentYear?: number | null;
}

export interface RiskScores {
  isolationScore: number;
  infrastructureScore: number;
  communicationScore: number;
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
  return Math.min(100, base + countWeight + recency);
}

export function computeRiskScores(i: SecurityInputs): RiskScores {
  const isolationScore = isolation(i);
  const infrastructureScore = infrastructure(i);
  const communicationScore = communication(i);
  const incident = incidentScore(i);

  // Weighted blend; incident history nudges the composite upward.
  const compositeRiskScore = round1(
    isolationScore * 0.3 +
      infrastructureScore * 0.3 +
      communicationScore * 0.25 +
      incident * 0.15,
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
    compositeRiskScore,
    riskTier,
  };
}
