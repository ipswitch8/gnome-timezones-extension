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
} from '../formatting.js';

import {
  SEPARATORS,
  DEFAULT_SEPARATOR_ID,
  getSeparatorById,
  resolveSeparatorValue,
} from '../separators.js';

import {
  FONT_SIZE_PRESETS,
  COLOR_PALETTE,
  resolvePresetId,
} from '../formattingPresets.js';

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

test('resolveSeparatorValue: malicious literal separator is safely neutralized once escaped', () => {
  const malicious = '<span foreground="red">';
  const resolved = resolveSeparatorValue(malicious);
  const escaped = escapeMarkup(resolved);
  assertFalse(/[<>]/.test(escaped), `unescaped angle bracket in ${escaped}`);
});

// ---------------------------------------------------------------------
// formattingPresets: font-size preset ladder
// ---------------------------------------------------------------------

test('formattingPresets: no duplicate font-size preset ids', () => {
  const ids = FONT_SIZE_PRESETS.map((p) => p.id);
  assertEqual(new Set(ids).size, ids.length, 'duplicate font-size preset id found');
});

for (const preset of FONT_SIZE_PRESETS) {
  test(`formattingPresets: font-size preset "${preset.id}" (${preset.value}) survives sanitizeFontSize unchanged`, () => {
    assertEqual(sanitizeFontSize(preset.value), preset.value);
  });
}

// ---------------------------------------------------------------------
// formattingPresets: color palette
// ---------------------------------------------------------------------

test('formattingPresets: no duplicate color palette ids', () => {
  const ids = COLOR_PALETTE.map((p) => p.id);
  assertEqual(new Set(ids).size, ids.length, 'duplicate color palette id found');
});

for (const preset of COLOR_PALETTE) {
  test(`formattingPresets: color palette "${preset.id}" (${JSON.stringify(preset.value)}) survives sanitizeColor unchanged`, () => {
    assertEqual(sanitizeColor(preset.value), preset.value);
  });
}

// ---------------------------------------------------------------------
// formattingPresets: resolvePresetId
// ---------------------------------------------------------------------

test('resolvePresetId: matches a known font-size preset value', () => {
  assertEqual(resolvePresetId(FONT_SIZE_PRESETS, 14), '14');
});

test('resolvePresetId: matches the "Default" font-size preset (0)', () => {
  assertEqual(resolvePresetId(FONT_SIZE_PRESETS, 0), 'default');
});

test('resolvePresetId: unmatched font size (hand-edited dconf value, e.g. 13) degrades to null', () => {
  assertEqual(resolvePresetId(FONT_SIZE_PRESETS, 13), null);
});

test('resolvePresetId: matches a known color palette value', () => {
  assertEqual(resolvePresetId(COLOR_PALETTE, '#3584e4'), 'blue');
});

test('resolvePresetId: matches the "Default" color preset (empty string)', () => {
  assertEqual(resolvePresetId(COLOR_PALETTE, ''), 'default');
});

test('resolvePresetId: unmatched color (hand-edited dconf value, e.g. #123456) degrades to null', () => {
  assertEqual(resolvePresetId(COLOR_PALETTE, '#123456'), null);
});

test('resolvePresetId: empty preset list never throws, degrades to null', () => {
  assertEqual(resolvePresetId([], 'anything'), null);
});

test('resolvePresetId: supports a custom match field (e.g. separator "id")', () => {
  assertEqual(resolvePresetId(SEPARATORS, 'pipe', 'id'), 'pipe');
  assertEqual(resolvePresetId(SEPARATORS, 'does-not-exist', 'id'), null);
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

test('serializeFormatting/parseFormatting: round-trips every font-size preset as a global default', () => {
  for (const preset of FONT_SIZE_PRESETS) {
    const defaults = { ...DEFAULT_FORMATTING, size: preset.value };
    assertEqual(parseFormatting(serializeFormatting(defaults)), defaults);
  }
});

test('serializeFormatting/parseFormatting: round-trips every color preset as a global default', () => {
  for (const preset of COLOR_PALETTE) {
    const defaults = { ...DEFAULT_FORMATTING, color: preset.value };
    assertEqual(parseFormatting(serializeFormatting(defaults)), defaults);
  }
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
