import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SecurityAssessmentDto } from './dto/security-assessment.dto';

// The fields added for the vulnerability form are only useful if they survive
// validation intact — an option set that doesn't match the dropdown, or a date
// the pipe rejects, means the enumerator's answer is silently dropped.

async function check(payload: Record<string, unknown>) {
  const dto = plainToInstance(SecurityAssessmentDto, payload, {
    enableImplicitConversion: true,
  });
  const errors = await validate(dto, { whitelist: true });
  return {
    dto,
    ok: errors.length === 0,
    fields: errors.map((e) => e.property),
  };
}

describe('SecurityAssessmentDto — vulnerability form additions', () => {
  it('accepts every road condition the dropdown offers', async () => {
    for (const roadCondition of ['Good', 'Fair', 'Poor']) {
      const res = await check({ roadCondition });
      expect(res.ok).toBe(true);
    }
  });

  it('rejects a road condition outside the option set', async () => {
    const res = await check({ roadCondition: 'Excellent' });
    expect(res.ok).toBe(false);
    expect(res.fields).toContain('roadCondition');
  });

  it('accepts every water source the dropdown offers', async () => {
    for (const waterSource of [
      'Piped',
      'Borehole',
      'Well',
      'Rain Water',
      'None',
    ]) {
      const res = await check({ waterSource });
      expect(res.ok).toBe(true);
    }
  });

  it('rejects a water source outside the option set', async () => {
    const res = await check({ waterSource: 'River' });
    expect(res.ok).toBe(false);
    expect(res.fields).toContain('waterSource');
  });

  it('accepts the health facility and security guard toggles', async () => {
    const res = await check({
      hasHealthFacility: true,
      hasSecurityGuard: false,
    });
    expect(res.ok).toBe(true);
    expect(res.dto.hasHealthFacility).toBe(true);
    expect(res.dto.hasSecurityGuard).toBe(false);
  });

  it('accepts the date the picker actually produces (YYYY-MM-DD)', async () => {
    const res = await check({ lastInspectionDate: '2026-03-14' });
    expect(res.ok).toBe(true);
  });

  it('rejects a malformed inspection date', async () => {
    const res = await check({ lastInspectionDate: '14/03/2026' });
    expect(res.ok).toBe(false);
    expect(res.fields).toContain('lastInspectionDate');
  });

  it('bounds the inspection visit count', async () => {
    expect((await check({ inspectionVisitsLastYear: 4 })).ok).toBe(true);
    expect((await check({ inspectionVisitsLastYear: -1 })).ok).toBe(false);
    expect((await check({ inspectionVisitsLastYear: 400 })).ok).toBe(false);
  });

  it('still accepts a full Module D payload alongside the new fields', async () => {
    const res = await check({
      hadSecurityIncident: true,
      incidentCount: 2,
      mostRecentIncidentYear: 2025,
      mostRecentIncidentType: 'Vandalism',
      incidentReportedToAuth: true,
      lastInspectionDate: '2026-01-09',
      inspectionVisitsLastYear: 3,
    });
    expect(res.ok).toBe(true);
  });
});
