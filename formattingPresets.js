// formattingPresets.js
//
// Pure, UI-independent preset data backing the panel popup menu's global
// formatting-default controls (Phase 3): a small font-size ladder and a
// small named color palette, plus a generic "which preset matches this
// stored value" resolver used to decide which submenu item gets the
// selection ornament in extension.js.
//
// This module MUST NOT import anything from extension.js and must not
// import any GNOME Shell UI libraries (St, Clutter, PopupMenu, etc.) --
// only formatting.js's pure sanitizers -- so it stays testable under
// plain `gjs` the same way formatting.js and separators.js are.
//
// Every value below is a fixed point in formatting.js's sanitizer range,
// so it is guaranteed to round-trip through sanitizeFontSize()/
// sanitizeColor() unchanged (covered by tests in tests/run-tests.js).
// Adding a new preset later that falls outside that range will be caught
// immediately by those tests rather than silently clamped at render
// time.

import { sanitizeFontSize, sanitizeColor } from './formatting.js';

export const FONT_SIZE_PRESETS = [
  { id: 'default', label: 'Default', value: 0 },
  { id: '8', label: '8 pt', value: 8 },
  { id: '9', label: '9 pt', value: 9 },
  { id: '10', label: '10 pt', value: 10 },
  { id: '11', label: '11 pt', value: 11 },
  { id: '12', label: '12 pt', value: 12 },
  { id: '14', label: '14 pt', value: 14 },
  { id: '16', label: '16 pt', value: 16 },
  { id: '20', label: '20 pt', value: 20 },
  { id: '24', label: '24 pt', value: 24 },
];

export const COLOR_PALETTE = [
  { id: 'default', label: 'Default', value: '' },
  { id: 'white', label: 'White', value: '#ffffff' },
  { id: 'grey', label: 'Grey', value: '#888888' },
  { id: 'red', label: 'Red', value: '#e01b24' },
  { id: 'orange', label: 'Orange', value: '#ff7800' },
  { id: 'yellow', label: 'Yellow', value: '#f6d32d' },
  { id: 'green', label: 'Green', value: '#33d17a' },
  { id: 'blue', label: 'Blue', value: '#3584e4' },
  { id: 'purple', label: 'Purple', value: '#9141ac' },
];

/**
 * Find which preset entry's `field` (default 'value') matches `value`,
 * returning that entry's `id`, or `null` if no preset matches (e.g. a
 * hand-edited dconf value like a font size of 13, or a color of
 * '#123456' that isn't in the curated palette). Callers use the
 * returned id (or null) to decide which submenu item -- if any -- gets
 * the "currently selected" ornament; a null result must never throw and
 * must never cause the wrong item to appear selected.
 */
export function resolvePresetId(presets, value, field = 'value') {
  const match = presets.find((entry) => entry[field] === value);
  return match ? match.id : null;
}
