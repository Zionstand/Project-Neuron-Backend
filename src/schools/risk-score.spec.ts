import { computeRiskScores, type SecurityInputs } from './risk-score';

// The risk tier is the only output anyone acts on, so the factors that move it
// are pinned here. These tests are less about arithmetic than about intent: a
// field the enumerator answers must be able to change the number, and the two
// oversight fields must not.

// A school that scores near the floor on every module — the baseline the cases
// below perturb one factor at a time.
const SAFE: SecurityInputs = {
  ownership: 'PRIVATE',
  schoolCategory: 'DAY',
  genderCategory: 'BOYS_ONLY',
  distanceToMajorRoadKm: 0.2,
  roadSurfaceType: 'Tarmac',
  roadCondition: 'Good',
  estimatedTravelTimeMins: 10,
  forestProximity: 'Distant',
  distanceToSecurityPostKm: 1,
  perimeterFenceStatus: 'Full',
  numberOfEntryPoints: 1,
  hasFunctionalGate: true,
  hasCctv: true,
  hasElectricity: true,
  hasExternalLighting: true,
  hasHealthFacility: true,
  waterSource: 'Piped',
  hasPhoneNetwork: true,
  signalStrength: 'Strong',
  hasLandline: true,
  hasRadioSet: true,
  hasEmergencyProtocol: true,
  hasSecurityGuard: true,
  hadSecurityIncident: false,
};

const composite = (i: SecurityInputs) => computeRiskScores(i).compositeRiskScore;

describe('computeRiskScores', () => {
  it('rates a well-protected day school Low', () => {
    const r = computeRiskScores(SAFE);
    expect(r.riskTier).toBe('Low');
    expect(r.compositeRiskScore).toBeLessThan(33);
  });

  // Each of these was captured but ignored by the scorer before this change —
  // answering them changed nothing at all.
  describe.each([
    ['roadCondition', { roadCondition: 'Poor' }],
    ['hasSecurityGuard', { hasSecurityGuard: false }],
    ['hasHealthFacility', { hasHealthFacility: false }],
    ['waterSource', { waterSource: 'None' }],
    ['schoolCategory', { schoolCategory: 'BOARDING' }],
    ['genderCategory', { genderCategory: 'GIRLS_ONLY' }],
    ['ownership', { ownership: 'PUBLIC' }],
  ])('%s', (_name, patch) => {
    it('moves the composite when answered unfavourably', () => {
      expect(composite({ ...SAFE, ...patch })).toBeGreaterThan(composite(SAFE));
    });
  });

  it('leaves the composite untouched by inspection cadence', () => {
    // Oversight metrics, not vulnerability: an unvisited school is
    // under-monitored, not in more danger.
    const stale = {
      ...SAFE,
      lastInspectionDate: new Date('2015-01-01'),
      inspectionVisitsLastYear: 0,
    } as SecurityInputs;
    expect(composite(stale)).toBe(composite(SAFE));
  });

  it('raises an incident score when the incident went unreported', () => {
    const reported: SecurityInputs = {
      ...SAFE,
      hadSecurityIncident: true,
      incidentCount: 1,
      mostRecentIncidentYear: new Date().getFullYear(),
      incidentReportedToAuth: true,
    };
    const unreported = { ...reported, incidentReportedToAuth: false };
    expect(composite(unreported)).toBeGreaterThan(composite(reported));
  });

  describe('exposure', () => {
    it('is driven by what the school is, not what it has', () => {
      // Identical protection on both; only the A0 profile differs.
      const boardingGirls = computeRiskScores({
        ...SAFE,
        schoolCategory: 'BOARDING',
        genderCategory: 'GIRLS_ONLY',
        ownership: 'PUBLIC',
      });
      expect(boardingGirls.exposureScore).toBeGreaterThan(
        computeRiskScores(SAFE).exposureScore,
      );
      // The protective factors are unchanged, so those sub-scores must not move.
      expect(boardingGirls.infrastructureScore).toBe(
        computeRiskScores(SAFE).infrastructureScore,
      );
      expect(boardingGirls.communicationScore).toBe(
        computeRiskScores(SAFE).communicationScore,
      );
    });

    it('ignores profile fields that were not captured', () => {
      const { exposureScore } = computeRiskScores({
        ...SAFE,
        ownership: null,
        schoolCategory: null,
        genderCategory: null,
      });
      expect(exposureScore).toBe(0);
    });
  });

  it('rates an isolated boarding girls school with a recent incident High', () => {
    const r = computeRiskScores({
      ownership: 'PUBLIC',
      schoolCategory: 'BOARDING',
      genderCategory: 'GIRLS_ONLY',
      distanceToMajorRoadKm: 12,
      roadSurfaceType: 'Footpath Only',
      roadCondition: 'Poor',
      estimatedTravelTimeMins: 90,
      forestProximity: 'Adjacent',
      distanceToSecurityPostKm: 25,
      perimeterFenceStatus: 'None',
      numberOfEntryPoints: 5,
      hasFunctionalGate: false,
      hasCctv: false,
      hasElectricity: false,
      hasExternalLighting: false,
      hasHealthFacility: false,
      waterSource: 'None',
      hasPhoneNetwork: false,
      signalStrength: 'None',
      hasLandline: false,
      hasRadioSet: false,
      hasEmergencyProtocol: false,
      hasSecurityGuard: false,
      hadSecurityIncident: true,
      incidentCount: 3,
      mostRecentIncidentYear: new Date().getFullYear(),
      incidentReportedToAuth: false,
    });
    expect(r.riskTier).toBe('High');
  });

  it('still scores a partially answered draft', () => {
    // Nulls are skipped rather than treated as zero, so a half-filled form
    // yields a usable number instead of a falsely reassuring one.
    const r = computeRiskScores({
      schoolCategory: 'BOARDING',
      forestProximity: 'Adjacent',
    });
    expect(Number.isFinite(r.compositeRiskScore)).toBe(true);
    expect(r.exposureScore).toBeGreaterThan(0);
  });
});
