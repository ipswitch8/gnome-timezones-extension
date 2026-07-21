// hoverPopup.js
//
// Pure logic for the "Show dates on hover" popup: a BoxPointer-based,
// SINGLE line of dates for every active timezone (see extension.js's
// _initHoverPopup()/_showHoverPopup() for the actor/GObject plumbing),
// shown while hovering the panel clock. Kept separate from extension.js
// so the cell-building logic -- "which zones, in what order, with what
// date text, with what separators between them" -- is testable without a
// running gnome-shell (see tests/run-tests.js's own suite for this
// module).
//
// LAYOUT (see extension.js's _rebuildHoverPopupRow()): the popup is ONE
// line of DATES ONLY -- no times, no zone/city text. buildHoverPopupCells()
// below returns an ORDERED list of cells -- one 'date' cell per zone (in
// _activeOrder order) plus one 'separator' cell interleaved between each
// adjacent pair of zones -- mirroring how Array.prototype.join() places a
// separator only BETWEEN entries (never leading/trailing). This is
// deliberately the SAME order and the SAME separator literal the panel
// itself uses to join its own entries, so the popup reads as "the dates
// underneath the times you already see" rather than a re-sorted or
// differently-punctuated list.
//
// DATES ONLY (scope correction from an earlier two-line/column design):
// this popup no longer shows any per-zone TIME or name/city text -- that
// information is already visible in "the normal display of the times"
// (the panel clock itself). Showing it a second time in the hover popup
// was redundant. This module therefore has no dependency on
// extension.js's entry-text assembly (_getLabelForTimezone()) at all --
// the only per-zone value it computes is the DATE, via the same
// resolveDateFormat()/formatDateForDisplay() helpers every other
// date-consuming call site in this project already uses.
//
// PLAIN TEXT ONLY (deliberate choice, see the feature's design brief):
// every string this module returns is plain text, rendered by
// extension.js into St.Label.text -- NEVER Pango markup. This keeps this
// popup off the markup/escapeMarkup() surface entirely: no escaping is
// needed here because nothing here is ever parsed as markup.
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
 * @param {string} [params.separatorValue] - the literal separator string
 *   to place between date cells (extension.js's own
 *   `_resolveSeparatorValue()` return value -- the SAME literal the panel
 *   joins its own entries with). Defaults to '' (no separator cell
 *   between zones) if omitted.
 * @returns {Array<
 *   { type: 'date', zone: string, dateText: string } |
 *   { type: 'separator', text: string }
 * >}
 */
export function buildHoverPopupCells({ activeOrder, knownZones, dateFormat, nowForZone, separatorValue }) {
  const zones = (activeOrder || []).filter((zone) => knownZones && knownZones.has(zone));

  if (zones.length === 0) {
    return [];
  }

  const formatString = resolveDateFormat(dateFormat);
  const separatorText = separatorValue || '';
  const cells = [];

  zones.forEach((zone, index) => {
    if (index > 0) {
      cells.push({ type: 'separator', text: separatorText });
    }

    const glibTimezone = GLib.TimeZone.new(zone);
    const dateTime = nowForZone ? nowForZone(zone) : GLib.DateTime.new_now(glibTimezone);
    const dateText = formatDateForDisplay(dateTime, formatString);

    cells.push({
      type: 'date',
      zone,
      dateText,
    });
  });

  return cells;
}
