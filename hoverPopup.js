// hoverPopup.js
//
// Pure logic for the "show all zones on hover" popup: a BoxPointer-based
// list of every active timezone (see extension.js's _initHoverPopup()/
// _showHoverPopup() for the actor/GObject plumbing), shown while hovering
// the panel clock. Kept separate from extension.js so the row-building
// logic -- "which zones, in what order, with what text" -- is testable
// without a running gnome-shell (see tests/run-tests.js's own suite for
// this module).
//
// Row text intentionally reuses formatting.js's buildEntryText() -- the
// SAME plain-text assembly extension.js's 'full' menu-row form already
// uses for the city/zone/time segments -- plus dateFormats.js's
// resolveDateFormat()/formatDateForDisplay() for the date segment, so
// this popup's rows are never a second, independently-maintained
// rendering path for the same information.
//
// PLAIN TEXT ONLY (deliberate choice, see the feature's design brief):
// buildHoverPopupRows()/buildHoverPopupRowText() return plain strings,
// rendered by extension.js into St.Label.text -- NEVER Pango markup. This
// keeps this popup off the markup/escapeMarkup() surface entirely: no
// escaping is needed here because nothing here is ever parsed as markup.
// Anyone adding markup rendering to this popup in the future MUST route
// every dynamic segment through escapeMarkup() (formatting.js) first,
// exactly like every OTHER markup surface in this project already does --
// do not assume plain-text safety carries over.
//
// This module does not apply any of the per-entry formatting.js
// bold/size/color logic -- this popup is purely informational (see the
// design brief), so buildEntryMarkup()/getEffectiveFormatting() are
// deliberately never imported or used here.

import GLib from 'gi://GLib';
import { buildEntryText } from './formatting.js';
import { resolveDateFormat, formatDateForDisplay } from './dateFormats.js';

/**
 * Pure: computes the plain-text row for a single timezone, in the same
 * segment shape as extension.js's "full" menu-row form
 * (`_getLabelForTimezone({ item, full: true })`) -- i.e. always includes
 * the zone abbreviation (never gated behind the 'showTimezone' config,
 * exactly like the real full form: `let showZone = full || ...` always
 * resolves `true` when `full` is `true`) -- with the date segment ALWAYS
 * appended, independent of the separate 'showDate' menu-row toggle: this
 * popup's whole reason to exist is showing every zone's date at a glance,
 * so it does not additionally gate that behind 'showDate'.
 *
 * @param {object} params
 * @param {string} params.timezone - IANA zone id, e.g. 'America/New_York'.
 * @param {string} [params.label] - stored custom label for this zone, if any
 *   (mirrors extension.js's this._labels[zone] -- respects custom labels
 *   the same way the "full" menu-row form does).
 * @param {boolean} params.format24 - 24h vs 12h time format.
 * @param {string} params.dateFormat - raw stored 'date-format' GSettings
 *   value, resolved here via resolveDateFormat() exactly like every other
 *   date-consuming call site in this project.
 * @param {GLib.DateTime} [params.now] - injectable "current time" for
 *   deterministic testing; defaults to GLib.DateTime.new_now() for the
 *   zone's own GLib.TimeZone.
 * @returns {string} plain text, never markup -- see the module header.
 */
export function buildHoverPopupRowText({ timezone, label, format24, dateFormat, now }) {
  const glibTimezone = GLib.TimeZone.new(timezone);
  const dateTime = now || GLib.DateTime.new_now(glibTimezone);

  const city = label ? `${label} (${timezone})` : timezone;
  const segments = {
    city,
    // Always shown -- mirrors _computeEntrySegments()'s `full` branch,
    // where `showZone = full || this._config.showTimezone` is
    // unconditionally true once `full` is true.
    zone: dateTime.format('%Z'),
    time: dateTime.format(format24 ? '%R' : '%l:%M %p'),
  };

  let text = buildEntryText(segments);

  const formatString = resolveDateFormat(dateFormat);
  const dateText = formatDateForDisplay(dateTime, formatString);
  if (dateText) {
    text = `${text} (${dateText})`;
  }

  return text;
}

/**
 * Pure: builds the ordered row model for the hover popup -- one entry per
 * zone in `activeOrder`, in that EXACT order (the feature's core
 * requirement: the popup lists every active zone "in the same order as
 * the panel", i.e. `_activeOrder` order, never re-sorted). Zone ids not
 * present in `knownZones` (e.g. a stale/foreign 'timezones' GSettings
 * entry -- mirrors extension.js's own defensive filtering elsewhere, see
 * _reconcileActiveOrder()) are silently skipped rather than producing a
 * broken row.
 *
 * @param {object} params
 * @param {string[]} params.activeOrder
 * @param {{has(zone: string): boolean}} params.knownZones - anything with
 *   a `.has()` method (a Set or Map both work; extension.js passes its
 *   `this._stateByZone` Map directly).
 * @param {Object<string,string>} [params.labels] - zone id -> custom label.
 * @param {{format24?: boolean}} [params.config]
 * @param {string} [params.dateFormat]
 * @param {(zone: string) => GLib.DateTime} [params.nowForZone] - injectable
 *   per-zone "current time" resolver, for deterministic testing.
 * @returns {Array<{ zone: string, text: string }>}
 */
export function buildHoverPopupRows({ activeOrder, knownZones, labels, config, dateFormat, nowForZone }) {
  const rows = [];

  (activeOrder || []).forEach((zone) => {
    if (!knownZones || !knownZones.has(zone)) {
      return;
    }

    const text = buildHoverPopupRowText({
      timezone: zone,
      label: labels ? labels[zone] : undefined,
      format24: Boolean(config && config.format24),
      dateFormat,
      now: nowForZone ? nowForZone(zone) : undefined,
    });

    rows.push({ zone, text });
  });

  return rows;
}
