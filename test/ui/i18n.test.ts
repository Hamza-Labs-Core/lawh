import { expect, it } from 'vitest';
import { allTexts, digits, type Key, translate } from '../../src/ui/i18n';

it('has both languages for every text, with the same places to fill', () => {
  for (const [key, [en, ar]] of Object.entries(allTexts)) {
    expect(en.trim().length, key).toBeGreaterThan(0);
    expect(ar.trim().length, key).toBeGreaterThan(0);
    const places = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).filter((p) => p !== 'five').sort();
    expect(places(ar), key).toEqual(places(en));
    // Western digits never appear in Arabic text.
    expect(ar, key).not.toMatch(/\d/);
  }
});

it('fills places, and writes Arabic digits', () => {
  expect(translate('en', 'welcome', { name: 'Sara' })).toBe('Welcome, Sara');
  expect(translate('ar', 'welcome', { name: 'سارة' })).toBe('أهلًا سارة');
  expect(translate('ar', 'codeEnds')).toBe('يعمل لمدة ٥ دقائق.');
  expect([digits('ar', 1234567890), digits('en', 12)]).toEqual(['١٢٣٤٥٦٧٨٩٠', '12']);
  expect(translate('en', 'welcome' satisfies Key, {})).toBe('Welcome, ');
});
