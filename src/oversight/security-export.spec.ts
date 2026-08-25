import { toCsv, SECURITY_EXPORT_COLUMNS } from './security-export';

// The export is the pilot's deliverable — it gets opened in Excel by people who
// will not be checking it against the database. Quoting, encoding and formula
// safety are the things that quietly corrupt that file.

const lines = (csv: string) => csv.replace(/^﻿/, '').trim().split('\r\n');

describe('toCsv', () => {
  it('writes a header row even with no data', () => {
    const [header] = lines(toCsv([]));
    expect(header.split(',')[0]).toBe('School code');
    expect(header).toContain('Exposure score');
    expect(header).toContain('Risk tier');
  });

  it('starts with a UTF-8 BOM so Excel reads Yoruba diacritics', () => {
    expect(toCsv([]).charCodeAt(0)).toBe(0xfeff);
    const csv = toCsv([{ schoolName: 'Ìbàdàn Grammar School' }]);
    expect(csv).toContain('Ìbàdàn Grammar School');
  });

  it('quotes commas, quotes and newlines', () => {
    const csv = toCsv([{ schoolName: 'Oyo "Central", Ibadan' }]);
    expect(csv).toContain('"Oyo ""Central"", Ibadan"');

    const multiline = toCsv([{ nearestTown: 'Line one\nLine two' }]);
    expect(multiline).toContain('"Line one\nLine two"');
  });

  it('neutralises cells that Excel would execute as formulas', () => {
    // Free-text fields are operator-entered, so this is reachable input.
    for (const payload of ['=1+1', '+A1', '-2+3', '@SUM(A1)']) {
      const csv = toCsv([{ nearestTown: payload }]);
      expect(csv).toContain(`'${payload}`);
    }
  });

  it('renders booleans as Yes/No and leaves unanswered ones blank', () => {
    const row = lines(
      toCsv([{ hasSecurityGuard: true, hasCctv: false, hasSolar: null }]),
    )[1].split(',');
    const at = (header: string) =>
      row[SECURITY_EXPORT_COLUMNS.findIndex((c) => c.header === header)];

    expect(at('Security guard')).toBe('Yes');
    expect(at('CCTV')).toBe('No');
    // Blank, not "No" — nobody answered, and the two must stay distinguishable.
    expect(at('Solar')).toBe('');
  });

  it('formats dates as plain ISO days', () => {
    const csv = toCsv([{ lastInspectionDate: new Date('2026-03-14T09:00:00Z') }]);
    expect(csv).toContain('2026-03-14');
  });

  it('emits one line per profile', () => {
    const csv = toCsv([{ schoolCode: 'A' }, { schoolCode: 'B' }]);
    expect(lines(csv)).toHaveLength(3); // header + 2
  });
});
