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
  buildEntryText,
  buildEntryMarkup,
  setZoneFormatting,
  rgbaToHex,
  getEffectiveFormatting,
} from '../formatting.js';

import {
  SEPARATORS,
  DEFAULT_SEPARATOR_ID,
  getSeparatorById,
  resolveSeparatorValue,
} from '../separators.js';

import {
  DATE_FORMATS,
  DEFAULT_DATE_FORMAT_ID,
  getDateFormatById,
  resolveDateFormat,
  formatDateForDisplay,
} from '../dateFormats.js';

import { buildHoverPopupRowText, buildHoverPopupRows } from '../hoverPopup.js';

import GLib from 'gi://GLib';

// Forced BEFORE any Gio.Settings object is constructed anywhere in this
// process (same isolation technique as tests/run-prefs-tests.js) -- the
// backward-compatibility section below constructs a real Gio.Settings
// against the real compiled schema to read the new keys' ACTUAL schema
// defaults (rather than assuming/hardcoding what they are), and this
// guarantees that read never reaches dconf/the session bus.
GLib.setenv('GSETTINGS_BACKEND', 'memory', true);
import Gio from 'gi://Gio';

// KAREN-GATE FIX (round 4, live-testing report): formattingPresets.js
// (FONT_SIZE_PRESETS/COLOR_PALETTE/resolvePresetId) backed the panel
// popup menu's "Font size"/"Color" preset submenus. Those submenus were
// permanently removed from the popup (see extension.js's comment on the
// this._separatorMenuItems field in the constructor for the full
// round-1..4 history) in favor of prefs.js's real Adw.SpinRow/
// color-chooser widgets, which were never backed by a curated preset
// list. With formattingPresets.js's only real caller gone, nothing in
// this project imports it any more, so the module and its dedicated
// tests (formerly here) were removed rather than left as dead code
// nothing reaches -- see this file's git history for the removed
// `formattingPresets: ...`/`resolvePresetId: ...` test blocks.

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

// Strips every tag buildEntryMarkup() itself is allowed to emit (<b>,
// </b>, <span ...>, </span>) from a markup string, leaving only text
// content. Used to assert that whatever remains contains no raw '<'/'>'
// (i.e. every '<'/'>' in the original markup was either one of these
// builder-emitted tags or came from an already-escaped &lt;/&gt; entity).
function stripBuilderTags(markup) {
  return markup.replace(/<\/?b>/g, '').replace(/<span[^>]*>/g, '').replace(/<\/span>/g, '');
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
// dateFormats.js: curated list integrity
// ---------------------------------------------------------------------

test('dateFormats: no duplicate ids', () => {
  const ids = DATE_FORMATS.map((e) => e.id);
  const unique = new Set(ids);
  assertEqual(unique.size, ids.length, 'duplicate id found');
});

test('dateFormats: no empty id/label/value', () => {
  for (const entry of DATE_FORMATS) {
    assertTrue(typeof entry.id === 'string' && entry.id.length > 0, 'empty id');
    assertTrue(typeof entry.label === 'string' && entry.label.length > 0, `empty label for ${entry.id}`);
    assertTrue(typeof entry.value === 'string' && entry.value.length > 0, `empty value for ${entry.id}`);
  }
});

test('dateFormats: DEFAULT_DATE_FORMAT_ID resolves to a real curated entry', () => {
  const entry = getDateFormatById(DEFAULT_DATE_FORMAT_ID);
  assertTrue(entry !== undefined, 'default date format id did not resolve');
  assertEqual(entry.id, DEFAULT_DATE_FORMAT_ID);
});

test('dateFormats: getDateFormatById unknown id returns undefined', () => {
  assertEqual(getDateFormatById('does-not-exist'), undefined);
});

// ---------------------------------------------------------------------
// dateFormats.js: resolveDateFormat
// ---------------------------------------------------------------------

test('resolveDateFormat: curated id resolves to that entry\'s value', () => {
  assertEqual(resolveDateFormat('iso'), getDateFormatById('iso').value);
});

test('resolveDateFormat: empty string resolves to the curated default value (not null -- unlike resolveSeparatorValue, there is no legacy fallback to defer to)', () => {
  assertEqual(resolveDateFormat(''), getDateFormatById(DEFAULT_DATE_FORMAT_ID).value);
});

test('resolveDateFormat: unset/non-string input resolves to the curated default value', () => {
  assertEqual(resolveDateFormat(undefined), getDateFormatById(DEFAULT_DATE_FORMAT_ID).value);
  assertEqual(resolveDateFormat(null), getDateFormatById(DEFAULT_DATE_FORMAT_ID).value);
  assertEqual(resolveDateFormat(42), getDateFormatById(DEFAULT_DATE_FORMAT_ID).value);
});

test('resolveDateFormat: an unrecognized literal string is returned as-is (a custom format pattern)', () => {
  assertEqual(resolveDateFormat('%G-W%V'), '%G-W%V');
});

test('resolveDateFormat: an over-long literal is capped at MAX_LITERAL_DATE_FORMAT_LENGTH (discriminating: the uncapped input is 200 chars, the result must be far shorter)', () => {
  const hostile = '%Y'.repeat(100); // 200 chars, not a curated id
  const resolved = resolveDateFormat(hostile);
  assertTrue(resolved.length < hostile.length, `expected the resolved literal to be capped, got length ${resolved.length} (input was ${hostile.length})`);
  assertTrue(resolved.length <= 64, `expected the resolved literal to be capped at 64 chars, got ${resolved.length}`);
  assertEqual(resolved, hostile.slice(0, resolved.length));
});

test('resolveDateFormat: hostile input containing markup-significant characters is returned verbatim (capping/escaping is the CALLER\'s job for markup surfaces -- this function only bounds length)', () => {
  const hostile = '<b>%Y</b>';
  assertEqual(resolveDateFormat(hostile), hostile);
});

// ---------------------------------------------------------------------
// dateFormats.js: formatDateForDisplay
// ---------------------------------------------------------------------

test('formatDateForDisplay: a valid format produces the expected output for a known fixed date', () => {
  const dt = GLib.DateTime.new_utc(2026, 7, 20, 12, 0, 0);
  assertEqual(formatDateForDisplay(dt, '%Y-%m-%d'), '2026-07-20');
});

test('formatDateForDisplay: an invalid/unsupported specifier falls back to the curated default format rather than propagating null', () => {
  const dt = GLib.DateTime.new_utc(2026, 7, 20, 12, 0, 0);
  const result = formatDateForDisplay(dt, '%Q'); // not a real GLib.DateTime specifier
  assertTrue(typeof result === 'string', 'expected a string result even for an invalid specifier');
  assertTrue(result.length > 0, 'expected a non-empty fallback result for an invalid specifier');
  // Must not be (or contain) the literal string "null" -- the exact
  // regression this fallback exists to prevent.
  assertFalse(result.includes('null'), `fallback result must never contain the literal text "null": ${JSON.stringify(result)}`);
});

test('formatDateForDisplay: a format for which GLib.DateTime.format() itself returns null (real, reproduced invalid specifier -- verified empirically on this system, see the assertion below) falls back to the curated default rather than propagating null', () => {
  // Real GLib.DateTime.format() failure modes are documented as returning
  // null (not throwing) for an invalid/unsupported specifier or bad
  // UTF-8. Empirically verified on this system: an empty format string
  // returns '' here (not null), so '%Q' (already used by the test above)
  // is the reliable null-producing input actually available in this
  // environment -- reproduced directly here (rather than trusting the
  // other test's fallback-only assertions) so this test's own premise is
  // self-verifying and cannot silently stop testing what it claims to.
  const dt = GLib.DateTime.new_utc(2026, 7, 20, 12, 0, 0);
  assertEqual(dt.format('%Q'), null, 'test premise: GLib.DateTime.format(\'%Q\') is expected to return null on this system -- if this ever changes, this test needs a different null-producing input');
  const result = formatDateForDisplay(dt, '%Q');
  assertTrue(typeof result === 'string', 'expected a string result, never null/undefined, when the underlying format() call returns null');
  assertTrue(result.length > 0, 'expected a non-empty fallback result');
  assertFalse(result.includes('null'), `fallback result must never contain the literal text "null": ${JSON.stringify(result)}`);
});

test('formatDateForDisplay: output is capped at 100 characters even for a maximally expansion-heavy literal format', () => {
  const dt = GLib.DateTime.new_utc(2026, 7, 20, 12, 0, 0);
  const hostile = '%c'.repeat(60); // each %c can expand to a long locale-dependent date+time string
  const result = formatDateForDisplay(dt, hostile);
  assertTrue(result.length <= 100, `expected output capped at 100 chars, got ${result.length}`);
});

test('formatDateForDisplay: never throws for a non-GLib.DateTime input, and returns an empty string', () => {
  assertEqual(formatDateForDisplay(null, '%Y'), '');
  assertEqual(formatDateForDisplay(undefined, '%Y'), '');
  assertEqual(formatDateForDisplay({}, '%Y'), '');
  assertEqual(formatDateForDisplay('2026-07-20', '%Y'), '');
  assertEqual(formatDateForDisplay(42, '%Y'), '');
});

test('formatDateForDisplay: never throws for a non-string/empty formatString, falling back to the curated default format', () => {
  const dt = GLib.DateTime.new_utc(2026, 7, 20, 12, 0, 0);
  assertEqual(formatDateForDisplay(dt, ''), formatDateForDisplay(dt, resolveDateFormat('')));
  assertEqual(formatDateForDisplay(dt, null), formatDateForDisplay(dt, resolveDateFormat('')));
  assertEqual(formatDateForDisplay(dt, undefined), formatDateForDisplay(dt, resolveDateFormat('')));
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
// sanitizeFormatting -- direct tests of its own contract. Previously this
// function was only exercised indirectly, as an expected-value helper
// inside parseFormatting/serializeFormatting/prefs.js-interaction tests
// (e.g. `assertEqual(result, sanitizeFormatting(input))`), which never
// pinned down sanitizeFormatting()'s OWN behavior in isolation -- a
// regression in sanitizeFormatting() itself could silently pass those
// tests as long as it broke in the same way on both sides of the
// comparison.
// ---------------------------------------------------------------------

test('sanitizeFormatting: non-object input (null) returns DEFAULT_FORMATTING', () => {
  assertEqual(sanitizeFormatting(null), DEFAULT_FORMATTING);
});

test('sanitizeFormatting: non-object input (undefined) returns DEFAULT_FORMATTING', () => {
  assertEqual(sanitizeFormatting(undefined), DEFAULT_FORMATTING);
});

test('sanitizeFormatting: non-object input (string) returns DEFAULT_FORMATTING', () => {
  assertEqual(sanitizeFormatting('not an object'), DEFAULT_FORMATTING);
});

test('sanitizeFormatting: non-object input (number) returns DEFAULT_FORMATTING', () => {
  assertEqual(sanitizeFormatting(42), DEFAULT_FORMATTING);
});

test('sanitizeFormatting: array input returns DEFAULT_FORMATTING (arrays are typeof "object" but explicitly rejected)', () => {
  assertEqual(sanitizeFormatting([1, 2, 3]), DEFAULT_FORMATTING);
  assertEqual(sanitizeFormatting([]), DEFAULT_FORMATTING);
  // An array carrying own properties that shadow formatting field names --
  // this is what actually exercises the `Array.isArray()` guard: without
  // it, `typeof arr === 'object'` alone would let this fall through to the
  // normal field-by-field path and pick up `arr.boldCity`/`arr.size`
  // instead of being rejected outright.
  const hostileArray = [1, 2, 3];
  hostileArray.boldCity = true;
  hostileArray.size = 20;
  assertEqual(sanitizeFormatting(hostileArray), DEFAULT_FORMATTING);
});

test('sanitizeFormatting: empty object {} defaults every field', () => {
  assertEqual(sanitizeFormatting({}), DEFAULT_FORMATTING);
});

test('sanitizeFormatting: size field is clamped via sanitizeFontSize (not merely passed through)', () => {
  assertEqual(sanitizeFormatting({ size: 999 }).size, 32);
  assertEqual(sanitizeFormatting({ size: -100 }).size, 6);
  assertEqual(sanitizeFormatting({ size: 'not a number' }).size, 0);
});

test('sanitizeFormatting: color field is validated via sanitizeColor (not merely passed through)', () => {
  assertEqual(sanitizeFormatting({ color: '#ABCDEF' }).color, '#abcdef');
  assertEqual(sanitizeFormatting({ color: 'not-a-color' }).color, '');
  assertEqual(sanitizeFormatting({ color: '#fff" foreground="red' }).color, '');
});

test('sanitizeFormatting: boldCity/boldTime/boldZone coerce to strict boolean (true survives, everything else is false)', () => {
  assertEqual(sanitizeFormatting({ boldCity: true }).boldCity, true);
  assertEqual(sanitizeFormatting({ boldCity: false }).boldCity, false);
  assertEqual(sanitizeFormatting({ boldCity: 1 }).boldCity, false);
  assertEqual(sanitizeFormatting({ boldCity: 'true' }).boldCity, false);
  assertEqual(sanitizeFormatting({ boldCity: {} }).boldCity, false);
  assertEqual(sanitizeFormatting({ boldCity: null }).boldCity, false);
  assertEqual(sanitizeFormatting({ boldCity: undefined }).boldCity, false);
});

test('sanitizeFormatting: all bold fields independently coerce in a single object', () => {
  assertEqual(sanitizeFormatting({ boldCity: true, boldTime: 'yes', boldZone: 1 }), {
    size: 0,
    color: '',
    boldCity: true,
    boldTime: false,
    boldZone: false,
  });
});

test('sanitizeFormatting: unknown/extra fields are silently dropped (output shape is exactly the five known fields)', () => {
  const result = sanitizeFormatting({ size: 10, extraneous: 'x', __proto__: { evil: true } });
  assertEqual(Object.keys(result).sort(), ['boldCity', 'boldTime', 'boldZone', 'color', 'size']);
});

test('sanitizeFormatting: a fully hostile object sanitizes every field independently to safe values', () => {
  const hostile = {
    size: '<script>alert(1)</script>',
    color: 'javascript:alert(1)',
    boldCity: '<b>',
    boldTime: { toString: () => 'true' },
    boldZone: [],
  };
  assertEqual(sanitizeFormatting(hostile), {
    size: 0,
    color: '',
    boldCity: false,
    boldTime: false,
    boldZone: false,
  });
});

test('sanitizeFormatting: a fully well-formed object round-trips unchanged', () => {
  const wellFormed = { size: 18, color: '#3584e4', boldCity: true, boldTime: false, boldZone: true };
  assertEqual(sanitizeFormatting(wellFormed), wellFormed);
});

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
// buildEntryText -- legacy plain-text format, byte-identical reproduction
// ---------------------------------------------------------------------

test('buildEntryText: city+zone+time', () =>
  assertEqual(buildEntryText({ city: 'New York', zone: 'EST', time: '3:00 PM' }), 'New York EST 3:00 PM'));

test('buildEntryText: city-only+time (zone hidden -> single space)', () =>
  assertEqual(buildEntryText({ city: 'New York', zone: null, time: '3:00 PM' }), 'New York 3:00 PM'));

test('buildEntryText: no-city+time (empty city, zone hidden)', () =>
  assertEqual(buildEntryText({ city: '', zone: null, time: '3:00 PM' }), ' 3:00 PM'));

test('buildEntryText: no-city+zone+time (empty city, zone shown)', () =>
  assertEqual(buildEntryText({ city: '', zone: 'PST', time: '3:00 PM' }), ' PST 3:00 PM'));

test('buildEntryText: custom label containing spaces', () =>
  assertEqual(
    buildEntryText({ city: 'My Home Base', zone: 'PST', time: '11:45 AM' }),
    'My Home Base PST 11:45 AM'
  ));

test('buildEntryText: undefined zone treated same as null (hidden)', () =>
  assertEqual(buildEntryText({ city: 'X', zone: undefined, time: 'Y' }), 'X Y'));

// ---------------------------------------------------------------------
// buildEntryMarkup -- neutral formatting equivalence
// ---------------------------------------------------------------------

test('buildEntryMarkup: neutral formatting emits no span attributes', () => {
  const markup = buildEntryMarkup({ city: 'Tokyo', zone: 'JST', time: '11:00 PM' }, DEFAULT_FORMATTING);
  assertFalse(markup.includes('<span'), `unexpected <span> in neutral markup: ${markup}`);
});

test('buildEntryMarkup: neutral formatting equivalent to escaped plain text', () => {
  const segments = { city: 'Tokyo', zone: 'JST', time: '11:00 PM' };
  const markup = buildEntryMarkup(segments, DEFAULT_FORMATTING);
  const expected = escapeMarkup(buildEntryText(segments));
  assertEqual(markup, expected);
});

test('buildEntryMarkup: default fmt argument (undefined) behaves like DEFAULT_FORMATTING', () => {
  const segments = { city: 'Tokyo', zone: 'JST', time: '11:00 PM' };
  assertEqual(buildEntryMarkup(segments, undefined), buildEntryMarkup(segments, DEFAULT_FORMATTING));
});

test('buildEntryMarkup: zone hidden (null) matches buildEntryText spacing', () => {
  const segments = { city: 'Tokyo', zone: null, time: '11:00 PM' };
  assertEqual(buildEntryMarkup(segments, DEFAULT_FORMATTING), escapeMarkup(buildEntryText(segments)));
});

// ---------------------------------------------------------------------
// buildEntryMarkup -- independent per-segment bold
// ---------------------------------------------------------------------

test('buildEntryMarkup: boldCity bolds only the city segment', () => {
  const markup = buildEntryMarkup(
    { city: 'City', zone: 'Zone', time: 'Time' },
    { ...DEFAULT_FORMATTING, boldCity: true }
  );
  assertTrue(markup.includes('<b>City</b>'), markup);
  assertFalse(markup.includes('<b>Zone</b>'), markup);
  assertFalse(markup.includes('<b>Time</b>'), markup);
});

test('buildEntryMarkup: boldTime bolds only the time segment', () => {
  const markup = buildEntryMarkup(
    { city: 'City', zone: 'Zone', time: 'Time' },
    { ...DEFAULT_FORMATTING, boldTime: true }
  );
  assertTrue(markup.includes('<b>Time</b>'), markup);
  assertFalse(markup.includes('<b>City</b>'), markup);
  assertFalse(markup.includes('<b>Zone</b>'), markup);
});

test('buildEntryMarkup: boldZone bolds only the zone segment', () => {
  const markup = buildEntryMarkup(
    { city: 'City', zone: 'Zone', time: 'Time' },
    { ...DEFAULT_FORMATTING, boldZone: true }
  );
  assertTrue(markup.includes('<b>Zone</b>'), markup);
  assertFalse(markup.includes('<b>City</b>'), markup);
  assertFalse(markup.includes('<b>Time</b>'), markup);
});

test('buildEntryMarkup: all three bold flags bold all three segments independently', () => {
  const markup = buildEntryMarkup(
    { city: 'City', zone: 'Zone', time: 'Time' },
    { ...DEFAULT_FORMATTING, boldCity: true, boldTime: true, boldZone: true }
  );
  assertTrue(markup.includes('<b>City</b>'), markup);
  assertTrue(markup.includes('<b>Zone</b>'), markup);
  assertTrue(markup.includes('<b>Time</b>'), markup);
});

test('buildEntryMarkup: bold flags with zone hidden only bold city/time', () => {
  const markup = buildEntryMarkup(
    { city: 'City', zone: null, time: 'Time' },
    { ...DEFAULT_FORMATTING, boldCity: true, boldTime: true }
  );
  assertEqual(markup, '<b>City</b> <b>Time</b>');
});

// ---------------------------------------------------------------------
// buildEntryMarkup -- size/color attributes
// ---------------------------------------------------------------------

test('buildEntryMarkup: size attribute uses 1024x scaling', () => {
  const markup = buildEntryMarkup({ city: 'C', zone: null, time: 'T' }, { ...DEFAULT_FORMATTING, size: 14 });
  assertTrue(markup.includes('size="14336"'), markup);
});

test('buildEntryMarkup: size 0 (inherit) emits no size attribute', () => {
  const markup = buildEntryMarkup({ city: 'C', zone: null, time: 'T' }, { ...DEFAULT_FORMATTING, size: 0 });
  assertFalse(markup.includes('size='), markup);
});

test('buildEntryMarkup: color attribute is well-formed', () => {
  const markup = buildEntryMarkup({ city: 'C', zone: null, time: 'T' }, { ...DEFAULT_FORMATTING, color: '#ff0000' });
  assertTrue(markup.includes('foreground="#ff0000"'), markup);
});

test('buildEntryMarkup: empty color emits no foreground attribute', () => {
  const markup = buildEntryMarkup({ city: 'C', zone: null, time: 'T' }, { ...DEFAULT_FORMATTING, color: '' });
  assertFalse(markup.includes('foreground='), markup);
});

test('buildEntryMarkup: size+color together produce one well-formed <span>', () => {
  const markup = buildEntryMarkup(
    { city: 'C', zone: null, time: 'T' },
    { ...DEFAULT_FORMATTING, size: 20, color: '#00ff00' }
  );
  assertTrue(/^<span size="20480" foreground="#00ff00">.*<\/span>$/.test(markup), markup);
});

// ---------------------------------------------------------------------
// buildEntryMarkup -- injection / escaping (security-critical)
// ---------------------------------------------------------------------

const injectionLabels = [
  '<b>evil</b>',
  'Fish & Chips',
  'She said "hi"',
  "It's a trap",
  '<span foreground="red">gotcha</span>',
];

for (const label of injectionLabels) {
  test(`buildEntryMarkup: city injection case is fully escaped: ${JSON.stringify(label)}`, () => {
    const markup = buildEntryMarkup({ city: label, zone: 'UTC', time: '12:00' }, DEFAULT_FORMATTING);
    const stripped = stripBuilderTags(markup);
    assertFalse(/[<>]/.test(stripped), `unescaped angle bracket survived in: ${markup}`);
    assertTrue(markup.includes(escapeMarkup(label)), `escaped payload not found in: ${markup}`);
  });

  test(`buildEntryMarkup: zone injection case is fully escaped: ${JSON.stringify(label)}`, () => {
    const markup = buildEntryMarkup({ city: 'City', zone: label, time: '12:00' }, DEFAULT_FORMATTING);
    const stripped = stripBuilderTags(markup);
    assertFalse(/[<>]/.test(stripped), `unescaped angle bracket survived in: ${markup}`);
  });

  test(`buildEntryMarkup: time injection case is fully escaped: ${JSON.stringify(label)}`, () => {
    const markup = buildEntryMarkup({ city: 'City', zone: 'UTC', time: label }, DEFAULT_FORMATTING);
    const stripped = stripBuilderTags(markup);
    assertFalse(/[<>]/.test(stripped), `unescaped angle bracket survived in: ${markup}`);
  });
}

test('buildEntryMarkup: injection case escaped even when that segment is bolded', () => {
  const markup = buildEntryMarkup({ city: '<b>evil</b>', zone: 'UTC', time: '12:00' }, {
    ...DEFAULT_FORMATTING,
    boldCity: true,
  });
  assertEqual(markup, '<b>&lt;b&gt;evil&lt;/b&gt;</b> UTC 12:00');
  const stripped = stripBuilderTags(markup);
  assertFalse(/[<>]/.test(stripped), markup);
});

test('buildEntryMarkup: malicious formatting blob (parseFormatting) produces safe attributes', () => {
  const blob = JSON.stringify({
    size: 'DROP TABLE',
    color: '#fff" foreground="red',
    boldCity: true,
    boldTime: 'yes',
    boldZone: 1,
  });
  const fmt = parseFormatting(blob);
  const markup = buildEntryMarkup({ city: 'A', zone: 'Z', time: 'T' }, fmt);

  // size was garbage -> sanitizes to 0 -> no size attribute at all.
  assertFalse(markup.includes('size='), markup);
  // color had a quote-injection attempt -> sanitizes to '' -> no foreground
  // attribute, and critically no stray '" foreground="red' text anywhere.
  assertFalse(markup.includes('foreground='), markup);
  assertFalse(markup.includes('red'), markup);
  // boldCity was a real `true` -> still honored.
  assertTrue(markup.includes('<b>A</b>'), markup);
  // boldTime/boldZone were non-boolean truthy values -> sanitizeBool()
  // rejects anything that isn't literally `true`, so neither bolds.
  assertFalse(markup.includes('<b>T</b>'), markup);
  assertFalse(markup.includes('<b>Z</b>'), markup);
});

test('buildEntryMarkup: absurd size from malicious blob clamps into a well-formed attribute', () => {
  const fmt = parseFormatting(JSON.stringify({ size: 999999 }));
  const markup = buildEntryMarkup({ city: 'A', zone: null, time: 'T' }, fmt);
  // sanitizeFontSize clamps to MAX_FONT_SIZE (32) -> 32 * 1024 = 32768.
  assertTrue(markup.includes('size="32768"'), markup);
});

// ---------------------------------------------------------------------
// buildEntryMarkup -- real Pango.parse_markup() round-trip (Phase 5)
//
// Every injection test above asserts on the ASSEMBLED STRING (no stray
// '<'/'>', expected escaped substrings present). This section is stronger
// evidence for the same claim: it feeds buildEntryMarkup()'s real output
// through the REAL Pango markup parser (the same one clutter_text.
// set_markup() uses at runtime) and asserts (a) it parses without error
// and (b) the parser's own recovered plain-text output shows each hostile
// payload as literal inert text, never as applied formatting/structure.
// String assertions can miss a payload that happens to still parse as
// valid-but-wrong markup (e.g. a clever partial tag); running the actual
// parser cannot.
//
// Guarded import per project convention (SKIP=FAIL): if the Pango typelib
// is not importable in this environment, this section fails loudly rather
// than silently reporting 0 tests as a pass. This must never be
// downgraded to a silent skip -- unlike tests/run-prefs-tests.js's GTK4/
// Adw feature detection (which has an explicit, opt-in TZPREFS_ALLOW_SKIP
// escape hatch for genuinely display-less environments), Pango has no
// display/session dependency at all -- it is a plain text-layout library
// importable from any `gjs` process, exactly like GLib. There is no
// legitimate environment where importing it should fail, so no skip
// escape hatch is offered here.
// ---------------------------------------------------------------------

{
  let Pango;
  try {
    ({ default: Pango } = await import('gi://Pango'));
  } catch (e) {
    record('buildEntryMarkup: Pango typelib importable for markup round-trip verification', false, e instanceof Error ? e.message : String(e));
    Pango = null;
  }

  if (Pango) {
    // Pango.parse_markup(markup, length, accel_marker) -> [ok, attrList, text, accelChar]
    // accel_marker must be a real (possibly single-NUL) string, not
    // null/0 -- '\0' disables accelerator-marker handling, which this
    // code never uses.
    const parseMarkup = (markup) => Pango.parse_markup(markup, -1, '\0');

    // Pango.parse_markup() ALWAYS returns a non-null Pango.AttrList, even
    // for plain text with zero markup (verified empirically: parsing
    // "plain text" yields a real, non-null, EMPTY AttrList; only
    // `attrList.get_attributes().length` distinguishes "no formatting was
    // applied" from "formatting was applied"). Every assertion in this
    // section that claims "not applied formatting"/"recovers as inert
    // text" therefore checks `get_attributes().length === 0`, not
    // presence/non-nullness of the AttrList itself -- a null/undefined
    // check here would pass identically whether or not the hostile
    // payload was actually interpreted as markup, which defeats the
    // entire point of running the real parser instead of just asserting
    // on the string.
    const attrCount = (attrList) => attrList.get_attributes().length;

    // 'double quote'/'single quote' are deliberately NOT included in
    // roundTripCases below. Pango's markup grammar only treats quotes as
    // syntactically significant INSIDE an attribute value (e.g.
    // `foreground="..."`); a raw, unescaped quote in ELEMENT TEXT CONTENT
    // is not a markup metacharacter at all and parses identically whether
    // or not escapeMarkup() ever touches it. A round-trip case built from
    // quotes alone therefore cannot discriminate a quote-escaping
    // regression via this parser -- confirmed empirically: neutering
    // escapeMarkup() to escape only '<'/'>'/'&' (leaving quotes raw)
    // still passed both a "she said \"hi\"" and an "it's a trap" round
    // trip case unchanged, while every case below (which all contain a
    // real angle bracket or ampersand) failed as expected. The
    // quote-escaping CONTRACT itself is still directly and correctly
    // pinned by escapeMarkup()'s own dedicated tests above (`escapeMarkup:
    // "` / `escapeMarkup: '`); it just isn't a Pango-parser-level
    // discriminator, so it doesn't belong in a section whose entire
    // premise is "assertions the string-only tests above couldn't make."
    // Realistic quote-bearing labels are still exercised here, but each
    // one also carries a real markup metacharacter so the case remains a
    // genuine discriminator for THIS parser-level claim.
    const roundTripCases = [
      { name: 'bold-tag payload', city: '<b>evil</b>' },
      { name: 'ampersand', city: 'Fish & Chips' },
      { name: 'quoted text containing a fake bold tag', city: 'She said "<b>hi</b>"' },
      { name: "apostrophe text containing a fake italic tag", city: "It's <i>tricky</i>, isn't it" },
      { name: 'span/foreground payload', city: '<span foreground="red">gotcha</span>' },
    ];

    for (const { name, city } of roundTripCases) {
      test(`buildEntryMarkup + Pango.parse_markup: ${name} parses without error`, () => {
        const markup = buildEntryMarkup({ city, zone: 'UTC', time: '12:00' }, DEFAULT_FORMATTING);
        const [ok] = parseMarkup(markup);
        assertTrue(ok, `Pango failed to parse markup for ${JSON.stringify(city)}: ${markup}`);
      });

      test(`buildEntryMarkup + Pango.parse_markup: ${name} recovers as literal inert text, not applied formatting`, () => {
        const markup = buildEntryMarkup({ city, zone: 'UTC', time: '12:00' }, DEFAULT_FORMATTING);
        const [, attrList, text] = parseMarkup(markup);
        // The payload's raw characters (Pango decodes the &lt;/&gt;/&amp;/
        // &quot;/&apos; entities buildEntryMarkup() emitted back to literal
        // characters in its plain-text output) must appear VERBATIM in the
        // recovered text -- proving Pango treated them as inert content,
        // not as markup structure it interpreted/stripped/altered.
        assertTrue(text.includes(city), `recovered text did not contain the literal payload verbatim: ${JSON.stringify(text)}`);
        // The real, structural check: DEFAULT_FORMATTING applies no bold/
        // size/color, so a correctly-escaped payload must produce ZERO
        // Pango attributes -- if the fake <b>/<span> tag embedded in this
        // payload were ever interpreted as real markup instead of inert
        // text, Pango would report at least one attribute here.
        assertEqual(attrCount(attrList), 0, `expected zero Pango attributes for an escaped hostile payload, got ${attrCount(attrList)}: ${markup}`);
      });
    }

    test('buildEntryMarkup + Pango.parse_markup: unmatched-tag payload still parses safely (fully escaped, no raw markup reaches Pango)', () => {
      const markup = buildEntryMarkup({ city: '<b>unmatched', zone: 'UTC', time: '12:00' }, DEFAULT_FORMATTING);
      const [ok, attrList, text] = parseMarkup(markup);
      assertTrue(ok, `Pango failed to parse markup for unmatched-tag payload: ${markup}`);
      assertTrue(text.includes('<b>unmatched'), `recovered text did not contain the literal unmatched-tag payload: ${JSON.stringify(text)}`);
      assertEqual(attrCount(attrList), 0, `expected zero Pango attributes for an escaped unmatched-tag payload, got ${attrCount(attrList)}: ${markup}`);
    });

    test('buildEntryMarkup + Pango.parse_markup: a REAL <b> tag from boldCity produces actual bold Pango attributes, unlike the escaped payload above', () => {
      const markup = buildEntryMarkup({ city: 'Real', zone: 'UTC', time: '12:00' }, { ...DEFAULT_FORMATTING, boldCity: true });
      const [ok, attrList, text] = parseMarkup(markup);
      assertTrue(ok, `Pango failed to parse markup: ${markup}`);
      assertEqual(text, 'Real UTC 12:00');
      // Pango.parse_markup() returns a real, non-null AttrList EVEN FOR
      // PLAIN TEXT WITH NO MARKUP AT ALL (verified empirically: parsing
      // "plain text" -> a non-null, EMPTY AttrList, length 0). A
      // presence/non-nullness check on `attrList` therefore passes
      // identically whether or not this <b> tag was actually interpreted
      // -- it is not a real control. The actual, discriminating control
      // is the ATTRIBUTE COUNT: a real, interpreted <b> tag must produce
      // exactly one Pango attribute (a bold-weight attribute over the
      // "Real" run), proving the parser CAN and DOES apply formatting
      // when asked to -- which is what makes the zero-attribute
      // assertions on the escaped hostile payloads above meaningful
      // rather than vacuous.
      assertEqual(attrCount(attrList), 1, `expected exactly one Pango attribute (bold weight) for a real <b> tag, got ${attrCount(attrList)}: ${markup}`);
    });

    test('buildEntryMarkup + Pango.parse_markup: size+color attributes on a hostile-color-carrying blob parse safely', () => {
      const fmt = parseFormatting(JSON.stringify({ size: 14, color: '#fff" foreground="red', boldCity: true }));
      const markup = buildEntryMarkup({ city: '<span>evil</span>', zone: 'UTC', time: '12:00' }, fmt);
      const [ok, attrList, text] = parseMarkup(markup);
      assertTrue(ok, `Pango failed to parse markup: ${markup}`);
      assertTrue(text.includes('<span>evil</span>'), `recovered text did not contain the literal payload: ${JSON.stringify(text)}`);
      // Real, legitimate formatting is in play here (size: 14 -> a real
      // outer <span size="..."> attribute; boldCity: true -> a real <b>
      // attribute over the city run), so a zero-attribute assertion
      // would be WRONG for this case -- unlike the pure-injection cases
      // above. The malicious color (quote-injection) sanitizes to '' and
      // contributes no attribute at all, and the hostile
      // "<span>evil</span>" city text is fully escaped/inert, so exactly
      // TWO real attributes are expected: the outer size span and the
      // <b> weight -- not three (which a leaked foreground attribute
      // would produce) and not zero (which would mean the legitimate
      // size/bold formatting was itself broken).
      assertEqual(attrCount(attrList), 2, `expected exactly two Pango attributes (size + bold weight), got ${attrCount(attrList)}: ${markup}`);
    });
  }
}

// ---------------------------------------------------------------------
// resolveSeparatorValue
// ---------------------------------------------------------------------

test('resolveSeparatorValue: curated id resolves to its curated value', () => {
  assertEqual(resolveSeparatorValue('pipe'), getSeparatorById('pipe').value);
});

test('resolveSeparatorValue: empty string means "no override" (null)', () => {
  assertEqual(resolveSeparatorValue(''), null);
});

test('resolveSeparatorValue: non-string means "no override" (null)', () => {
  assertEqual(resolveSeparatorValue(undefined), null);
  assertEqual(resolveSeparatorValue(null), null);
  assertEqual(resolveSeparatorValue(42), null);
});

test('resolveSeparatorValue: unrecognized literal is returned as-is when short', () => {
  assertEqual(resolveSeparatorValue('~~~'), '~~~');
});

test('resolveSeparatorValue: unrecognized literal is capped at 32 characters', () => {
  const long = 'x'.repeat(100);
  const result = resolveSeparatorValue(long);
  assertTrue(result.length <= 32, `length ${result.length} exceeds cap`);
  assertEqual(result, long.slice(0, 32));
});

test('resolveSeparatorValue: markup-metacharacter literal is returned verbatim (capped), not escaped -- escaping is the caller\'s job', () => {
  // Discriminates against resolveSeparatorValue() itself, not escapeMarkup()
  // (already exhaustively covered elsewhere in this file): a markup-
  // metacharacter-bearing literal under the 32-char cap must come back
  // byte-identical, unescaped -- resolveSeparatorValue() only resolves/
  // bounds the value (see its doc comment in separators.js); it must never
  // silently start escaping, which would break the caller's own single
  // escapeMarkup() call site (_updateLabel() in extension.js) by
  // double-escaping. This is the security-relevant boundary: proving
  // resolveSeparatorValue() does NOT escape is exactly why callers are
  // required to escape its output themselves.
  const malicious = '<span foreground="red">';
  assertEqual(resolveSeparatorValue(malicious), malicious);
});

// ---------------------------------------------------------------------
// global formatting-defaults round trip (Phase 3 menu controls)
// ---------------------------------------------------------------------

test('serializeFormatting/parseFormatting: round-trips a representative global-defaults object', () => {
  const defaults = { size: 14, color: '#3584e4', boldCity: true, boldTime: false, boldZone: true };
  const serialized = serializeFormatting(defaults);
  const roundTripped = parseFormatting(serialized);
  assertEqual(roundTripped, defaults);
});

// KAREN-GATE FIX (round 4): these two used to iterate formattingPresets.js's
// FONT_SIZE_PRESETS/COLOR_PALETTE (now removed, see the module-comment
// note near this file's imports). Representative sample values, matching
// the actual former preset values so no real coverage is lost, are used
// directly instead -- this test's purpose was always "does a real
// sanitizeFontSize()/sanitizeColor()-valid value round-trip through
// serializeFormatting()/parseFormatting() unchanged," not "does the
// specific former UI's preset list round-trip."
const SAMPLE_FONT_SIZES = [0, 8, 9, 10, 11, 12, 14, 16, 20, 24];
const SAMPLE_COLORS = ['', '#ffffff', '#888888', '#e01b24', '#ff7800', '#f6d32d', '#33d17a', '#3584e4', '#9141ac'];

test('serializeFormatting/parseFormatting: round-trips a representative sample of valid font sizes as a global default', () => {
  for (const size of SAMPLE_FONT_SIZES) {
    assertEqual(sanitizeFontSize(size), size, `sample font size ${size} is not itself a valid sanitizeFontSize() output (test data problem)`);
    const defaults = { ...DEFAULT_FORMATTING, size };
    assertEqual(parseFormatting(serializeFormatting(defaults)), defaults);
  }
});

test('serializeFormatting/parseFormatting: round-trips a representative sample of valid colors as a global default', () => {
  for (const color of SAMPLE_COLORS) {
    assertEqual(sanitizeColor(color), color, `sample color ${JSON.stringify(color)} is not itself a valid sanitizeColor() output (test data problem)`);
    const defaults = { ...DEFAULT_FORMATTING, color };
    assertEqual(parseFormatting(serializeFormatting(defaults)), defaults);
  }
});

// ---------------------------------------------------------------------
// setZoneFormatting -- read-modify-write of the 'formatting' a{ss} map
// (Phase 4: prefs.js per-zone controls)
// ---------------------------------------------------------------------

test('setZoneFormatting: setting one zone preserves an unrelated existing zone', () => {
  const before = { 'America/New_York': serializeFormatting({ ...DEFAULT_FORMATTING, size: 12 }) };
  const after = setZoneFormatting(before, 'Europe/London', { ...DEFAULT_FORMATTING, boldCity: true });
  assertEqual(after['America/New_York'], before['America/New_York']);
  assertEqual(parseFormatting(after['Europe/London']), { ...DEFAULT_FORMATTING, boldCity: true });
});

test('setZoneFormatting: does not mutate the input map', () => {
  const before = { UTC: serializeFormatting(DEFAULT_FORMATTING) };
  const beforeSnapshot = { ...before };
  setZoneFormatting(before, 'UTC', { ...DEFAULT_FORMATTING, size: 20 });
  assertEqual(before, beforeSnapshot);
});

test('setZoneFormatting: stored value is a sanitized JSON string', () => {
  const after = setZoneFormatting({}, 'UTC', { size: 999999, color: 'not-a-color', boldCity: 'yes' });
  assertTrue(typeof after.UTC === 'string', 'expected a string value');
  assertEqual(JSON.parse(after.UTC), sanitizeFormatting({ size: 999999, color: 'not-a-color', boldCity: 'yes' }));
});

test('setZoneFormatting: passing null REMOVES the zone entry (falls back to defaults)', () => {
  const before = { UTC: serializeFormatting({ ...DEFAULT_FORMATTING, size: 12 }), Other: serializeFormatting(DEFAULT_FORMATTING) };
  const after = setZoneFormatting(before, 'UTC', null);
  assertFalse(Object.prototype.hasOwnProperty.call(after, 'UTC'), 'UTC entry should be removed');
  assertTrue(Object.prototype.hasOwnProperty.call(after, 'Other'), 'unrelated Other entry should survive');
});

test('setZoneFormatting: passing undefined also removes the zone entry', () => {
  const before = { UTC: serializeFormatting({ ...DEFAULT_FORMATTING, size: 12 }) };
  const after = setZoneFormatting(before, 'UTC', undefined);
  assertFalse(Object.prototype.hasOwnProperty.call(after, 'UTC'));
});

test('setZoneFormatting: passing a neutral (all-default) blob removes the entry rather than storing it', () => {
  const before = { UTC: serializeFormatting({ ...DEFAULT_FORMATTING, size: 12 }) };
  const after = setZoneFormatting(before, 'UTC', { ...DEFAULT_FORMATTING });
  assertFalse(Object.prototype.hasOwnProperty.call(after, 'UTC'), 'neutral blob should not be stored');
});

test('setZoneFormatting: removing a zone that was never present is a safe no-op', () => {
  const before = { UTC: serializeFormatting({ ...DEFAULT_FORMATTING, size: 12 }) };
  const after = setZoneFormatting(before, 'Europe/London', null);
  assertEqual(after, before);
});

test('setZoneFormatting: setting a non-neutral value round-trips through parseFormatting', () => {
  const after = setZoneFormatting({}, 'Asia/Tokyo', { ...DEFAULT_FORMATTING, color: '#ff0000', boldTime: true });
  assertEqual(parseFormatting(after['Asia/Tokyo']), { ...DEFAULT_FORMATTING, color: '#ff0000', boldTime: true });
});

test('setZoneFormatting: undefined input map treated as empty', () => {
  const after = setZoneFormatting(undefined, 'UTC', { ...DEFAULT_FORMATTING, size: 10 });
  assertEqual(parseFormatting(after.UTC), { ...DEFAULT_FORMATTING, size: 10 });
});

// ---------------------------------------------------------------------
// rgbaToHex -- GTK RGBA float -> '#rrggbb' conversion (Phase 4: color
// picker widgets)
// ---------------------------------------------------------------------

test('rgbaToHex: black (0,0,0)', () => assertEqual(rgbaToHex({ red: 0, green: 0, blue: 0 }), '#000000'));
test('rgbaToHex: white (1,1,1)', () => assertEqual(rgbaToHex({ red: 1, green: 1, blue: 1 }), '#ffffff'));
test('rgbaToHex: pure red', () => assertEqual(rgbaToHex({ red: 1, green: 0, blue: 0 }), '#ff0000'));
test('rgbaToHex: pure green', () => assertEqual(rgbaToHex({ red: 0, green: 1, blue: 0 }), '#00ff00'));
test('rgbaToHex: pure blue', () => assertEqual(rgbaToHex({ red: 0, green: 0, blue: 1 }), '#0000ff'));
test('rgbaToHex: midpoint 0.5 rounds to 0x80', () =>
  assertEqual(rgbaToHex({ red: 0.5, green: 0.5, blue: 0.5 }), '#808080'));
test('rgbaToHex: rounding boundary just below a half-step rounds down', () => {
  // 127/255 = 0.498..., rounds to 127 (0x7f), not 128.
  assertEqual(rgbaToHex({ red: 127 / 255 - 0.001, green: 0, blue: 0 }), '#7f0000');
});
test('rgbaToHex: rounding boundary just above a half-step rounds up', () => {
  // 128/255 = 0.50196..., rounds to 128 (0x80), not 127.
  assertEqual(rgbaToHex({ red: 128 / 255, green: 0, blue: 0 }), '#800000');
});
test('rgbaToHex: out-of-range negative float clamps to 0', () =>
  assertEqual(rgbaToHex({ red: -0.5, green: 0, blue: 0 }), '#000000'));
test('rgbaToHex: out-of-range >1 float clamps to 1', () =>
  assertEqual(rgbaToHex({ red: 1.5, green: 0, blue: 0 }), '#ff0000'));
test('rgbaToHex: missing/undefined channels treated as 0', () => assertEqual(rgbaToHex({}), '#000000'));
test('rgbaToHex: NaN channel treated as 0', () => assertEqual(rgbaToHex({ red: NaN, green: 0, blue: 0 }), '#000000'));
test('rgbaToHex: alpha field is ignored', () =>
  assertEqual(rgbaToHex({ red: 1, green: 1, blue: 1, alpha: 0 }), '#ffffff'));

test('rgbaToHex: every output survives sanitizeColor unchanged', () => {
  const samples = [
    { red: 0, green: 0, blue: 0 },
    { red: 1, green: 1, blue: 1 },
    { red: 0.5, green: 0.25, blue: 0.75 },
    { red: 1.5, green: -1, blue: 0.3333 },
  ];
  for (const sample of samples) {
    const hex = rgbaToHex(sample);
    assertEqual(sanitizeColor(hex), hex, `sanitizeColor changed ${hex}`);
  }
});

// ---------------------------------------------------------------------
// getEffectiveFormatting -- per-zone -> defaults -> DEFAULT_FORMATTING
// precedence (Phase 4: shared by extension.js and prefs.js)
// ---------------------------------------------------------------------

test('getEffectiveFormatting: per-zone override wins over defaults', () => {
  const perZone = { ...DEFAULT_FORMATTING, size: 20 };
  const defaults = { ...DEFAULT_FORMATTING, size: 10 };
  assertEqual(getEffectiveFormatting('UTC', { UTC: perZone }, defaults), perZone);
});

test('getEffectiveFormatting: falls back to global defaults when no per-zone override', () => {
  const defaults = { ...DEFAULT_FORMATTING, color: '#ff0000' };
  assertEqual(getEffectiveFormatting('UTC', {}, defaults), defaults);
});

test('getEffectiveFormatting: falls back to DEFAULT_FORMATTING when defaults is falsy', () => {
  assertEqual(getEffectiveFormatting('UTC', {}, null), DEFAULT_FORMATTING);
  assertEqual(getEffectiveFormatting('UTC', {}, undefined), DEFAULT_FORMATTING);
});

test('getEffectiveFormatting: a partially-specified per-zone override is returned whole (no field-merge)', () => {
  const partial = { ...DEFAULT_FORMATTING, boldCity: true };
  const defaults = { ...DEFAULT_FORMATTING, size: 16, color: '#00ff00' };
  const result = getEffectiveFormatting('UTC', { UTC: partial }, defaults);
  assertEqual(result, partial);
  // Confirms it is NOT merged with defaults -- size/color stay neutral,
  // matching the documented "no per-field merge" behavior.
  assertEqual(result.size, 0);
  assertEqual(result.color, '');
});

test('getEffectiveFormatting: falsy formattingMap treated as no override', () => {
  const defaults = { ...DEFAULT_FORMATTING, size: 14 };
  assertEqual(getEffectiveFormatting('UTC', null, defaults), defaults);
  assertEqual(getEffectiveFormatting('UTC', undefined, defaults), defaults);
});

// ---------------------------------------------------------------------
// getEffectiveFormatting -- REGRESSION: must accept a raw-JSON-string map
// (prefs.js's shape) or a pre-parsed-object map (extension.js's shape)
// and return an EQUIVALENT normalized object either way. This is the
// exact invariant that was violated: prefs.js's readFormattingMap()
// returns the raw 'formatting' a{ss} map (values are JSON strings), so
// for any zone with an existing override, getEffectiveFormatting() used
// to hand back that raw JSON STRING verbatim instead of a parsed object
// -- every prefs.js widget then silently displayed neutral defaults
// (size 0, color '', all bold off) instead of the zone's real saved
// values, for the mainline case of reopening prefs on an
// already-customized zone. extension.js never hit this because
// _loadSettings() happens to pre-parse every entry before calling this
// function -- an implicit "caller must pre-parse" contract that was
// never enforced or even documented until this bug.
// ---------------------------------------------------------------------

test('getEffectiveFormatting: per-zone override as a raw JSON STRING (prefs.js shape) is parsed, not returned verbatim', () => {
  const fmt = { size: 24, color: '#123456', boldCity: true, boldTime: false, boldZone: true };
  const stringMap = { UTC: serializeFormatting(fmt) };
  const result = getEffectiveFormatting('UTC', stringMap, DEFAULT_FORMATTING);
  assertTrue(typeof result === 'object' && result !== null, `expected a parsed object, got ${JSON.stringify(result)} (typeof ${typeof result})`);
  assertEqual(result, fmt);
});

test('getEffectiveFormatting: raw-JSON-string map and pre-parsed-object map yield an EQUIVALENT result for the same zone', () => {
  const fmt = { size: 24, color: '#123456', boldCity: true, boldTime: false, boldZone: true };
  const stringMap = { UTC: serializeFormatting(fmt) };
  const objectMap = { UTC: sanitizeFormatting(fmt) };
  assertEqual(getEffectiveFormatting('UTC', stringMap, DEFAULT_FORMATTING), getEffectiveFormatting('UTC', objectMap, DEFAULT_FORMATTING));
});

test('getEffectiveFormatting: formattingDefaults as a raw JSON STRING (GSettings shape) is parsed, not returned verbatim', () => {
  const defaults = { ...DEFAULT_FORMATTING, size: 18, boldTime: true };
  const result = getEffectiveFormatting('UTC', {}, serializeFormatting(defaults));
  assertTrue(typeof result === 'object' && result !== null, `expected a parsed object, got ${JSON.stringify(result)} (typeof ${typeof result})`);
  assertEqual(result, defaults);
});

test('getEffectiveFormatting: raw-JSON-string defaults and pre-parsed-object defaults yield an EQUIVALENT result', () => {
  const defaults = { ...DEFAULT_FORMATTING, size: 18, boldTime: true };
  assertEqual(
    getEffectiveFormatting('UTC', {}, serializeFormatting(defaults)),
    getEffectiveFormatting('UTC', {}, sanitizeFormatting(defaults))
  );
});

test('getEffectiveFormatting: empty-string formattingDefaults (schema default, "no defaults set") still falls back to DEFAULT_FORMATTING-equivalent values', () => {
  assertEqual(getEffectiveFormatting('UTC', {}, ''), DEFAULT_FORMATTING);
});

// ---------------------------------------------------------------------
// Phase 5: backward-compatibility with a pre-existing user's saved
// settings -- the single most important regression guarantee for
// existing users.
//
// Simulates an "existing user" GSettings snapshot: 'timezones'/'config'/
// 'labels' populated exactly as a pre-Phase-1 user would have them, with
// NONE of the Phase 1-4 keys ('separator', 'formatting',
// 'formatting-defaults') ever touched -- i.e. still holding their real
// schema defaults. Constructs a REAL Gio.Settings against the actual
// compiled schema (schemas/gschemas.compiled) rather than assuming what
// those defaults are, so a future accidental change to the schema
// defaults themselves would also be caught here, not just a regression in
// the read/render pipeline. GSETTINGS_BACKEND=memory is forced above
// before this Gio.Settings (or any other in this process) is
// constructed, so this never touches dconf.
//
// Asserts the full pipeline -- schema defaults -> parseFormatting/
// resolveSeparatorValue -> buildEntryText/buildEntryMarkup -- renders
// BYTE-IDENTICAL output to the known pre-Phase-2 legacy format, for both
// values of the legacy 'showSeparator' config boolean.
// ---------------------------------------------------------------------

{
  const SCRIPT_PATH = GLib.filename_from_uri(import.meta.url)[0];
  const TESTS_DIR = GLib.path_get_dirname(SCRIPT_PATH);
  const REPO_DIR = GLib.path_get_dirname(TESTS_DIR);
  const SCHEMA_DIR = GLib.build_filenamev([REPO_DIR, 'schemas']);
  const SCHEMA_ID = 'org.gnome.shell.extensions.timezones';

  function newLegacySettings() {
    const source = Gio.SettingsSchemaSource.new_from_directory(SCHEMA_DIR, Gio.SettingsSchemaSource.get_default(), false);
    const schema = source.lookup(SCHEMA_ID, true);
    const settings = new Gio.Settings({ settings_schema: schema });

    // An "existing user" snapshot: only the pre-Phase-1 keys are ever
    // written. 'labels' carries one real custom label (Feature B existed
    // before this formatting work), matching what a real long-time user's
    // dconf entry would look like.
    settings.set_strv('timezones', ['UTC', 'America/New_York']);
    settings.set_value('config', new GLib.Variant('a{sb}', { format24: true, showCity: true, showTimezone: true, hideSystemClock: false, showSeparator: true }));
    settings.set_value('labels', new GLib.Variant('a{ss}', { 'America/New_York': 'Home' }));
    // Deliberately NOT calling set_string('separator', ...),
    // set_value('formatting', ...), or set_string('formatting-defaults',
    // ...) -- this is the entire point of the test.
    return settings;
  }

  test('backward compat: separator/formatting/formatting-defaults are still exactly their schema defaults for an untouched-by-new-features user', () => {
    const settings = newLegacySettings();
    assertEqual(settings.get_string('separator'), '');
    assertEqual(settings.get_value('formatting').deep_unpack(), {});
    assertEqual(settings.get_string('formatting-defaults'), '');
  });

  test('backward compat: resolveSeparatorValue(schema-default separator) is null, signaling "use legacy showSeparator fallback"', () => {
    const settings = newLegacySettings();
    assertEqual(resolveSeparatorValue(settings.get_string('separator')), null);
  });

  test('backward compat: parseFormatting(schema-default formatting-defaults) is exactly DEFAULT_FORMATTING (neutral appearance)', () => {
    const settings = newLegacySettings();
    assertEqual(parseFormatting(settings.get_string('formatting-defaults')), DEFAULT_FORMATTING);
  });

  test('backward compat: getEffectiveFormatting for an untouched zone is exactly DEFAULT_FORMATTING', () => {
    const settings = newLegacySettings();
    const formattingMap = settings.get_value('formatting').deep_unpack();
    const defaults = parseFormatting(settings.get_string('formatting-defaults'));
    assertEqual(getEffectiveFormatting('UTC', formattingMap, defaults), DEFAULT_FORMATTING);
    assertEqual(getEffectiveFormatting('America/New_York', formattingMap, defaults), DEFAULT_FORMATTING);
  });

  test('formatting.js: buildEntryText output for a city/zone/time triple matches the known pre-Phase-2 legacy format string exactly', () => {
    // Renamed from a "backward compat:" prefix (2026-07 karen gate finding):
    // every OTHER "backward compat:" test in this describe block actually
    // constructs a Gio.Settings instance via newLegacySettings() and reads
    // schema-default values through it -- that name implies the same here,
    // but this test is pure: it calls buildEntryText() directly with
    // hand-built segments and never touches Gio.Settings at all. Renamed so
    // the name matches what it verifies (formatting.js's pure assembly
    // logic), not a settings/schema guarantee. Mirrors
    // _computeEntrySegments()'s pre-existing decision logic (extension.js)
    // for a zone with a custom label, zone abbreviation shown, and a fixed
    // time -- this is the exact `${city} ${zone} ${time}` shape documented
    // at the top of formatting.js as byte-identical to the pre-Phase-2
    // `_getLabelForTimezone` output.
    const segments = { city: 'Home', zone: 'EST', time: '3:00 PM' };
    assertEqual(buildEntryText(segments), 'Home EST 3:00 PM');
  });

  test('backward compat: buildEntryMarkup with DEFAULT_FORMATTING for an untouched zone equals the escaped legacy plain-text string, with no <span>/<b> markup at all', () => {
    const settings = newLegacySettings();
    const formattingMap = settings.get_value('formatting').deep_unpack();
    const defaults = parseFormatting(settings.get_string('formatting-defaults'));
    const effective = getEffectiveFormatting('America/New_York', formattingMap, defaults);

    const segments = { city: 'Home', zone: 'EST', time: '3:00 PM' };
    const markup = buildEntryMarkup(segments, effective);

    assertEqual(markup, 'Home EST 3:00 PM');
    assertFalse(markup.includes('<span'), markup);
    assertFalse(markup.includes('<b>'), markup);
  });

  test('backward compat: legacy showSeparator=true fallback ("_resolveSeparatorValue" logic) joins panel entries with " | ", exactly like pre-Phase-2', () => {
    const settings = newLegacySettings();
    const config = settings.get_value('config').deep_unpack();
    const resolved = resolveSeparatorValue(settings.get_string('separator'));
    const separatorValue = resolved !== null ? resolved : (config.showSeparator ? ' | ' : '    ');
    assertEqual(separatorValue, ' | ');

    const entries = [
      buildEntryText({ city: 'UTC', zone: null, time: '12:00 PM' }),
      buildEntryText({ city: 'Home', zone: 'EST', time: '7:00 AM' }),
    ];
    assertEqual(entries.join(separatorValue), 'UTC 12:00 PM | Home EST 7:00 AM');
  });

  test('backward compat: legacy showSeparator=false fallback joins panel entries with four spaces, exactly like pre-Phase-2', () => {
    const settings = newLegacySettings();
    settings.set_value('config', new GLib.Variant('a{sb}', { format24: true, showCity: true, showTimezone: true, hideSystemClock: false, showSeparator: false }));
    const config = settings.get_value('config').deep_unpack();
    const resolved = resolveSeparatorValue(settings.get_string('separator'));
    const separatorValue = resolved !== null ? resolved : (config.showSeparator ? ' | ' : '    ');
    assertEqual(separatorValue, '    ');

    const entries = [
      buildEntryText({ city: 'UTC', zone: null, time: '12:00 PM' }),
      buildEntryText({ city: 'Home', zone: 'EST', time: '7:00 AM' }),
    ];
    assertEqual(entries.join(separatorValue), 'UTC 12:00 PM    Home EST 7:00 AM');
  });

  test('backward compat: full assembled panel markup for an untouched two-zone user is byte-identical to the legacy plain-text join, just escaped', () => {
    const settings = newLegacySettings(); // showSeparator: true
    const formattingMap = settings.get_value('formatting').deep_unpack();
    const defaults = parseFormatting(settings.get_string('formatting-defaults'));
    const config = settings.get_value('config').deep_unpack();
    const resolved = resolveSeparatorValue(settings.get_string('separator'));
    const separatorValue = resolved !== null ? resolved : (config.showSeparator ? ' | ' : '    ');

    const zoneSegments = [
      { zone: 'UTC', city: 'UTC', tzZone: null, time: '12:00 PM' },
      { zone: 'America/New_York', city: 'Home', tzZone: 'EST', time: '7:00 AM' },
    ];

    const plainText = zoneSegments
      .map(({ city, tzZone, time }) => buildEntryText({ city, zone: tzZone, time }))
      .join(separatorValue);

    const markup = zoneSegments
      .map(({ zone, city, tzZone, time }) => buildEntryMarkup({ city, zone: tzZone, time }, getEffectiveFormatting(zone, formattingMap, defaults)))
      .join(escapeMarkup(separatorValue));

    assertEqual(plainText, 'UTC 12:00 PM | Home EST 7:00 AM');
    assertEqual(markup, plainText, 'markup must equal the plain legacy text verbatim -- no <span>/<b>/attribute ever appears for an untouched user');
  });
}

// ---------------------------------------------------------------------
// Phase 5: crafted-input pass across the whole pipeline, prefs.js WRITE
// path -> real GSettings -> extension.js READ path, end to end.
//
// Individual pieces of this pipeline are already covered elsewhere:
// prefs.js's actual widget-driven writes are exercised against real
// GSettings in tests/run-prefs-tests.js (via setZoneFormatting()/
// serializeFormatting(), the same functions prefs.js itself calls), and
// extension.js's read-side parsing (parseFormatting()/
// getEffectiveFormatting()) and rendering (buildEntryMarkup()) are each
// covered individually above. This section closes the gap between them:
// it writes a CRAFTED (hostile/extreme) value through the exact same
// write-path functions prefs.js uses, into a REAL Gio.Settings backed by
// the actual compiled schema, then reads it back through the exact same
// read-path functions extension.js uses, and confirms the final rendered
// markup is safe -- proving no gap exists between "prefs.js sanitizes
// before writing" and "extension.js sanitizes before rendering" where an
// unsanitized value could slip through the GSettings round-trip itself
// (e.g. via GVariant type coercion, or a value written by some other
// process entirely -- see the 'formatting' key's a{ss} type, which has no
// schema-level constraint on its JSON-string values).
// ---------------------------------------------------------------------

{
  const SCRIPT_PATH = GLib.filename_from_uri(import.meta.url)[0];
  const TESTS_DIR = GLib.path_get_dirname(SCRIPT_PATH);
  const REPO_DIR = GLib.path_get_dirname(TESTS_DIR);
  const SCHEMA_DIR = GLib.build_filenamev([REPO_DIR, 'schemas']);
  const SCHEMA_ID = 'org.gnome.shell.extensions.timezones';

  function newSettings() {
    const source = Gio.SettingsSchemaSource.new_from_directory(SCHEMA_DIR, Gio.SettingsSchemaSource.get_default(), false);
    const schema = source.lookup(SCHEMA_ID, true);
    return new Gio.Settings({ settings_schema: schema });
  }

  const craftedLabels = [
    '<b>evil</b>',
    'Fish & Chips "quoted" & \'apos\'',
    '<span foreground="red" size="99999999">huge</span>',
    '<b>unmatched',
    'Robert"); DROP TABLE zones;--',
  ];

  const craftedFormattingBlobs = [
    { size: '<script>', color: 'javascript:alert(1)', boldCity: '<b>', boldTime: {}, boldZone: [] },
    { size: 999999999, color: '#fff" foreground="red', boldCity: 'yes', boldTime: 1, boldZone: 'true' },
    { size: -999999, color: 'red<span>', boldCity: null, boldTime: undefined, boldZone: NaN },
  ];

  for (const label of craftedLabels) {
    for (const blob of craftedFormattingBlobs) {
      test(`full pipeline (prefs.js write -> GSettings -> extension.js read): label ${JSON.stringify(label)} + blob ${JSON.stringify(blob)} renders safely`, () => {
        const settings = newSettings();
        settings.set_strv('timezones', ['UTC']);

        // --- WRITE PATH: exactly what prefs.js's commitField()/global
        // default handlers do -- setZoneFormatting() for the per-zone map,
        // serializeFormatting() for the global-defaults string. Neither
        // pre-sanitizes its input; sanitization happens INSIDE these calls
        // (see formatting.js), matching prefs.js's actual behavior of
        // passing raw widget values straight through.
        const writtenMap = setZoneFormatting({}, 'UTC', blob);
        settings.set_value('formatting', new GLib.Variant('a{ss}', writtenMap));
        settings.set_string('formatting-defaults', serializeFormatting(blob));
        settings.set_value('labels', new GLib.Variant('a{ss}', { UTC: label }));

        // --- READ PATH: exactly what extension.js's _loadSettings() /
        // _getEffectiveFormatting() / _sanitizeLabel()-equivalent handling
        // does -- re-read from GSettings, re-parse/re-sanitize
        // defensively (never trusting a value already sanitized once,
        // since the a{ss}/s types have no schema-level content
        // constraint).
        const formattingMap = settings.get_value('formatting').deep_unpack();
        const defaults = parseFormatting(settings.get_string('formatting-defaults'));
        const effective = getEffectiveFormatting('UTC', formattingMap, defaults);
        const labelsMap = settings.get_value('labels').deep_unpack();
        const readLabel = labelsMap.UTC;

        // --- RENDER: buildEntryMarkup() re-sanitizes `effective`
        // defensively regardless (see its own doc comment), and escapes
        // every text segment -- this is the actual safety boundary being
        // tested end to end.
        const markup = buildEntryMarkup({ city: readLabel, zone: 'UTC', time: '12:00' }, effective);

        const stripped = stripBuilderTags(markup);
        assertFalse(/[<>]/.test(stripped), `unescaped angle bracket survived full pipeline: ${markup}`);
        // Any quote-injection attempt in the color must never leave a
        // stray, unquoted 'foreground='/'size=' attribute fragment in the
        // output -- either the whole attribute is well-formed and
        // properly quoted, or it is absent entirely. This branch is
        // EXHAUSTIVE (an assertion runs on every one of the 15 label x
        // blob combinations, not just the ones that happen to emit a
        // <span>) -- a prior version of this test only asserted inside
        // `if (spanAttrsMatch)`, which silently contributed nothing at
        // all for any combination that sanitized to fully-neutral
        // formatting (no <span> emitted), e.g. the all-hostile-non-
        // boolean-truthy blob above combined with any label.
        const spanAttrsMatch = markup.match(/<span ([^>]*)>/);
        if (spanAttrsMatch) {
          assertTrue(/^(\s*(size|foreground)="[^"]*")+\s*$/.test(spanAttrsMatch[1].trim()), `malformed <span> attributes: ${spanAttrsMatch[1]}`);
        } else {
          // Matches literal, UNESCAPED `size="`/`foreground="` attribute
          // syntax only -- deliberately does NOT match the escaped text
          // `foreground=&quot;...&quot;` that a fully-inert hostile label
          // like '<span foreground="red">...' legitimately produces
          // (escapeMarkup() turns its `"` into `&quot;`, so the substring
          // 'foreground=' followed by an ESCAPED quote is expected,
          // correct, inert text content, not a leaked real attribute).
          assertFalse(/(size|foreground)="/.test(markup), `no well-formed <span> was emitted, but a stray real size=/foreground= attribute fragment leaked outside one: ${markup}`);
        }
      });
    }
  }

  // Dynamic import resolved here (top-level await, outside test()) rather
  // than inside the test callback below -- the test()/record() harness
  // runs `fn()` synchronously and does not await a returned Promise, so an
  // async test callback would be recorded as passing immediately
  // regardless of what actually happens inside it.
  let PangoForPipelineTest = null;
  try {
    ({ default: PangoForPipelineTest } = await import('gi://Pango'));
  } catch (e) {
    record('full pipeline: Pango typelib importable for worst-case markup verification', false, e instanceof Error ? e.message : String(e));
  }

  test('full pipeline: real Pango.parse_markup() accepts the worst-case combination (crafted label + crafted blob) without throwing', () => {
    if (!PangoForPipelineTest) {
      throw new Error('Pango not importable in this environment');
    }
    const Pango = PangoForPipelineTest;

    const settings = newSettings();
    settings.set_strv('timezones', ['UTC']);
    const worstBlob = { size: '<script>', color: '#fff" foreground="red', boldCity: '<b>', boldTime: 1, boldZone: 'true' };
    const worstLabel = '<span foreground="red"><b>"evil" & \'stuff\'</b></span>';

    const writtenMap = setZoneFormatting({}, 'UTC', worstBlob);
    settings.set_value('formatting', new GLib.Variant('a{ss}', writtenMap));
    settings.set_value('labels', new GLib.Variant('a{ss}', { UTC: worstLabel }));

    const formattingMap = settings.get_value('formatting').deep_unpack();
    const defaults = parseFormatting(settings.get_string('formatting-defaults'));
    const effective = getEffectiveFormatting('UTC', formattingMap, defaults);
    const labelsMap = settings.get_value('labels').deep_unpack();

    const markup = buildEntryMarkup({ city: labelsMap.UTC, zone: 'UTC', time: '12:00' }, effective);
    const [ok, , text] = Pango.parse_markup(markup, -1, '\0');
    assertTrue(ok, `Pango failed to parse the worst-case full-pipeline markup: ${markup}`);
    assertTrue(text.includes(worstLabel), `recovered text did not contain the literal worst-case payload verbatim: ${JSON.stringify(text)}`);
  });
}

// ---------------------------------------------------------------------
// hoverPopup.js: pure row-model logic for the "Show all zones on hover"
// popup. Uses a fixed `now` per zone (via `nowForZone`) so every
// assertion below is deterministic and never depends on the wall clock
// at test-run time -- the same technique the formatDateForDisplay tests
// above use for a single zone, extended here to per-zone injection since
// buildHoverPopupRows() computes one GLib.DateTime per zone.
// ---------------------------------------------------------------------

test('buildHoverPopupRowText: includes the zone id (no custom label), the zone abbreviation, the time, and the date, in that order', () => {
  const dt = GLib.DateTime.new_utc(2026, 7, 20, 9, 5, 0);
  const text = buildHoverPopupRowText({
    timezone: 'UTC',
    label: undefined,
    format24: true,
    dateFormat: 'iso',
    now: dt,
  });
  assertEqual(text, 'UTC UTC 09:05 (2026-07-20)');
});

test('buildHoverPopupRowText: a custom label is shown as "Label (zone id)", mirroring the "full" menu-row form', () => {
  const dt = GLib.DateTime.new_utc(2026, 7, 20, 9, 5, 0);
  const text = buildHoverPopupRowText({
    timezone: 'UTC',
    label: 'Home',
    format24: true,
    dateFormat: 'iso',
    now: dt,
  });
  assertEqual(text, 'Home (UTC) UTC 09:05 (2026-07-20)');
});

test('buildHoverPopupRowText: respects format24=false (12h clock)', () => {
  const dt = GLib.DateTime.new_utc(2026, 7, 20, 13, 5, 0);
  const text = buildHoverPopupRowText({
    timezone: 'UTC',
    label: undefined,
    format24: false,
    dateFormat: 'iso',
    now: dt,
  });
  assertTrue(text.includes('1:05 PM'), `expected a 12h-formatted time in: ${text}`);
});

test('buildHoverPopupRowText: date segment uses resolveDateFormat() -- a curated id resolves to its real pattern', () => {
  const dt = GLib.DateTime.new_utc(2026, 7, 20, 9, 5, 0);
  const isoText = buildHoverPopupRowText({ timezone: 'UTC', format24: true, dateFormat: 'iso', now: dt });
  const weekdayText = buildHoverPopupRowText({ timezone: 'UTC', format24: true, dateFormat: 'weekday', now: dt });
  assertTrue(isoText.includes('(2026-07-20)'), `expected ISO date addendum in: ${isoText}`);
  assertTrue(weekdayText.includes('(Monday)'), `expected weekday date addendum in: ${weekdayText}`);
  assertFalse(isoText === weekdayText, 'different date-format ids should produce different row text');
});

test('buildHoverPopupRowText: date segment is unconditional -- always appended regardless of any "showDate" concept (this module has no such gate)', () => {
  const dt = GLib.DateTime.new_utc(2026, 7, 20, 9, 5, 0);
  const text = buildHoverPopupRowText({ timezone: 'UTC', format24: true, dateFormat: '', now: dt });
  assertTrue(/\(\d/.test(text), `expected a "(<date...>" addendum to always be present: ${text}`);
});

test('buildHoverPopupRows: returns one row per zone in activeOrder, in EXACT activeOrder order (not alphabetical, not membership-only)', () => {
  const dt = GLib.DateTime.new_utc(2026, 7, 20, 9, 5, 0);
  const activeOrder = ['America/New_York', 'UTC', 'Asia/Tokyo'];
  const knownZones = new Set(['UTC', 'America/New_York', 'Asia/Tokyo']);
  const rows = buildHoverPopupRows({
    activeOrder,
    knownZones,
    labels: {},
    config: { format24: true },
    dateFormat: 'iso',
    nowForZone: () => dt,
  });
  assertEqual(rows.map((r) => r.zone), activeOrder, 'row order must exactly match activeOrder, not any re-sorted order');
});

test('buildHoverPopupRows: reflects a reordered activeOrder (simulating _reorderActiveZone) without any extra work', () => {
  const dt = GLib.DateTime.new_utc(2026, 7, 20, 9, 5, 0);
  const knownZones = new Set(['UTC', 'America/New_York', 'Asia/Tokyo']);
  const before = buildHoverPopupRows({
    activeOrder: ['UTC', 'America/New_York', 'Asia/Tokyo'],
    knownZones,
    labels: {},
    config: { format24: true },
    dateFormat: 'iso',
    nowForZone: () => dt,
  });
  const after = buildHoverPopupRows({
    activeOrder: ['Asia/Tokyo', 'UTC', 'America/New_York'],
    knownZones,
    labels: {},
    config: { format24: true },
    dateFormat: 'iso',
    nowForZone: () => dt,
  });
  assertEqual(before.map((r) => r.zone), ['UTC', 'America/New_York', 'Asia/Tokyo']);
  assertEqual(after.map((r) => r.zone), ['Asia/Tokyo', 'UTC', 'America/New_York']);
});

test('buildHoverPopupRows: an activeOrder entry not present in knownZones (stale/foreign entry) is silently skipped, not a broken row', () => {
  const dt = GLib.DateTime.new_utc(2026, 7, 20, 9, 5, 0);
  const rows = buildHoverPopupRows({
    activeOrder: ['UTC', 'Not/A_Real_Zone', 'Asia/Tokyo'],
    knownZones: new Set(['UTC', 'Asia/Tokyo']),
    labels: {},
    config: { format24: true },
    dateFormat: 'iso',
    nowForZone: () => dt,
  });
  assertEqual(rows.map((r) => r.zone), ['UTC', 'Asia/Tokyo']);
});

test('buildHoverPopupRows: empty activeOrder produces zero rows', () => {
  const rows = buildHoverPopupRows({
    activeOrder: [],
    knownZones: new Set(['UTC']),
    labels: {},
    config: { format24: true },
    dateFormat: 'iso',
  });
  assertEqual(rows, []);
});

test('buildHoverPopupRows: per-zone custom labels are applied from the labels map, not shared across zones', () => {
  const dt = GLib.DateTime.new_utc(2026, 7, 20, 9, 5, 0);
  const rows = buildHoverPopupRows({
    activeOrder: ['UTC', 'Asia/Tokyo'],
    knownZones: new Set(['UTC', 'Asia/Tokyo']),
    labels: { UTC: 'Home' },
    config: { format24: true },
    dateFormat: 'iso',
    nowForZone: () => dt,
  });
  assertTrue(rows[0].text.startsWith('Home (UTC)'), `expected UTC row to use its custom label: ${rows[0].text}`);
  assertTrue(rows[1].text.startsWith('Asia/Tokyo'), `expected Asia/Tokyo row to have no custom label: ${rows[1].text}`);
});

test('buildHoverPopupRows: row text never contains raw markup metacharacters as anything other than literal text (plain-text-only contract)', () => {
  // Not an escaping test (this module never escapes anything -- see its
  // own module-header comment: plain text is rendered via St.Label.text,
  // never parsed as markup, so there is nothing to escape). This instead
  // proves the CONTRACT: whatever a hostile label contains survives
  // completely verbatim (no transformation at all), which is exactly
  // what "never touches the markup surface" means in practice.
  const dt = GLib.DateTime.new_utc(2026, 7, 20, 9, 5, 0);
  const hostileLabel = '<b>evil</b> & "quotes" \'apos\'';
  const rows = buildHoverPopupRows({
    activeOrder: ['UTC'],
    knownZones: new Set(['UTC']),
    labels: { UTC: hostileLabel },
    config: { format24: true },
    dateFormat: 'iso',
    nowForZone: () => dt,
  });
  assertTrue(rows[0].text.includes(hostileLabel), `expected the hostile label to survive completely verbatim: ${rows[0].text}`);
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
