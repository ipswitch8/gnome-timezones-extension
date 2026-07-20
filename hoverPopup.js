// hoverPopup.js
//
// Pure logic for the "show all zones on hover" popup: a BoxPointer-based,
// two-line, column-aligned display of every active timezone (see
// extension.js's _initHoverPopup()/_showHoverPopup() for the actor/
// GObject plumbing), shown while hovering the panel clock. Kept separate
// from extension.js so the column-building logic -- "which zones, in
// what order, with what text, with what separators between them" -- is
// testable without a running gnome-shell (see tests/run-tests.js's own
// suite for this module).
//
// LAYOUT (see extension.js's _rebuildHoverPopupColumns()): the popup is
// TWO lines --
//   line 1 (top):    each zone's normal PANEL-style entry (name/city per
//                     config, time -- the exact same text the panel
//                     itself shows for that zone), separator literals
//                     between zones.
//   line 2 (bottom):  each zone's DATE only (the global 'date-format'
//                     setting), same separator literals in the same
//                     positions, so the two lines stay column-aligned.
// buildHoverPopupColumns() below returns an ORDERED list of columns --
// one per zone (in _activeOrder order) plus one interleaved between each
// adjacent pair of zones for the separator -- rather than two independent
// strings, specifically so extension.js can render each column as its own
// vertical sub-box (top label over bottom label) and let the real layout
// engine size each column to the max of its two labels' natural widths.
// That is what actually GUARANTEES the date sits under its own zone's
// entry (and the separator lines up on both rows) regardless of font
// metrics -- string-padding a single flat two-line pair of strings cannot
// give that guarantee under a proportional font, which is why this model
// is column-shaped rather than just "top line text" + "bottom line text".
//
// ENTRY TEXT REUSE (avoiding a second, drifting implementation): this
// module does NOT itself recompute "what should zone X's panel entry text
// be" -- that decision (respecting showCity/showTimezone/format24/custom
// labels) already lives in exactly one place, extension.js's
// _computeEntrySegments()/_getLabelForTimezone(), which is also what the
// real panel label falls back to as plain text (_updateLabel()'s
// `plainText` closure). buildHoverPopupColumns() takes a `getEntryText`
// callback instead of the raw ingredients (activeOrder/labels/config)
// that would be needed to rebuild that decision here -- production code
// (extension.js) passes `(zone) => this._getLabelForTimezone({ item:
// this._stateByZone.get(zone) })` as that callback, so the popup's top
// line is ALWAYS byte-identical to what the panel would show for that
// zone (same config, same labels, same `full: false` shape) with zero
// duplicated segment-assembly logic in this file. Only the DATE segment
// (which the panel never shows) is computed here, via the same
// resolveDateFormat()/formatDateForDisplay() helpers every other
// date-consuming call site in this project already uses.
//
// PLAIN TEXT ONLY (deliberate choice, see the feature's design brief):
// every string this module returns is plain text, rendered by
// extension.js into St.Label.text -- NEVER Pango markup. This keeps this
// popup off the markup/escapeMarkup() surface entirely: no escaping is
// needed here because nothing here is ever parsed as markup. Anyone
// adding markup rendering to this popup in the future MUST route every
// dynamic segment through escapeMarkup() (formatting.js) first, exactly
// like every OTHER markup surface in this project already does -- do not
// assume plain-text safety carries over.
//
// This module does not apply any of the per-entry formatting.js
// bold/size/color logic -- this popup is purely informational (see the
// design brief), so buildEntryMarkup()/getEffectiveFormatting() are
// deliberately never imported or used here.

import GLib from 'gi://GLib';
import { resolveDateFormat, formatDateForDisplay } from './dateFormats.js';

/**
 * Pure: builds the ordered column model for the two-line hover popup --
 * one 'zone' column per zone in `activeOrder` (in that EXACT order -- the
 * feature's core requirement: the popup lists every active zone "in the
 * same order as the panel", i.e. `_activeOrder` order, never re-sorted),
 * with a 'separator' column interleaved between every adjacent pair of
 * zone columns (never before the first or after the last -- exactly
 * `zones.length - 1` separator columns for `zones.length` zone columns,
 * mirroring how Array.prototype.join() places a separator only BETWEEN
 * entries). Zone ids not present in `knownZones` (e.g. a stale/foreign
 * 'timezones' GSettings entry -- mirrors extension.js's own defensive
 * filtering elsewhere, see _reconcileActiveOrder()) are silently skipped
 * rather than producing a broken column, and never get a separator column
 * of their own.
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
 * @param {(zone: string) => string} params.getEntryText - REQUIRED
 *   callback returning the top-line text for `zone` -- see the module
 *   header comment above for why this is a callback rather than
 *   `activeOrder`/`labels`/`config` ingredients this module would
 *   otherwise need to re-derive the panel's own entry-text decision from.
 * @param {string} [params.separatorValue] - the literal separator string
 *   to place between zone columns (extension.js's own
 *   `_resolveSeparatorValue()` return value -- the SAME literal the panel
 *   joins its own entries with). Defaults to '' (no separator column
 *   between zones) if omitted.
 * @returns {Array<
 *   { type: 'zone', zone: string, entryText: string, dateText: string } |
 *   { type: 'separator', text: string }
 * >}
 */
export function buildHoverPopupColumns({
  activeOrder,
  knownZones,
  dateFormat,
  nowForZone,
  getEntryText,
  separatorValue,
}) {
  const zones = (activeOrder || []).filter((zone) => knownZones && knownZones.has(zone));

  if (zones.length === 0) {
    return [];
  }

  const formatString = resolveDateFormat(dateFormat);
  const separatorText = separatorValue || '';
  const columns = [];

  zones.forEach((zone, index) => {
    if (index > 0) {
      columns.push({ type: 'separator', text: separatorText });
    }

    const glibTimezone = GLib.TimeZone.new(zone);
    const dateTime = nowForZone ? nowForZone(zone) : GLib.DateTime.new_now(glibTimezone);
    const dateText = formatDateForDisplay(dateTime, formatString);

    columns.push({
      type: 'zone',
      zone,
      entryText: getEntryText(zone),
      dateText,
    });
  });

  return columns;
}
