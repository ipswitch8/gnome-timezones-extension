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
