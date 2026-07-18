// formatting.js
//
// Pure escaping/validation/sanitization utilities shared by extension.js
// (rendering) and prefs.js (preferences UI). This module MUST NOT import
// anything from extension.js or prefs.js, and must not import any GNOME
// Shell UI libraries (St, Clutter, etc.) -- only GLib, which is available
// in both the shell process and standalone `gjs` (including the test
// harness under tests/).
//
// Every user-supplied string that will be embedded in Pango markup MUST
// be passed through escapeMarkup() first. Every color/size value that
// will be embedded in a Pango markup attribute MUST be passed through
// sanitizeColor()/sanitizeFontSize() first -- these are treated as
// security boundaries, not merely cosmetic validation.

import GLib from 'gi://GLib';

const MIN_FONT_SIZE = 6;
const MAX_FONT_SIZE = 32;

const HEX_COLOR_RE = /^#[0-9a-f]{6}$/;
const HEX_COLOR_SHORT_RE = /^#[0-9a-f]{3}$/;

export const DEFAULT_FORMATTING = Object.freeze({
  size: 0,
  color: '',
  boldCity: false,
  boldTime: false,
  boldZone: false,
});

/**
 * Escape a value for safe inclusion as Pango markup text content.
 * Handles null/undefined/non-string input safely.
 */
export function escapeMarkup(text) {
  const str = String(text ?? '');
  return GLib.markup_escape_text(str, -1);
}

/**
 * Clamp/validate a font size. Returns an integer point size in
 * [MIN_FONT_SIZE, MAX_FONT_SIZE], or 0 meaning "inherit".
 */
export function sanitizeFontSize(value) {
  let num;

  if (typeof value === 'number') {
    num = value;
  } else if (typeof value === 'string' && value.trim() !== '') {
    num = Number(value);
  } else {
    return 0;
  }

  if (!Number.isFinite(num)) {
    return 0;
  }

  num = Math.trunc(num);

  if (num === 0) {
    return 0;
  }

  if (num < MIN_FONT_SIZE) {
    return MIN_FONT_SIZE;
  }

  if (num > MAX_FONT_SIZE) {
    return MAX_FONT_SIZE;
  }

  return num;
}

/**
 * Validate/normalize a color value to a strict '#rrggbb' lowercase string,
 * or '' meaning "inherit". This is a security boundary: the returned
 * value is embedded directly into a Pango `foreground="..."` attribute,
 * so it is guaranteed to match [0-9a-f#]{4,7} exactly -- it can never
 * contain a quote, angle bracket, or any other character.
 */
export function sanitizeColor(value) {
  if (typeof value !== 'string') {
    return '';
  }

  let str = value.trim().toLowerCase();

  if (str === '') {
    return '';
  }

  // Accept with or without a leading '#'.
  if (!str.startsWith('#')) {
    str = `#${str}`;
  }

  if (HEX_COLOR_RE.test(str)) {
    return str;
  }

  if (HEX_COLOR_SHORT_RE.test(str)) {
    const [, r, g, b] = str;
    return `#${r}${r}${g}${g}${b}${b}`;
  }

  return '';
}

function sanitizeBool(value) {
  return value === true;
}

/**
 * Normalize a possibly-malformed parsed object into a well-formed
 * formatting object with every field sanitized.
 */
export function sanitizeFormatting(obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ...DEFAULT_FORMATTING };
  }

  return {
    size: sanitizeFontSize(obj.size),
    color: sanitizeColor(obj.color),
    boldCity: sanitizeBool(obj.boldCity),
    boldTime: sanitizeBool(obj.boldTime),
    boldZone: sanitizeBool(obj.boldZone),
  };
}

/**
 * Safely parse a JSON-encoded formatting object. Returns normalized
 * defaults on any parse failure or non-object result.
 */
export function parseFormatting(jsonString) {
  if (typeof jsonString !== 'string' || jsonString.trim() === '') {
    return { ...DEFAULT_FORMATTING };
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonString);
  } catch (e) {
    return { ...DEFAULT_FORMATTING };
  }

  return sanitizeFormatting(parsed);
}

/**
 * Sanitize then JSON.stringify a formatting object.
 */
export function serializeFormatting(obj) {
  return JSON.stringify(sanitizeFormatting(obj));
}

// ---------------------------------------------------------------------
// Phase 4: pure helpers shared by extension.js and prefs.js
// ---------------------------------------------------------------------
//
// These three functions are the SINGLE implementation of: (a) the
// per-zone `formatting` a{ss} map's read-modify-write semantics, (b)
// GTK RGBA-float -> '#rrggbb' conversion for color pickers, and (c) the
// per-zone -> global-default -> DEFAULT_FORMATTING precedence rule.
// extension.js's _getEffectiveFormatting() delegates to
// getEffectiveFormatting() below rather than re-implementing the same
// two-line precedence check, so there is exactly one place that rule
// lives.

function isNeutralFormatting(fmt) {
  return (
    fmt.size === DEFAULT_FORMATTING.size &&
    fmt.color === DEFAULT_FORMATTING.color &&
    fmt.boldCity === DEFAULT_FORMATTING.boldCity &&
    fmt.boldTime === DEFAULT_FORMATTING.boldTime &&
    fmt.boldZone === DEFAULT_FORMATTING.boldZone
  );
}

/**
 * Read-modify-write helper for the `formatting` GSettings key (a{ss}:
 * zone id -> JSON-encoded formatting blob). Returns a NEW map (`map` is
 * never mutated) with `zone`'s entry set to a sanitized, JSON-stringified
 * formatting object, every other zone's entry preserved verbatim.
 *
 * Passing `fmtOrNull` as `null`/`undefined`, OR an object that sanitizes
 * to exactly DEFAULT_FORMATTING (i.e. a "neutral"/all-default blob),
 * REMOVES `zone`'s entry from the returned map entirely rather than
 * storing a neutral JSON blob -- this is what makes "clear the per-zone
 * override" fall back to formatting-defaults (see getEffectiveFormatting
 * below): a zone with no key in the map is indistinguishable from a zone
 * that was never touched.
 *
 * NOTE for callers (e.g. prefs.js): a per-zone override is stored as a
 * WHOLE blob, not a per-field diff against formatting-defaults -- there
 * is no partial/sparse override. So the first time a caller sets just
 * ONE field for a zone that has no override yet, `fmtOrNull` must be a
 * COMPLETE formatting object with every other field already filled in
 * from whatever is currently effective for that zone (typically the
 * current global defaults), not from DEFAULT_FORMATTING's neutral shape
 * -- otherwise the write silently resets every other field to neutral
 * even though the UI was just showing the current defaults for them.
 * The direct consequence: setting a single per-zone field "locks in"
 * the *current* global defaults for that zone's other fields at the
 * moment of that edit; the zone's override stops tracking future
 * changes to formatting-defaults for those fields from then on.
 */
export function setZoneFormatting(map, zone, fmtOrNull) {
  const next = { ...(map || {}) };

  if (fmtOrNull === null || fmtOrNull === undefined) {
    delete next[zone];
    return next;
  }

  const sanitized = sanitizeFormatting(fmtOrNull);
  if (isNeutralFormatting(sanitized)) {
    delete next[zone];
    return next;
  }

  next[zone] = JSON.stringify(sanitized);
  return next;
}

function clamp01(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

function channelToHex(value) {
  const int = Math.round(clamp01(value) * 255);
  return int.toString(16).padStart(2, '0');
}

/**
 * Convert a GTK RGBA-shaped object ({red, green, blue[, alpha]}, each a
 * float in [0, 1] as returned by Gtk.ColorDialogButton/Gtk.ColorButton's
 * `rgba` property) to a lowercase '#rrggbb' string. Alpha is ignored (the
 * 'formatting' schema has no alpha channel). Out-of-range floats are
 * clamped into [0, 1] before rounding, so this always returns a string
 * matching exactly `^#[0-9a-f]{6}$` -- i.e. one that sanitizeColor()
 * accepts and returns unchanged.
 */
export function rgbaToHex({ red, green, blue } = {}) {
  return `#${channelToHex(red)}${channelToHex(green)}${channelToHex(blue)}`;
}

// Normalizes a single formatting value that may be EITHER shape callers
// hold this data in at different points in the codebase:
//   - a raw JSON string straight from the 'formatting'/'formatting-defaults'
//     GSettings a{ss}/s keys (prefs.js's readFormattingMap()/
//     settings.get_string() return this shape) -> parseFormatting()
//   - an already-parsed, already-sanitized object (extension.js's
//     _loadSettings() pre-parses every entry into this shape, once, at
//     settings-load time -- see the comment on that pre-parse below for
//     why it stays that way) -> re-sanitized via sanitizeFormatting()
//     defensively, same as every other formatting value in this module
// `undefined`/`null` (key absent) normalizes to `null`, letting the
// caller fall through to the next precedence level.
function normalizeFormattingValue(value) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === 'string') {
    return parseFormatting(value);
  }
  return sanitizeFormatting(value);
}

/**
 * The single implementation of the formatting precedence rule: a
 * per-zone override (a key present in `formattingMap`) wins over the
 * global `formattingDefaults`, which itself falls back to
 * DEFAULT_FORMATTING when unset. Mirrors extension.js's
 * `_getEffectiveFormatting` exactly -- that method now delegates here
 * instead of re-implementing the same two-line check, so prefs.js (which
 * needs the same rule to show the correct "effective" preview/initial
 * state per zone) and extension.js can never drift apart on it.
 *
 * Accepted shapes for `formattingMap[zone]` and `formattingDefaults`:
 * EITHER a raw JSON string (the literal shape stored in GSettings) OR an
 * already-parsed/sanitized formatting object -- this function normalizes
 * whichever it is given via normalizeFormattingValue() above, so callers
 * are never required to pre-parse before calling this. This matters
 * because the two real callers hold this data in different shapes:
 * extension.js's `this._formatting`/`this._formattingDefaults` are
 * pre-parsed objects (see _loadSettings()'s comment for why), while
 * prefs.js reads the raw a{ss} map / GSettings string directly on every
 * call with no pre-parse step. Before this normalization was added here,
 * prefs.js silently received a raw JSON STRING back for any zone with an
 * existing override, which every Gtk widget then displayed as neutral
 * defaults (a string is truthy but every property access on it is
 * undefined) -- a real, user-visible bug (reopening prefs on an
 * already-customized zone showed defaults instead of that zone's saved
 * values). Normalizing both possible input shapes here, once, is what
 * makes this guarantee hold for every current and future caller instead
 * of relying on an implicit "caller must pre-parse" contract.
 */
export function getEffectiveFormatting(zone, formattingMap, formattingDefaults) {
  if (formattingMap && Object.prototype.hasOwnProperty.call(formattingMap, zone)) {
    const normalized = normalizeFormattingValue(formattingMap[zone]);
    if (normalized !== null) {
      return normalized;
    }
  }
  return normalizeFormattingValue(formattingDefaults) || DEFAULT_FORMATTING;
}

// ---------------------------------------------------------------------
// Segment assembly (Phase 2: panel/menu rendering)
// ---------------------------------------------------------------------
//
// A rendered entry is built from three logical segments -- city (or
// alias/label), zone abbreviation, and time -- joined with a single
// space, mirroring the pre-Phase-2 legacy format exactly:
//
//   `${timezoneLabel}${offset}${time}`
//
// where `offset` was ` ${now.format('%Z')} ` when the zone abbreviation
// was shown, or a single ' ' otherwise. That is equivalent to:
//
//   zone shown:     `${city} ${zone} ${time}`
//   zone hidden:    `${city} ${time}`
//
// `zone` being `null`/`undefined` means "hidden" (matching the legacy
// boolean branch); an empty-string zone is still treated as "shown"
// (callers only pass a real string when the zone segment should render).
// Callers are responsible for producing `city`/`zone`/`time` themselves
// (extension.js computes them from GLib.DateTime + this._config); these
// functions only assemble and (for the markup variant) escape/format them.

/**
 * Assemble the plain-text (no markup) form of an entry. Byte-identical
 * to the pre-Phase-2 legacy `_getLabelForTimezone` output for the same
 * inputs -- used for the 'full' form consumed by menu rows and the drag
 * preview, which render as plain St.Label text and must never see raw
 * markup syntax.
 */
export function buildEntryText({ city, zone, time }) {
  const cityStr = city ?? '';
  const timeStr = time ?? '';

  if (zone === null || zone === undefined) {
    return `${cityStr} ${timeStr}`;
  }

  return `${cityStr} ${zone} ${timeStr}`;
}

// Wraps already-escaped text in a <b>...</b> span when `bold` is true.
function boldSegment(escapedText, bold) {
  return bold ? `<b>${escapedText}</b>` : escapedText;
}

/**
 * Assemble the Pango-markup form of an entry. Every dynamic segment is
 * escaped via escapeMarkup() before insertion. `fmt` is defensively
 * re-sanitized via sanitizeFormatting() regardless of whether the caller
 * already sanitized it (this is a security boundary, not merely
 * cosmetic, so it never trusts its input). Each of boldCity/boldTime/
 * boldZone independently wraps only its own segment. size/color (when
 * non-neutral) wrap the WHOLE assembled entry in a single outer <span>;
 * when both are neutral (0 / ''), no outer <span> is emitted at all, so
 * an unconfigured entry's markup is exactly the escaped equivalent of
 * buildEntryText()'s output (plus any <b> tags from bold flags).
 */
export function buildEntryMarkup({ city, zone, time }, fmt) {
  const f = sanitizeFormatting(fmt);

  const citySeg = boldSegment(escapeMarkup(city ?? ''), f.boldCity);
  const timeSeg = boldSegment(escapeMarkup(time ?? ''), f.boldTime);

  let inner;
  if (zone === null || zone === undefined) {
    inner = `${citySeg} ${timeSeg}`;
  } else {
    const zoneSeg = boldSegment(escapeMarkup(zone), f.boldZone);
    inner = `${citySeg} ${zoneSeg} ${timeSeg}`;
  }

  const attrs = [];

  const size = sanitizeFontSize(f.size);
  if (size !== 0) {
    // Pango markup 'size' attribute is expressed in 1024ths of a point.
    attrs.push(`size="${size * 1024}"`);
  }

  const color = sanitizeColor(f.color);
  if (color !== '') {
    // sanitizeColor() guarantees this matches ^#[0-9a-f]{6}$ exactly, so
    // it can never contain a quote/angle-bracket that would break out of
    // this attribute.
    attrs.push(`foreground="${color}"`);
  }

  if (attrs.length === 0) {
    return inner;
  }

  return `<span ${attrs.join(' ')}>${inner}</span>`;
}
