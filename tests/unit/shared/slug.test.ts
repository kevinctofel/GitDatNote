/**
 * Unit tests for `src/shared/slug.ts` (task 2.6).
 *
 * Verifies ASCII slug generation, the `untitled` fallback for empty or
 * non-alphabetic input, deterministic behavior, and that output is always
 * restricted to the documented slug alphabet. Per the specification, no
 * Unicode slugs, transliteration, or uniqueness checking are expected here.
 */
import { describe, expect, it } from 'vitest';

import { SLUG_FALLBACK, generateSlug } from '../../../src/shared/slug.js';

const SLUG_CASES: [string, string][] = [
  ['Hello World', 'hello-world'],
  ['HELLO WORLD', 'hello-world'],
  ['  My First Post!  ', 'my-first-post'],
  ['a    b\n\n c', 'a-b-c'],
  ['Café and Coffee', 'cafe-and-coffee'],
  ['Ünïcödé', 'unicode'],
  ['Résumé', 'resume'],
  ['e\u0301xtra', 'extra'],
  ['ﬁne', 'fine'],
  ["What's New?", 'what-s-new'],
  ['a:b*c!', 'a-b-c'],
  ['a--b---c', 'a-b-c'],
  ['a - b - c', 'a-b-c'],
  ['Post 123', 'post-123'],
  ['2026', '2026'],
  ['', 'untitled'],
  ['!!!', 'untitled'],
  ['---', 'untitled'],
  ['   ', 'untitled'],
  ['🚀', 'untitled'],
  ['Hello 🚀 World', 'hello-world'],
  ['日本語', 'untitled'],
  ['中文标题', 'untitled'],
  ['Hello 世界 World', 'hello-world'],
  ['Ünïcode 日本語', 'unicode'],
];

describe('generateSlug', () => {
  it.each(SLUG_CASES)('slugifies %p as %p', (input, expected) => {
    expect(generateSlug(input)).toBe(expected);
  });

  it('always emits the documented slug alphabet (a-z, 0-9, hyphen groups, or fallback)', () => {
    for (const [input] of SLUG_CASES) {
      expect(generateSlug(input)).toMatch(/^(?:untitled|[a-z0-9]+(?:-[a-z0-9]+)*)$/);
    }
  });

  it('never emits leading or trailing hyphens', () => {
    for (const [input] of SLUG_CASES) {
      const slug = generateSlug(input);
      expect(slug.startsWith('-')).toBe(false);
      expect(slug.endsWith('-')).toBe(false);
    }
  });

  it('is deterministic for identical input', () => {
    for (const [input] of SLUG_CASES) {
      expect(generateSlug(input)).toBe(generateSlug(input));
    }
  });
});

describe('SLUG_FALLBACK', () => {
  it('is the documented "untitled" fallback', () => {
    expect(SLUG_FALLBACK).toBe('untitled');
  });
});
