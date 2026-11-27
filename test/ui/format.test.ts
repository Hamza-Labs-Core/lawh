import { expect, it } from 'vitest';
import { formatCodeInput, slugifyProject } from '../../src/ui/api';

it('formats 8-letter approval codes: trims, uppercases, strips non-letters, auto-inserts dash after 4 letters, and allows backspace', () => {
  expect(formatCodeInput('  b', '')).toBe('B');
  expect(formatCodeInput('BcD', 'BC')).toBe('BCD');
  expect(formatCodeInput('BCDf', 'BCD')).toBe('BCDF-');
  expect(formatCodeInput('BCDF--', 'BCDF-')).toBe('BCDF-');
  expect(formatCodeInput('BCDF-g', 'BCDF-')).toBe('BCDF-G');
  expect(formatCodeInput('  bcdf ghjk  ', '')).toBe('BCDF-GHJK');
  expect(formatCodeInput('bcdfghjkxyz', '')).toBe('BCDF-GHJK');
  expect(formatCodeInput('12bc34df56gh78jk', '')).toBe('BCDF-GHJK');
  // Backspace on `BCDF-` deletes both the separator and the 4th letter so the separator acts transparent.
  expect(formatCodeInput('BCDF', 'BCDF-')).toBe('BCDF'.slice(0, 3));
  // Backspace on `BCDF-G` removes `G` and leaves 4 letters (`BCDF-`), then next Backspace deletes `F` -> `BCD`.
  expect(formatCodeInput('BCDF-', 'BCDF-G')).toBe('BCDF-');
  expect(formatCodeInput('BCDF', 'BCDF-')).toBe('BCD');
});

it('derives clean project slugs from names', () => {
  expect(slugifyProject('  My Cool App! ')).toBe('my-cool-app');
  expect(slugifyProject('تطبيق الحديقة')).toBe('');
});
