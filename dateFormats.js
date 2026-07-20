// dateFormats.js
//
// THE single place to customize the list of selectable date formats used
// when rendering each timezone's date in the popup menu rows (see the
// "date-format" GSettings key and extension.js's _getLabelForTimezone()).
// Mirrors separators.js in structure, doc-comment style, and intent.
//
// Entry shape:
//   {
//     id:    string  // Stable identifier PERSISTED to GSettings (the
//                     // "date-format" key stores a `value` -- a GLib
//                     // DateTime.format() pattern -- but prefs UI code
//                     // should key its selection state off `id`).
//                     // Renaming an `id` orphans any user's saved choice
//                     // (their stored value simply won't match any entry
//                     // any more, though the raw string value itself is
//                     // still a valid format pattern and will still
//                     // render fine -- it just won't be recognized as
//                     // "selected" in a picker UI, and will instead be
//                     // treated as a literal custom format, see
//                     // resolveDateFormat() below). Changing `label` or
//                     // `value` for an existing `id` is always safe.
//     label: string  // Human-readable name shown in preference UI.
//     value: string  // A GLib.DateTime.format() pattern, e.g. '%Y-%m-%d'.
//   }
//
// Do not remove entries that may already be persisted in a user's
// GSettings "date-format" key; prefer adding new ones.
//
// formatDateForDisplay() (further down) needs GLib.DateTime for a strict
// `instanceof` input check (see its own comment) and calls
// GLib.DateTime.prototype.format() on the value passed to it -- this
// import is otherwise unused by the curated-list logic below, which is
// plain data manipulation with no GLib dependency of its own.
import GLib from 'gi://GLib';

export const DATE_FORMATS = [
  { id: 'locale', label: 'Locale default', value: '%x' },
  { id: 'iso', label: 'ISO 8601 (YYYY-MM-DD)', value: '%Y-%m-%d' },
  { id: 'day-date-month', label: 'Weekday, day, month (Mon 05 Jan)', value: '%a %d %b' },
  { id: 'dmy-slash', label: 'Day/Month/Year (05/01/2026)', value: '%d/%m/%Y' },
  { id: 'mdy-slash', label: 'Month/Day/Year (01/05/2026)', value: '%m/%d/%Y' },
  { id: 'month-day', label: 'Month day (Jan 05)', value: '%b %d' },
  { id: 'weekday', label: 'Weekday only (Monday)', value: '%A' },
  { id: 'full', label: 'Full date (Monday, 05 January 2026)', value: '%A, %d %B %Y' },
];

export const DEFAULT_DATE_FORMAT_ID = 'locale';

export function getDateFormatById(id) {
  return DATE_FORMATS.find((entry) => entry.id === id);
}

// Hard cap on the length of a literal (non-curated) date format STRING
// resolved from the free-form 'date-format' GSettings key. That key is
// type `s` with no schema-level constraint to the curated list above --
// any process with dconf access can write an arbitrary string into it.
//
// Deliberately larger than separators.js's MAX_LITERAL_SEPARATOR_LENGTH
// (32): a date format pattern legitimately combines several `%`
// specifiers with literal punctuation/words (e.g. '%A, %d %B %Y - Week
// %V'), which is naturally longer than a single separator string. 64
// characters is generous enough for any realistic hand-built pattern
// while still bounding the worst case -- this caps the INPUT format
// string; formatDateForDisplay() below separately caps the OUTPUT text
// (a single `%`-specifier can itself expand to a long, locale-dependent
// string, e.g. '%c' or a long full month/weekday name), which is the
// cap that actually matters for row-width/DoS purposes.
const MAX_LITERAL_DATE_FORMAT_LENGTH = 64;

// Hard cap on the LENGTH OF THE FORMATTED OUTPUT string returned by
// formatDateForDisplay() below, applied regardless of which format
// (curated or literal) produced it. A crafted/tampered format string can
// combine many expansion-heavy specifiers (e.g. repeating '%c' several
// times) to produce output far longer than the format string itself, so
// capping only the input (MAX_LITERAL_DATE_FORMAT_LENGTH above) is not
// sufficient on its own. 100 characters is comfortably longer than any
// curated entry's real-world output in any locale, while still bounding
// how much text a single hostile value can inject into a menu row.
const MAX_DATE_OUTPUT_LENGTH = 100;

/**
 * Resolve a stored 'date-format' GSettings value to the literal
 * GLib.DateTime.format() pattern that should be used to render the date,
 * mirroring separators.js's resolveSeparatorValue() -- except that, unlike
 * that function, this ALWAYS returns a usable format string rather than
 * `null`: there is no legacy boolean fallback this feature needs to defer
 * to (it is a brand-new key), so "empty/unset" resolves directly to the
 * curated default entry's value instead of signaling the caller to fall
 * back to something else.
 *
 * Defensive by design, exactly like resolveSeparatorValue(): `stored` is
 * NOT assumed to have come from the curated DATE_FORMATS list above. If it
 * matches a curated entry's `id`, that entry's `value` is returned
 * (trusted, already-known-safe text). Otherwise `stored` itself is treated
 * as a literal format pattern: returned as-is, capped at
 * MAX_LITERAL_DATE_FORMAT_LENGTH characters.
 */
export function resolveDateFormat(stored) {
  if (typeof stored !== 'string' || stored === '') {
    return getDateFormatById(DEFAULT_DATE_FORMAT_ID).value;
  }

  const entry = getDateFormatById(stored);
  if (entry) {
    return entry.value;
  }

  return stored.slice(0, MAX_LITERAL_DATE_FORMAT_LENGTH);
}

// Attempts GLib.DateTime.format(fmt) and normalizes every failure mode
// (a thrown exception, OR a returned `null` -- GLib.DateTime.format()
// returns null rather than throwing for many invalid/unsupported
// specifiers or bad UTF-8, see its own documentation) to a single `null`
// return, so callers never have to handle two different failure shapes.
function tryFormat(dateTime, fmt) {
  try {
    return dateTime.format(fmt) ?? null;
  } catch (e) {
    return null;
  }
}

/**
 * Pure helper: formats `dateTime` (a GLib.DateTime) using `formatString`
 * (a GLib.DateTime.format() pattern, typically resolveDateFormat()'s
 * return value) for display in a popup menu row. Never throws.
 *
 * Failure handling:
 *   - `dateTime` is not a real GLib.DateTime -> returns '' immediately.
 *   - `formatString` is empty/not a string -> the curated default format
 *     is used instead.
 *   - GLib.DateTime.format() fails for the requested format (returns
 *     `null`, its real failure mode for an invalid/unsupported specifier
 *     or bad UTF-8 -- it does not throw for this) -> falls back to the
 *     curated default format.
 *   - If even the curated default format somehow fails too -> the date is
 *     OMITTED entirely (returns ''), rather than ever rendering the
 *     literal string "null" or leaving a broken/partial row.
 *   - The final successful result is capped at MAX_DATE_OUTPUT_LENGTH
 *     characters (see that constant's own comment for why this matters
 *     independently of the input-format cap).
 *
 * ESCAPING NOTE (read this before reusing this helper anywhere else):
 * this function returns PLAIN TEXT only. Its one current caller
 * (extension.js's _getLabelForTimezone(), full form) renders it into an
 * St.Label.text -- a plain-text surface with no Pango markup involved --
 * so no escaping happens or is needed here. If this helper (or its
 * output) is ever reused for a surface that IS Pango markup (the panel,
 * or the deferred hover/tooltip work), the caller MUST route the result
 * through escapeMarkup() (formatting.js) first, exactly like every other
 * dynamic segment already does for that surface -- this function
 * deliberately does not do that itself, since doing so here would be
 * incorrect (and misleadingly redundant) for its one current plain-text
 * caller.
 */
export function formatDateForDisplay(dateTime, formatString) {
  if (!(dateTime instanceof GLib.DateTime)) {
    return '';
  }

  const requested = typeof formatString === 'string' && formatString !== '' ? formatString : resolveDateFormat('');

  let result = tryFormat(dateTime, requested);

  if (result === null) {
    const fallback = resolveDateFormat('');
    if (fallback !== requested) {
      result = tryFormat(dateTime, fallback);
    }
  }

  if (result === null) {
    return '';
  }

  return result.slice(0, MAX_DATE_OUTPUT_LENGTH);
}
