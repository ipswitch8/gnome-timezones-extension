// hoverPopup.js
//
// Pure logic for the "Show dates on hover" popup: a BoxPointer-based,
// SINGLE line of "label + date" cells for every active timezone (see
// extension.js's _initHoverPopup()/_showHoverPopup() for the actor/
// GObject plumbing), shown while hovering the panel clock. Kept separate
// from extension.js so the cell-building logic -- "which zones, in what
// order, with what label/date text, with what separators between them" --
// is testable without a running gnome-shell (see tests/run-tests.js's own
// suite for this module).
//
// LAYOUT (see extension.js's _rebuildHoverPopupRow()): the popup is ONE
// line, one cell per active zone -- each cell is that zone's LABEL
// (city/zone segments, see below) followed by a space and its DATE, or
// just the date alone when the label is empty -- plus a separator cell
// interleaved between each adjacent pair of zones. buildHoverPopupCells()
// below returns an ORDERED list of such cells -- one 'date' cell per zone
// (in _activeOrder order) plus one 'separator' cell interleaved between
// each adjacent pair of zones -- mirroring how Array.prototype.join()
// places a separator only BETWEEN entries (never leading/trailing). This
// is deliberately the SAME order and the SAME separator literal the panel
// itself uses to join its own entries, so the popup reads as "the dates
// underneath the times you already see, each one labeled with the same
// city/zone the panel already shows for it" rather than a re-sorted or
// differently-punctuated list.
//
// STILL NO TIME (scope kept from an earlier dates-only design): this
// popup never shows any per-zone TIME text -- that is already visible in
// the panel clock itself, so repeating it here would be redundant. Only
// the LABEL (city and/or zone abbreviation, whichever the "Show city
// name"/"Show timezone" toggles currently select) and the DATE are shown.
//
// LABEL TEXT REUSE (avoiding a second, drifting implementation): this
// module does NOT itself decide "what should zone X's label be" -- that
// decision (respecting showCity/showTimezone/format24/custom labels)
// already lives in exactly one place, extension.js's
// _computeEntrySegments()/buildEntryText() (formatting.js), which is also
// what the real panel entry falls back to as plain text. Mirroring the
// design of an earlier two-line version of this popup (which took a
// `getEntryText` callback for the same reason), buildHoverPopupCells()
// takes an OPTIONAL `getLabelText` callback instead of the raw
// ingredients (config/labels/aliases) that would be needed to rebuild
// that decision here -- production code (extension.js) passes a callback
// that derives the city+zone segments from _computeEntrySegments() (with
// the time segment dropped) and joins them exactly like buildEntryText()
// does, so the popup's label is ALWAYS derived from the same single
// source of truth the panel uses, with zero duplicated segment-assembly
// logic in this file. Only the DATE segment (which the panel never
// shows) is computed here, via the same resolveDateFormat()/
// formatDateForDisplay() helpers every other date-consuming call site in
// this project already uses. Omitting `getLabelText` (or having it
// return '' for a zone) falls back to a date-only cell for that zone,
// preserving the prior dates-only behavior for any caller that doesn't
// supply one.
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
//
// This module does not apply any of the per-entry formatting.js
// bold/size/color logic -- this popup is purely informational (see the
// design brief), so buildEntryMarkup()/getEffectiveFormatting() are
// deliberately never imported or used here.

import GLib from 'gi://GLib';
import { resolveDateFormat, formatDateForDisplay } from './dateFormats.js';

/**
 * Pure: builds the ordered cell model for the dates-only hover popup --
 * one 'date' cell per zone in `activeOrder` (in that EXACT order -- the
 * feature's core requirement: the popup lists every active zone "in the
 * same order as the panel", i.e. `_activeOrder` order, never re-sorted),
 * with a 'separator' cell interleaved between every adjacent pair of date
 * cells (never before the first or after the last -- exactly
 * `zones.length - 1` separator cells for `zones.length` date cells,
 * mirroring how Array.prototype.join() places a separator only BETWEEN
 * entries). Zone ids not present in `knownZones` (e.g. a stale/foreign
 * 'timezones' GSettings entry -- mirrors extension.js's own defensive
 * filtering elsewhere, see _reconcileActiveOrder()) are silently skipped
 * rather than producing a broken cell, and never get a separator cell of
 * their own.
 *
 * @param {object} params
 * @param {string[]} params.activeOrder
 * @param {{has(zone: string): boolean}} params.knownZones - anything with
 *   a `.has()` method (a Set or Map both work; extension.js passes its
 *   `this._stateByZone` Map directly).
 * @param {string} [params.dateFormat] - raw stored 'date-format' GSettings
 *   value, resolved here via resolveDateFormat() exactly like every other
 *   date-consuming call site in this project.
 * @param {(zone: string) => GLib.DateTime} [params.nowForZone] - injectable
 *   per-zone "current time" resolver, for deterministic testing; defaults
 *   to `GLib.DateTime.new_now()` for the zone's own GLib.TimeZone.
 * @param {(zone: string) => string} [params.getLabelText] - OPTIONAL
 *   callback returning the label text to prepend to `zone`'s date -- see
 *   the module header comment above for why this is a callback rather
 *   than `config`/`labels`/alias ingredients this module would otherwise
 *   need to re-derive the panel's own city/zone segment decision from.
 *   Omitted (or returning a falsy/empty value for a given zone) falls
 *   back to a date-only cell for that zone (`labelText: ''`).
 * @param {string} [params.separatorValue] - the literal separator string
 *   to place between date cells (extension.js's own
 *   `_resolveSeparatorValue()` return value -- the SAME literal the panel
 *   joins its own entries with). Defaults to '' (no separator cell
 *   between zones) if omitted.
 * @returns {Array<
 *   { type: 'date', zone: string, dateText: string, labelText: string } |
 *   { type: 'separator', text: string }
 * >}
 */
export function buildHoverPopupCells({ activeOrder, knownZones, dateFormat, nowForZone, getLabelText, separatorValue }) {
  const zones = (activeOrder || []).filter((zone) => knownZones && knownZones.has(zone));

  if (zones.length === 0) {
    return [];
  }

  const formatString = resolveDateFormat(dateFormat);
  const separatorText = separatorValue || '';
  const resolveLabel = typeof getLabelText === 'function' ? getLabelText : () => '';
  const cells = [];

  zones.forEach((zone, index) => {
    if (index > 0) {
      cells.push({ type: 'separator', text: separatorText });
    }

    const glibTimezone = GLib.TimeZone.new(zone);
    const dateTime = nowForZone ? nowForZone(zone) : GLib.DateTime.new_now(glibTimezone);
    const dateText = formatDateForDisplay(dateTime, formatString);
    // '' fallback covers both "no getLabelText supplied" (resolveLabel
    // above already handles that) and a supplied callback returning a
    // nullish/falsy value for this particular zone -- either way the cell
    // is date-only, never `undefined`/`null` text.
    const labelText = resolveLabel(zone) || '';

    cells.push({
      type: 'date',
      zone,
      dateText,
      labelText,
    });
  });

  return cells;
}
