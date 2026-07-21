// hoverPopup.js
//
// Pure logic for the "Show dates on hover" popup: a BoxPointer-based,
// SINGLE line of "label + date" cells for every active timezone (see
// extension.js's _initHoverPopup()/_showHoverPopup() for the actor/
// GObject plumbing), shown while hovering the panel clock. Kept separate
// from extension.js so the cell-building logic -- "which zones, in what
// order, with what segments/date text, with what per-zone formatting,
// with what separators between them" -- is testable without a running
// gnome-shell (see tests/run-tests.js's own suite for this module).
//
// LAYOUT (see extension.js's _rebuildHoverPopupRow()): the popup is ONE
// line, one cell per active zone -- each cell is that zone's CITY segment
// (if shown), its ZONE-abbreviation segment (if shown), and its DATE,
// each rendered as its OWN St.Label so per-segment bold can be applied
// independently -- plus a separator cell interleaved between each
// adjacent pair of zones. buildHoverPopupCells() below returns an ORDERED
// list of such cells -- one 'zone' cell per zone (in _activeOrder order)
// plus one 'separator' cell interleaved between each adjacent pair of
// zones -- mirroring how Array.prototype.join() places a separator only
// BETWEEN entries (never leading/trailing). This is deliberately the
// SAME order and the SAME separator literal the panel itself uses to
// join its own entries, so the popup reads as "the dates underneath the
// times you already see, each one labeled with the same city/zone the
// panel already shows for it, in the same per-zone size/colour/bold"
// rather than a re-sorted, differently-punctuated, or differently-styled
// list.
//
// STILL NO TIME (scope kept from an earlier dates-only design): this
// popup never shows any per-zone TIME text -- that is already visible in
// the panel clock itself, so repeating it here would be redundant. Only
// the segments (city and/or zone abbreviation, whichever the "Show city
// name"/"Show timezone" toggles currently select) and the DATE are shown.
//
// SEGMENT REUSE (avoiding a second, drifting implementation): this
// module does NOT itself decide "what should zone X's city/zone segment
// text be" -- that decision (respecting showCity/showTimezone/format24/
// custom labels) already lives in exactly one place, extension.js's
// _computeEntrySegments(), which is also what the real panel entry falls
// back to as plain text. Mirroring the design of an earlier version of
// this popup (which took a `getLabelText` callback for the same reason),
// buildHoverPopupCells() takes an OPTIONAL `getEntrySegments` callback
// instead of the raw ingredients (config/labels/aliases) that would be
// needed to rebuild that decision here -- production code (extension.js)
// passes a callback that derives `{city, zone}` straight from
// _computeEntrySegments() (with the time segment dropped entirely), so
// the popup's segments are ALWAYS derived from the same single source of
// truth the panel uses, with zero duplicated segment-assembly logic in
// this file. Only the DATE segment (which the panel never shows) is
// computed here, via the same resolveDateFormat()/formatDateForDisplay()
// helpers every other date-consuming call site in this project already
// uses. Omitting `getEntrySegments` (or it returning a nullish/malformed
// result for a zone) falls back to `citySeg: ''`/`zoneSeg: null` for that
// zone (a date-only cell), preserving the prior dates-only behavior for
// any caller that doesn't supply one.
//
// PER-ZONE FORMATTING, VIA `fmt` -- CSS, NOT MARKUP (deliberate choice,
// see the feature's design brief): each 'zone' cell also carries a
// sanitized `fmt` object (`{size, color, boldCity, boldZone}`) -- the
// SAME effective per-zone size/colour/bold the panel itself uses (see
// formatting.js's `getEffectiveFormatting()`), obtained via the OPTIONAL
// `getFormatting` callback (production code passes
// `(zone) => this._getEffectiveFormatting(zone)`) and re-sanitized here
// via `sanitizeFormatting()` regardless of whether the caller already
// did (defense-in-depth, matching `buildEntryMarkup()`'s own discipline
// in formatting.js). `boldTime` is deliberately dropped from `fmt` --
// this popup has no time segment for it to ever apply to. extension.js
// applies `fmt` to each cell's segment LABELS via plain St CSS
// (`set_style()`: `font-size`/`color`/`font-weight: bold`), never Pango
// markup -- see extension.js's own comment on _rebuildHoverPopupRow() for
// why CSS specifically (not markup) is the right tool here: every hover
// cell's segment text starts at byte offset 0 in its OWN St.Label, so a
// markup `<span foreground="...">` colour would lose to St's own
// whole-text base FOREGROUND attribute in EVERY cell (the exact "first
// entry's colour never rendered" platform quirk documented on the
// panel's own _updateLabel()), not just the first one -- CSS `color` sets
// the label's own base attribute directly (via gnome-shell's
// `_st_set_text_from_style()`), so there is no base-attribute collision
// to lose in the first place, and no markup escaping surface either (see
// the "PLAIN TEXT ONLY" note below, which still holds: nothing this
// module or extension.js's rendering of it produces is ever parsed as
// markup).
//
// PLAIN TEXT ONLY (deliberate choice, see the feature's design brief):
// every string this module returns is plain text, rendered by
// extension.js into St.Label.text -- NEVER Pango markup. This keeps this
// popup off the markup/escapeMarkup() surface entirely: no escaping is
// needed here because nothing here is ever parsed as markup. A hostile
// custom label's markup metacharacters therefore appear verbatim in the
// rendered text (there is nothing to escape, and nothing here ever
// interprets them) -- see extension.js's own comment on how it renders
// each cell for why that is safe.

import GLib from 'gi://GLib';
import { resolveDateFormat, formatDateForDisplay, formatWeekday } from './dateFormats.js';
import { sanitizeFormatting } from './formatting.js';

/**
 * Pure: builds the ordered cell model for the dates-only hover popup --
 * one 'zone' cell per zone in `activeOrder` (in that EXACT order -- the
 * feature's core requirement: the popup lists every active zone "in the
 * same order as the panel", i.e. `_activeOrder` order, never re-sorted),
 * with a 'separator' cell interleaved between every adjacent pair of zone
 * cells (never before the first or after the last -- exactly
 * `zones.length - 1` separator cells for `zones.length` zone cells,
 * mirroring how Array.prototype.join() places a separator only BETWEEN
 * entries). Zone ids not present in `knownZones` (e.g. a stale/foreign
 * 'timezones' GSettings entry -- mirrors extension.js's own defensive
 * filtering elsewhere, see _reconcileActiveOrder()) are silently skipped
 * rather than producing a broken cell, and never get a separator cell of
 * their own.
 *
 * SEGMENTS, NOT A SINGLE JOINED STRING (per-zone formatting requirement):
 * each 'zone' cell exposes its CITY and ZONE-ABBREVIATION segments
 * SEPARATELY (`citySeg`/`zoneSeg`), rather than one pre-joined
 * `labelText` string as an earlier version of this module did -- so a
 * caller (extension.js) can render each segment as its OWN St.Label and
 * apply BOLD independently per segment (boldCity only affects citySeg,
 * boldZone only affects zoneSeg, and the date is NEVER bold -- see
 * `fmt` below). `zoneSeg` is `null` when the zone-abbreviation segment is
 * hidden (mirrors extension.js's own `_computeEntrySegments()` `zone:
 * null` convention for "Show timezone" being off); `citySeg` is always a
 * string (possibly '' when "Show city name" is off and no custom label
 * applies). Extracting the city/zone TEXT is still entirely
 * extension.js's job via the required `getEntrySegments` callback -- this
 * module still never re-derives showCity/showTimezone/custom-label
 * itself (see the module header comment above).
 *
 * @param {object} params
 * @param {string[]} params.activeOrder
 * @param {{has(zone: string): boolean}} params.knownZones - anything with
 *   a `.has()` method (a Set or Map both work; extension.js passes its
 *   `this._stateByZone` Map directly).
 * @param {string} [params.dateFormat] - raw stored 'date-format' GSettings
 *   value, resolved here via resolveDateFormat() exactly like every other
 *   date-consuming call site in this project.
 * @param {boolean} [params.showWeekday] - OPTIONAL 'config' a{sb} boolean
 *   (the "Show weekday" toggle). When true, each cell's `dateText` is
 *   prefixed with the locale-abbreviated short weekday (via
 *   dateFormats.js's formatWeekday()) and a single space, e.g. "Wed
 *   20/07/2026" instead of "20/07/2026". Built via a clean join of the
 *   non-empty parts (never a naive string-concat) so a '' from either
 *   formatWeekday() (failure) or dateText (failure/empty format) never
 *   leaves a stray leading/trailing space. Defaults to false/falsy ->
 *   dateText is completely unchanged from the pre-existing behavior (byte-
 *   identical hover output for every caller not yet passing this param).
 *   NOTE: if the caller's chosen date-format ALREADY includes a weekday
 *   (e.g. the curated 'day-date-month'/'weekday' entries), enabling this
 *   produces a mildly duplicated weekday -- deliberately not detected/
 *   deduped here (fragile: would require parsing arbitrary %-format
 *   strings), the same tradeoff the format itself already accepts.
 * @param {(zone: string) => GLib.DateTime} [params.nowForZone] - injectable
 *   per-zone "current time" resolver, for deterministic testing; defaults
 *   to `GLib.DateTime.new_now()` for the zone's own GLib.TimeZone.
 * @param {(zone: string) => {city: string, zone: (string|null|undefined)}} [params.getEntrySegments] -
 *   OPTIONAL callback returning `zone`'s city/zone-abbreviation segments
 *   -- see the module header comment above for why this is a callback
 *   rather than `config`/`labels`/alias ingredients this module would
 *   otherwise need to re-derive the panel's own city/zone segment
 *   decision from. Omitted (or returning a nullish/malformed result for a
 *   given zone) falls back to `citySeg: ''`/`zoneSeg: null` for that zone
 *   (a date-only cell), preserving the prior dates-only behavior for any
 *   caller that doesn't supply one.
 * @param {(zone: string) => object} [params.getFormatting] - OPTIONAL
 *   callback returning `zone`'s EFFECTIVE (pre-sanitization) formatting
 *   object -- extension.js passes `(zone) => this._getEffectiveFormatting(zone)`,
 *   the exact same per-zone-override/global-default precedence the panel
 *   itself uses (see formatting.js's `getEffectiveFormatting()`).
 *   Re-sanitized here via `sanitizeFormatting()` regardless of whether the
 *   caller already sanitized it (defense-in-depth, matching
 *   `buildEntryMarkup()`'s own discipline in formatting.js), so a
 *   malformed/tampered result can never reach the returned cell. Omitted
 *   falls back to `DEFAULT_FORMATTING` (neutral: no size/color/bold) for
 *   every zone.
 * @returns {Array<
 *   { type: 'zone', zone: string, citySeg: string, zoneSeg: (string|null), dateText: string, fmt: {size: number, color: string, boldCity: boolean, boldZone: boolean} } |
 *   { type: 'separator', text: string }
 * >}
 */
export function buildHoverPopupCells({
  activeOrder,
  knownZones,
  dateFormat,
  showWeekday,
  nowForZone,
  getEntrySegments,
  getFormatting,
  separatorValue,
}) {
  const zones = (activeOrder || []).filter((zone) => knownZones && knownZones.has(zone));

  if (zones.length === 0) {
    return [];
  }

  const formatString = resolveDateFormat(dateFormat);
  const separatorText = separatorValue || '';
  const resolveSegments = typeof getEntrySegments === 'function' ? getEntrySegments : () => null;
  const resolveFormatting = typeof getFormatting === 'function' ? getFormatting : () => undefined;
  const cells = [];

  zones.forEach((zone, index) => {
    if (index > 0) {
      cells.push({ type: 'separator', text: separatorText });
    }

    const glibTimezone = GLib.TimeZone.new(zone);
    const dateTime = nowForZone ? nowForZone(zone) : GLib.DateTime.new_now(glibTimezone);
    const rawDateText = formatDateForDisplay(dateTime, formatString);

    // Clean join of non-empty parts only -- never a naive
    // `${weekday} ${rawDateText}` concat, which would leave a stray
    // leading/trailing space if either formatWeekday() or rawDateText
    // fails/returns ''.
    const dateText = showWeekday ? [formatWeekday(dateTime), rawDateText].filter((part) => part !== '').join(' ') : rawDateText;

    // A nullish/malformed getEntrySegments() result (including "omitted
    // entirely") falls back to citySeg: ''/zoneSeg: null -- the prior
    // dates-only cell shape, same discipline as the old labelText
    // fallback this replaces.
    const rawSegments = resolveSegments(zone) || {};
    const citySeg = rawSegments.city || '';
    const zoneSeg = rawSegments.zone === null || rawSegments.zone === undefined ? null : rawSegments.zone;

    // sanitizeFormatting() re-validates regardless of the caller (defense
    // in depth, matching buildEntryMarkup()'s own discipline) -- only the
    // four fields this popup actually renders are kept; boldTime is
    // dropped entirely since this popup never shows a time segment.
    const sanitized = sanitizeFormatting(resolveFormatting(zone));
    const fmt = {
      size: sanitized.size,
      color: sanitized.color,
      boldCity: sanitized.boldCity,
      boldZone: sanitized.boldZone,
    };

    cells.push({
      type: 'zone',
      zone,
      citySeg,
      zoneSeg,
      dateText,
      fmt,
    });
  });

  return cells;
}
