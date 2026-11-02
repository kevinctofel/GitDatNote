/**
 * Unit tests for `src/shared/frontMatter.ts` (task 2.6).
 *
 * Verifies exact output formatting (quotes, escapes, field order,
 * determinism), rejection of unsafe control characters, ISO date/date-time
 * validation including leap-year rules, and meaning-preserving round-trips
 * of accepted values through a real YAML parser (js-yaml, available as a
 * transitive dependency — no production dependency was added).
 */
import { describe, expect, it } from 'vitest';
import * as yaml from 'js-yaml';

import { buildFrontMatter } from '../../../src/shared/frontMatter.js';
import type { FrontMatterMeta } from '../../../src/shared/frontMatter.js';

function parseFrontMatter(text: string): Record<string, unknown> {
  const body = text.replace(/^---\n/, '').replace(/\n---\n$/, '');
  const parsed = yaml.load(body);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`front matter did not parse to a mapping: ${body}`);
  }
  return parsed as Record<string, unknown>;
}

/** The generated date is unquoted, so a real parser may decode it as a Date. */
function parsedDateMs(text: string): number {
  const value = parseFrontMatter(text).date;
  if (value instanceof Date) return value.getTime();
  const ms = Date.parse(String(value));
  if (Number.isNaN(ms)) throw new Error(`could not parse date value: ${String(value)}`);
  return ms;
}

/** Ground-truth timestamp as a real parser decodes it (js-yaml uses UTC for zone-less values). */
function expectedDateMs(date: string): number {
  const value = yaml.load(date);
  if (!(value instanceof Date)) throw new Error(`js-yaml did not parse ${date} as a timestamp`);
  return value.getTime();
}

describe('buildFrontMatter — exact output format', () => {
  it('emits the documented shape for title and date only', () => {
    expect(buildFrontMatter({ title: 'Hello', date: '2026-11-02' }))
      .toBe('---\ntitle: "Hello"\ndate: 2026-11-02\n---\n');
  });

  it('orders fields deterministically: title, description, date, tags', () => {
    expect(buildFrontMatter({ title: 'T', date: '2026-01-01', description: 'D', tags: ['a', 'b'] }))
      .toBe('---\ntitle: "T"\ndescription: "D"\ndate: 2026-01-01\ntags: ["a", "b"]\n---\n');
  });

  it.each([
    ['Title: A: B', 'title: "Title: A: B"'],
    ['He said "hi"', 'title: "He said \\"hi\\""'],
    ['a\\b', 'title: "a\\\\b"'],
    ['line1\nline2', 'title: "line1\\nline2"'],
    ['a\tb', 'title: "a\\tb"'],
    ['a\rb', 'title: "a\\rb"'],
    ["What's up", 'title: "What\'s up"'],
  ])('renders %p as %p', (input, expectedLine) => {
    const out = buildFrontMatter({ title: input, date: '2026-01-01' });
    expect(out).toContain(`${expectedLine}\n`);
  });

  it('omits description when undefined or empty', () => {
    for (const meta of [{ title: 'T', date: '2026-01-01' }, { title: 'T', date: '2026-01-01', description: '' }]) {
      expect(buildFrontMatter(meta)).not.toContain('description:');
    }
  });

  it('omits tags when undefined or empty', () => {
    for (const meta of [{ title: 'T', date: '2026-01-01' }, { title: 'T', date: '2026-01-01', tags: [] }]) {
      expect(buildFrontMatter(meta)).not.toContain('tags:');
    }
  });

  it('emits the date exactly as supplied (never normalized)', () => {
    for (const date of ['2026-11-02', '2026-11-02T12:00:00.000Z', '2026-11-02T12:00:00-05:30', '2026-11-02T12:00:00']) {
      expect(buildFrontMatter({ title: 'T', date })).toContain(`\ndate: ${date}\n`);
    }
  });

  it('is deterministic for identical input', () => {
    const out1 = buildFrontMatter({ title: 'Determinism', date: '2026-11-02', description: 'Same input', tags: ['a', 'b'] });
    const out2 = buildFrontMatter({ title: 'Determinism', date: '2026-11-02', description: 'Same input', tags: ['a', 'b'] });
    expect(out1).toBe(out2);
  });
});

describe('buildFrontMatter — round-trips through a real YAML parser', () => {
  const TITLES = [
    'Hello World',
    'Title: with a colon',
    'He said "hi"',
    "What's up",
    'back\\slash',
    'line1\nline2',
    'tab\there',
    'cr\return',
    'Café ünïcode',
    'Emoji 🚀 test',
    ' leading space',
    'trailing space ',
    ':leading colon',
    '#hash tag',
  ];

  it.each(TITLES)('round-trips title %p without changing its meaning', (title) => {
    const out = buildFrontMatter({ title, date: '2026-05-05' });
    expect(parseFrontMatter(out).title).toBe(title);
    expect(parsedDateMs(out)).toBe(expectedDateMs('2026-05-05'));
  });

  const DESCRIPTIONS = [
    'Plain description',
    'A: colon and "quotes" and \\backslash',
    'line1\nline2',
    'Café description 🚀',
    ' leading space',
  ];

  it.each(DESCRIPTIONS)('round-trips description %p', (description) => {
    const out = buildFrontMatter({ title: 'T', date: '2026-05-05', description });
    expect(parseFrontMatter(out).description).toBe(description);
  });

  const TAG_SETS: [string, string[]][] = [
    ['single', ['single']],
    ['multiple', ['alpha', 'beta gamma', 'delta: epsilon']],
    ['punctuated', ["a'b", 'c"d', 'e\\f']],
  ];

  it.each(TAG_SETS)('round-trips tags %p', (_label, tags) => {
    const out = buildFrontMatter({ title: 'T', date: '2026-05-05', tags });
    expect(parseFrontMatter(out).tags).toEqual(tags);
  });
});

describe('buildFrontMatter — control character rejection', () => {
  const CASES: [string, FrontMatterMeta][] = [
    ['title (NUL)', { title: '\u0000title', date: '2026-01-01' }],
    ['title (SOH)', { title: 'bad\u0001title', date: '2026-01-01' }],
    ['title (ESC)', { title: 'title\u001b', date: '2026-01-01' }],
    ['title (DEL)', { title: 'del\u007fchar', date: '2026-01-01' }],
    ['description (STX)', { title: 'T', date: '2026-01-01', description: 'bad\u0002desc' }],
    ['tags (ETX)', { title: 'T', date: '2026-01-01', tags: ['ok', 'bad\u0003tag'] }],
  ];

  it.each(CASES)('rejects unsafe control character in %s', (_label, meta) => {
    expect(() => buildFrontMatter(meta)).toThrow(/unsafe control character/);
  });

  it('accepts tabs, newlines, and carriage returns (they are escaped, not rejected)', () => {
    const title = 'a\nb\tc\rd';
    const out = buildFrontMatter({ title, date: '2026-01-01' });
    expect(parseFrontMatter(out).title).toBe(title);
  });
});

describe('buildFrontMatter — date validation', () => {
  const VALID_DATES = [
    '2026-11-02',
    '2026-02-28',
    '2024-02-29',
    '2000-02-29',
    '2026-11-02T00:00:00Z',
    '2026-11-02T23:59:59Z',
    '2026-11-02T12:00:00.123Z',
    '2026-11-02T12:00:00',
    '2026-11-02T12:00:00+02:00',
    '2026-11-02T12:00:00-05:30',
    '2026-11-02T12:00:00.000-05:30',
  ];

  it.each(VALID_DATES)('accepts %p', (date) => {
    const out = buildFrontMatter({ title: 'T', date });
    expect(parsedDateMs(out)).toBe(expectedDateMs(date));
  });

  const INVALID_DATES = [
    '',
    '2026-13-01',
    '2026-00-10',
    '2026-01-00',
    '2026-02-30',
    '2026-02-29',
    '1900-02-29',
    '2026-11-32',
    '2026-11-02T24:00:00',
    '2026-11-02T12:60:00',
    '2026-11-02T12:00:60',
    '2026-11-02T12:00:00+24:00',
    '2026-11-02T12:00:00+02:60',
    '2026/11/02',
    '2026-11-2',
    '2026-11-02 ',
    'not-a-date',
  ];

  it.each(INVALID_DATES)('rejects invalid date %p', (date) => {
    expect(() => buildFrontMatter({ title: 'T', date })).toThrow(/date must be/);
  });

  it('applies leap-year rules (4/100/400)', () => {
    // 2024 divisible by 4 (not 100) -> leap; 1900 divisible by 100 not 400 -> not leap.
    expect(() => buildFrontMatter({ title: 'T', date: '2024-02-29' })).not.toThrow();
    expect(() => buildFrontMatter({ title: 'T', date: '2026-02-29' })).toThrow();
    expect(() => buildFrontMatter({ title: 'T', date: '1900-02-29' })).toThrow();
    expect(() => buildFrontMatter({ title: 'T', date: '2000-02-29' })).not.toThrow();
  });
});

describe('buildFrontMatter — invalid input handling', () => {
  const CASES: [string, FrontMatterMeta][] = [
    ['empty title', { title: '', date: '2026-01-01' }],
    ['whitespace title', { title: '   ', date: '2026-01-01' }],
    ['missing title', { date: '2026-01-01' } as FrontMatterMeta],
    ['non-string title', { title: 42 as unknown as string, date: '2026-01-01' }],
    ['non-string date', { title: 'T', date: 20260101 as unknown as string }],
    ['empty tag', { title: 'T', date: '2026-01-01', tags: ['ok', ''] }],
    ['whitespace tag', { title: 'T', date: '2026-01-01', tags: ['ok', '   '] }],
    ['non-string tag', { title: 'T', date: '2026-01-01', tags: ['ok', 7 as unknown as string] }],
  ];

  it.each(CASES)('rejects %s with a prefixed error message', (_label, meta) => {
    expect(() => buildFrontMatter(meta)).toThrow(/^buildFrontMatter:/);
  });

  it('reports the exact title error message', () => {
    expect(() => buildFrontMatter({ title: '', date: '2026-01-01' }))
      .toThrow('buildFrontMatter: title must be a non-empty string');
  });
});
