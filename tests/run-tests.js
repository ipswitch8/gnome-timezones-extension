#!/usr/bin/env -S gjs -m
// tests/run-tests.js
//
// Plain-GJS assertion harness -- no test framework, no npm.
//
// Run from the extension root with:
//   gjs -m tests/run-tests.js
//
// Exits 0 on success, 1 on any failure. Prints one pass/fail line per
// test plus a summary.

import {
  escapeMarkup,
  sanitizeFontSize,
  sanitizeColor,
  sanitizeFormatting,
  parseFormatting,
  serializeFormatting,
  DEFAULT_FORMATTING,
} from '../formatting.js';

import { SEPARATORS, DEFAULT_SEPARATOR_ID, getSeparatorById } from '../separators.js';

let passCount = 0;
let failCount = 0;
const failures = [];

function record(name, ok, detail) {
  if (ok) {
    passCount += 1;
    print(`PASS: ${name}`);
  } else {
    failCount += 1;
    failures.push(name);
    print(`FAIL: ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}

function test(name, fn) {
  try {
    fn();
    record(name, true);
  } catch (e) {
    record(name, false, e instanceof Error ? e.message : String(e));
  }
}

function assertEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg ? `${msg}: ` : ''}expected ${e}, got ${a}`);
  }
}

function assertTrue(value, msg) {
  if (value !== true) {
    throw new Error(msg || `expected true, got ${JSON.stringify(value)}`);
  }
}

function assertFalse(value, msg) {
  if (value !== false) {
    throw new Error(msg || `expected false, got ${JSON.stringify(value)}`);
  }
}

// ---------------------------------------------------------------------
// escapeMarkup
// ---------------------------------------------------------------------

test('escapeMarkup: <', () => assertEqual(escapeMarkup('<'), '&lt;'));
test('escapeMarkup: >', () => assertEqual(escapeMarkup('>'), '&gt;'));
test('escapeMarkup: &', () => assertEqual(escapeMarkup('&'), '&amp;'));
test('escapeMarkup: "', () => assertEqual(escapeMarkup('"'), '&quot;'));
test('escapeMarkup: \'', () => assertEqual(escapeMarkup("'"), '&apos;'));
test('escapeMarkup: <b>bold</b>', () =>
  assertEqual(escapeMarkup('<b>bold</b>'), '&lt;b&gt;bold&lt;/b&gt;'));
test('escapeMarkup: already-escaped string double-escapes', () =>
  assertEqual(escapeMarkup('&amp;'), '&amp;amp;'));
test('escapeMarkup: empty string', () => assertEqual(escapeMarkup(''), ''));
test('escapeMarkup: null', () => assertEqual(escapeMarkup(null), ''));
test('escapeMarkup: undefined', () => assertEqual(escapeMarkup(undefined), ''));
test('escapeMarkup: non-string number', () => assertEqual(escapeMarkup(42), '42'));

// ---------------------------------------------------------------------
// separator list integrity
// ---------------------------------------------------------------------

test('separators: no duplicate ids', () => {
  const ids = SEPARATORS.map((s) => s.id);
  const unique = new Set(ids);
  assertEqual(unique.size, ids.length, 'duplicate id found');
});

test('separators: no empty id/label/value', () => {
  for (const entry of SEPARATORS) {
    assertTrue(typeof entry.id === 'string' && entry.id.length > 0, `empty id`);
    assertTrue(typeof entry.label === 'string' && entry.label.length > 0, `empty label for ${entry.id}`);
    assertTrue(typeof entry.value === 'string' && entry.value.length > 0, `empty value for ${entry.id}`);
  }
});

test('separators: DEFAULT_SEPARATOR_ID resolves', () => {
  const entry = getSeparatorById(DEFAULT_SEPARATOR_ID);
  assertTrue(entry !== undefined, 'default separator id did not resolve');
  assertEqual(entry.id, DEFAULT_SEPARATOR_ID);
});

test('separators: unknown id returns undefined', () => {
  assertEqual(getSeparatorById('does-not-exist'), undefined);
});

test('separators: every value survives escapeMarkup sanely', () => {
  for (const entry of SEPARATORS) {
    const escaped = escapeMarkup(entry.value);
    assertTrue(typeof escaped === 'string', `escapeMarkup failed for ${entry.id}`);
    // None of the curated separator values contain markup-significant
    // characters, so escaping should be a no-op round trip.
    assertEqual(escaped, entry.value, `unexpected escaping change for ${entry.id}`);
  }
});

// ---------------------------------------------------------------------
// sanitizeFontSize
// ---------------------------------------------------------------------

test('sanitizeFontSize: valid mid-range', () => assertEqual(sanitizeFontSize(14), 14));
test('sanitizeFontSize: lower boundary (6)', () => assertEqual(sanitizeFontSize(6), 6));
test('sanitizeFontSize: upper boundary (32)', () => assertEqual(sanitizeFontSize(32), 32));
test('sanitizeFontSize: below min clamps to min', () => assertEqual(sanitizeFontSize(3), 6));
test('sanitizeFontSize: above max clamps to max', () => assertEqual(sanitizeFontSize(99), 32));
test('sanitizeFontSize: 0 means inherit', () => assertEqual(sanitizeFontSize(0), 0));
test('sanitizeFontSize: negative clamps to min', () => assertEqual(sanitizeFontSize(-5), 6));
test('sanitizeFontSize: NaN -> 0', () => assertEqual(sanitizeFontSize(NaN), 0));
test('sanitizeFontSize: Infinity -> 0', () => assertEqual(sanitizeFontSize(Infinity), 0));
test('sanitizeFontSize: numeric string "12"', () => assertEqual(sanitizeFontSize('12'), 12));
test('sanitizeFontSize: null -> 0', () => assertEqual(sanitizeFontSize(null), 0));
test('sanitizeFontSize: {} -> 0', () => assertEqual(sanitizeFontSize({}), 0));

// ---------------------------------------------------------------------
// sanitizeColor
// ---------------------------------------------------------------------

test('sanitizeColor: valid #aabbcc', () => assertEqual(sanitizeColor('#aabbcc'), '#aabbcc'));
test('sanitizeColor: uppercase #AABBCC', () => assertEqual(sanitizeColor('#AABBCC'), '#aabbcc'));
test('sanitizeColor: shorthand #abc expands', () => assertEqual(sanitizeColor('#abc'), '#aabbcc'));
test('sanitizeColor: no-hash prefix "aabbcc"', () => assertEqual(sanitizeColor('aabbcc'), '#aabbcc'));
test('sanitizeColor: empty string', () => assertEqual(sanitizeColor(''), ''));
test('sanitizeColor: null', () => assertEqual(sanitizeColor(null), ''));

test('sanitizeColor: malicious quote-injection', () =>
  assertEqual(sanitizeColor('#aabbcc" foreground="red'), ''));
test('sanitizeColor: malicious tag injection', () => assertEqual(sanitizeColor('red<b>'), ''));
test('sanitizeColor: invalid hex digits #gggggg', () => assertEqual(sanitizeColor('#gggggg'), ''));
test('sanitizeColor: too-long hex #aabbccdd', () => assertEqual(sanitizeColor('#aabbccdd'), ''));
test('sanitizeColor: javascript: scheme', () => assertEqual(sanitizeColor('javascript:x'), ''));
test('sanitizeColor: embedded newline', () => assertEqual(sanitizeColor('#aabbcc\n" x="y'), ''));

for (const entry of ['#aabbcc" foreground="red', 'red<b>', '#gggggg', '#aabbccdd', 'javascript:x', '#aabbcc\n" x="y']) {
  test(`sanitizeColor: result contains only [0-9a-f#] for malicious input ${JSON.stringify(entry)}`, () => {
    const result = sanitizeColor(entry);
    assertTrue(/^[0-9a-f#]*$/.test(result), `result "${result}" contains disallowed characters`);
  });
}

// ---------------------------------------------------------------------
// parseFormatting
// ---------------------------------------------------------------------

test('parseFormatting: valid JSON', () => {
  const result = parseFormatting(
    JSON.stringify({ size: 12, color: '#ff0000', boldCity: true, boldTime: false, boldZone: true })
  );
  assertEqual(result, { size: 12, color: '#ff0000', boldCity: true, boldTime: false, boldZone: true });
});

test('parseFormatting: malformed JSON', () => {
  assertEqual(parseFormatting('{not valid json'), DEFAULT_FORMATTING);
});

test('parseFormatting: JSON array', () => {
  assertEqual(parseFormatting('[1,2,3]'), DEFAULT_FORMATTING);
});

test('parseFormatting: JSON null', () => {
  assertEqual(parseFormatting('null'), DEFAULT_FORMATTING);
});

test('parseFormatting: JSON string', () => {
  assertEqual(parseFormatting('"hello"'), DEFAULT_FORMATTING);
});

test('parseFormatting: object with missing fields', () => {
  assertEqual(parseFormatting(JSON.stringify({ boldCity: true })), {
    size: 0,
    color: '',
    boldCity: true,
    boldTime: false,
    boldZone: false,
  });
});

test('parseFormatting: malicious color/size values', () => {
  const result = parseFormatting(
    JSON.stringify({ size: 'DROP TABLE', color: '#fff" foreground="red', boldCity: 'yes' })
  );
  assertEqual(result.size, 0);
  assertEqual(result.color, '');
  assertEqual(result.boldCity, false);
});

test('parseFormatting: empty string input', () => {
  assertEqual(parseFormatting(''), DEFAULT_FORMATTING);
});

test('parseFormatting: non-string input', () => {
  assertEqual(parseFormatting(undefined), DEFAULT_FORMATTING);
});

// ---------------------------------------------------------------------
// serializeFormatting round-trip
// ---------------------------------------------------------------------

test('serializeFormatting: round-trips through parseFormatting', () => {
  const input = { size: 200, color: 'not-a-color', boldCity: 1, boldTime: 0, boldZone: true };
  const serialized = serializeFormatting(input);
  const roundTripped = parseFormatting(serialized);
  const expected = sanitizeFormatting(input);
  assertEqual(roundTripped, expected);
});

test('serializeFormatting: default object round-trips to itself', () => {
  const serialized = serializeFormatting(DEFAULT_FORMATTING);
  const roundTripped = parseFormatting(serialized);
  assertEqual(roundTripped, DEFAULT_FORMATTING);
});

// ---------------------------------------------------------------------
// summary
// ---------------------------------------------------------------------

print('');
print(`Summary: ${passCount} passed, ${failCount} failed, ${passCount + failCount} total`);

if (failCount > 0) {
  print('');
  print('Failed tests:');
  for (const name of failures) {
    print(`  - ${name}`);
  }
}

// gjs -m top-level scripts run in an implicit async context; explicitly
// exit with the correct status so CI / shell scripts see it.
imports.system.exit(failCount > 0 ? 1 : 0);
