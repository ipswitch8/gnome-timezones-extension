// prefs.js
//
// GTK4/Adw preferences window (GNOME Shell 45+ extension-preferences
// conventions). Runs in a SEPARATE PROCESS from extension.js (the
// `gnome-extensions-app`/`gnome-control-center` prefs host), which does
// NOT have St/Clutter/`resource:///org/gnome/shell/ui/*` available. This
// file therefore imports ONLY: gi://Adw, gi://Gtk, gi://Gdk, gi://GLib,
// the ExtensionPreferences base class, and the three pure, UI-independent
// modules also used by extension.js (formatting.js, separators.js) --
// none of which import anything shell-only; see their own header
// comments. It MUST NEVER import extension.js itself.
//
// Two surfaces are exposed here, mirroring the popup-menu controls added
// in Phase 3 (which this file does not replace -- both surfaces write the
// SAME GSettings keys, and the Phase 3 'changed' listener in extension.js
// already makes the panel/menu react live to changes made here, with no
// reload required):
//
//   1. Global formatting defaults + separator ("Defaults" group) --
//      'formatting-defaults' and 'separator'.
//   2. Per-zone formatting overrides ("Per-Zone Formatting" group), one
//      Adw.ExpanderRow per zone currently listed in the 'timezones' key
//      (i.e. every zone the user has actually activated) -- 'formatting'.
//
// --------------------------------------------------------------------
// Widget naming scheme (automation-friendly, project convention)
// --------------------------------------------------------------------
//
// Every interactive widget gets BOTH:
//   - `widget.set_name('tzprefs-<control>[-<zoneId>]')` -- a stable GTK
//     widget name, queryable via AT-SPI/UI-tree tooling and usable as a
//     CSS node selector.
//   - An accessible label, set the GTK4 way via
//     `widget.update_property([Gtk.AccessibleProperty.LABEL], [text])`
//     (GTK4 widgets implement the Gtk.Accessible interface directly --
//     there is no GTK3-style `get_accessible()` ATK object to reach
//     into). Adw.PreferencesRow subclasses (SpinRow/SwitchRow/ComboRow/
//     ExpanderRow/ActionRow) additionally get a human-readable `title`,
//     which libadwaita itself also exposes as the row's accessible name.
//
// `<control>` is one of: global-size, global-color, global-bold-city,
// global-bold-time, global-bold-zone, separator, size, color, bold-city,
// bold-time, bold-zone, clear, expander.
//
// `<zoneId>` (per-zone widgets only) is the zone's IANA id with every '/'
// replaced by '_' (see zoneToWidgetId() below), e.g. the zone
// 'America/Los_Angeles' yields widget names like
// 'tzprefs-size-America_Los_Angeles' -- stable and deterministic, so a
// test can locate a specific zone's control without depending on menu
// position/order.

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import GLib from 'gi://GLib';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
  sanitizeFontSize,
  sanitizeColor,
  parseFormatting,
  serializeFormatting,
  setZoneFormatting,
  getEffectiveFormatting,
  rgbaToHex,
} from './formatting.js';
import { SEPARATORS, DEFAULT_SEPARATOR_ID, getSeparatorById } from './separators.js';
import timezones from './timezones.js';

// Known-zone lookup, mirroring extension.js's own defensive filtering of
// dconf-sourced zone lists (see _loadSettings()'s "stale/foreign dconf
// entry" comments and _reconcileActiveOrder()). Built once at module load.
const KNOWN_ZONES = new Set(timezones);

const MIN_FONT_SIZE = 6;
const MAX_FONT_SIZE = 32;
// SpinRow's adjustment needs a real (non-zero-width) range; 0 is
// presented to the user as the explicit "Inherit / default" step below
// MIN_FONT_SIZE, rather than being unreachable or requiring a separate
// checkbox -- sanitizeFontSize() treats 0 as "inherit" and any value in
// [MIN_FONT_SIZE, MAX_FONT_SIZE] as a concrete size, so clamping the
// adjustment to exactly [0, MAX_FONT_SIZE] with step 1 makes every
// reachable value already valid input, with nothing in between 0 and
// MIN_FONT_SIZE ever producible by the spinner itself.
const SIZE_ADJUSTMENT_LOWER = 0;
const SIZE_ADJUSTMENT_UPPER = MAX_FONT_SIZE;

// Stable widget-name id derived from a zone's IANA id (see header
// comment): every '/' replaced with '_' so the result is a single CSS-
// selector-safe/AT-SPI-friendly token, e.g.
// 'America/Los_Angeles' -> 'America_Los_Angeles'.
function zoneToWidgetId(zone) {
  return zone.replace(/\//g, '_');
}

function setAccessibleLabel(widget, label) {
  widget.update_property([Gtk.AccessibleProperty.LABEL], [label]);
}

// Applies both halves of the naming scheme (widget name + accessible
// label) in one call, per the header comment's convention.
function nameWidget(widget, name, label) {
  widget.set_name(name);
  setAccessibleLabel(widget, label);
}

// Parses a sanitizeColor()-shaped '#rrggbb' string (or '' for "unset")
// into a Gdk.RGBA, defaulting to opaque black for '' -- callers only use
// this to seed a color-picker widget's initial swatch; '' itself is never
// written back anywhere (only a real user pick triggers a write, via
// rgbaToHex() in the 'notify::rgba'/'color-set' handler below).
function hexToRgba(hex) {
  const rgba = new Gdk.RGBA();
  rgba.parse(hex && hex !== '' ? hex : '#000000');
  return rgba;
}

export default class TimezonesPrefs extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings();

    const page = new Adw.PreferencesPage({
      title: 'Timezones',
      icon_name: 'preferences-desktop-display-symbolic',
    });
    page.set_name('tzprefs-page');
    window.add(page);

    this._buildDefaultsGroup(page, settings);
    this._buildPerZoneGroup(page, settings);
  }

  // -----------------------------------------------------------------
  // Global defaults ('formatting-defaults' + 'separator')
  // -----------------------------------------------------------------

  _buildDefaultsGroup(page, settings) {
    const group = new Adw.PreferencesGroup({
      title: 'Defaults',
      description: 'Applied to every clock without its own per-timezone override below.',
    });
    group.set_name('tzprefs-defaults-group');
    page.add(group);

    // Every control here writes back through serializeFormatting()
    // (formatting.js), which sanitizes defensively regardless of whether
    // the in-memory value is already sanitized -- see requirement 2 (all
    // writes go through the Phase 1 sanitizers).
    const readDefaults = () => parseFormatting(settings.get_string('formatting-defaults'));
    const updateDefaultsField = (field, value) => {
      settings.set_string('formatting-defaults', serializeFormatting({ ...readDefaults(), [field]: value }));
    };

    const initial = readDefaults();

    // --- Separator picker ---
    const separatorModel = new Gtk.StringList({
      strings: SEPARATORS.map((entry) => `${entry.label}  "${entry.value.trim()}"`),
    });
    const separatorRow = new Adw.ComboRow({
      title: 'Separator',
      subtitle: 'Character shown between panel clock entries',
      model: separatorModel,
    });
    nameWidget(separatorRow, 'tzprefs-separator', 'Panel separator');

    const storedSeparatorId = settings.get_string('separator');
    const effectiveSeparatorId = getSeparatorById(storedSeparatorId) ? storedSeparatorId : DEFAULT_SEPARATOR_ID;
    const initialSeparatorIndex = SEPARATORS.findIndex((entry) => entry.id === effectiveSeparatorId);
    separatorRow.selected = initialSeparatorIndex >= 0 ? initialSeparatorIndex : 0;

    // `.selected` is set (above) BEFORE this 'notify::selected' handler
    // is connected (below), so the initial sync from GSettings does not
    // itself trigger a write-back -- opening prefs and changing nothing
    // never touches the 'separator' key (requirement 5, backward
    // compatibility). Only a real, later user selection change reaches
    // this handler.
    separatorRow.connect('notify::selected', () => {
      const entry = SEPARATORS[separatorRow.selected];
      if (entry) {
        settings.set_string('separator', entry.id);
      }
    });
    group.add(separatorRow);

    // --- Font size ---
    const sizeAdjustment = new Gtk.Adjustment({
      lower: SIZE_ADJUSTMENT_LOWER,
      upper: SIZE_ADJUSTMENT_UPPER,
      step_increment: 1,
      page_increment: 4,
      value: sanitizeFontSize(initial.size),
    });
    const sizeRow = new Adw.SpinRow({
      title: 'Font size',
      subtitle: `0 = inherit theme default; otherwise ${MIN_FONT_SIZE}-${MAX_FONT_SIZE} pt`,
      adjustment: sizeAdjustment,
      climb_rate: 1,
      digits: 0,
    });
    nameWidget(sizeRow, 'tzprefs-global-size', 'Default font size');
    sizeRow.connect('notify::value', () => {
      updateDefaultsField('size', sanitizeFontSize(sizeRow.value));
    });
    group.add(sizeRow);

    // --- Color ---
    const colorRow = this._buildColorRow({
      title: 'Color',
      subtitle: 'Leave unset to inherit the theme color',
      name: 'tzprefs-global-color',
      accessibleLabel: 'Default text color',
      initialHex: sanitizeColor(initial.color),
      onChange: (hex) => updateDefaultsField('color', hex),
      onClear: () => updateDefaultsField('color', ''),
    });
    group.add(colorRow);

    // --- Bold toggles ---
    group.add(
      this._buildBoldRow({
        title: 'Bold city',
        name: 'tzprefs-global-bold-city',
        active: Boolean(initial.boldCity),
        onChange: (v) => updateDefaultsField('boldCity', v),
      })
    );
    group.add(
      this._buildBoldRow({
        title: 'Bold time',
        name: 'tzprefs-global-bold-time',
        active: Boolean(initial.boldTime),
        onChange: (v) => updateDefaultsField('boldTime', v),
      })
    );
    group.add(
      this._buildBoldRow({
        title: 'Bold zone',
        name: 'tzprefs-global-bold-zone',
        active: Boolean(initial.boldZone),
        onChange: (v) => updateDefaultsField('boldZone', v),
      })
    );
  }

  // -----------------------------------------------------------------
  // Per-zone formatting overrides ('formatting')
  // -----------------------------------------------------------------

  _buildPerZoneGroup(page, settings) {
    const group = new Adw.PreferencesGroup({
      title: 'Per-Zone Formatting',
      description: 'Overrides the defaults above for a single configured clock.',
    });
    group.set_name('tzprefs-perzone-group');
    page.add(group);

    // Only CONFIGURED (active) zones -- the 'timezones' key is the same
    // ordered, authoritative active-zone list extension.js's
    // `this._activeOrder` is loaded from (see its `_loadSettings()`); this
    // process has no access to that in-memory state, so it is re-read
    // directly from GSettings here.
    //
    // Filtered against KNOWN_ZONES before use, mirroring extension.js's
    // own convention of dropping unknown/stale dconf zone entries (see
    // "stale/foreign dconf entry" in _loadSettings()) rather than trusting
    // them. This matters here specifically because each zone id becomes an
    // Adw.ExpanderRow.title below, and libadwaita interprets row titles as
    // Pango markup -- a hand-edited/tampered dconf 'timezones' entry could
    // otherwise inject markup or produce a Gtk-WARNING from malformed
    // markup. Known zone ids are plain ASCII (letters/digits/'/'/'_'/'+'/
    // '-'), so filtering to KNOWN_ZONES is sufficient on its own (no
    // separate escaping needed for the title, unlike free-form user text).
    const activeZones = settings.get_strv('timezones').filter((zone) => KNOWN_ZONES.has(zone));

    if (activeZones.length === 0) {
      const emptyRow = new Adw.ActionRow({
        title: 'No timezones configured',
        subtitle: 'Add a clock from the panel menu’s search field first.',
      });
      emptyRow.set_name('tzprefs-perzone-empty');
      group.add(emptyRow);
      return;
    }

    activeZones.forEach((zone) => this._buildZoneExpander(group, settings, zone));
  }

  _buildZoneExpander(group, settings, zone) {
    const widgetId = zoneToWidgetId(zone);

    // Read-modify-write helpers scoped to this single zone. Every write
    // goes through setZoneFormatting() (formatting.js), which returns a
    // NEW map with only `zone`'s entry touched -- every other zone's
    // entry in the 'formatting' a{ss} map is read back verbatim and
    // preserved (requirement 4). Passing `null` removes the entry
    // entirely rather than storing a neutral blob (requirement 5 /
    // "clear override" below), so the zone correctly falls back to
    // 'formatting-defaults' via getEffectiveFormatting() -- the exact
    // same precedence rule extension.js's `_getEffectiveFormatting()`
    // delegates to (see formatting.js).
    const readFormattingMap = () => settings.get_value('formatting').deep_unpack();
    const writeFormattingMap = (map) => settings.set_value('formatting', new GLib.Variant('a{ss}', map));
    const hasOverride = () => Object.prototype.hasOwnProperty.call(readFormattingMap(), zone);
    const readEffective = () => {
      const defaults = parseFormatting(settings.get_string('formatting-defaults'));
      return getEffectiveFormatting(zone, readFormattingMap(), defaults);
    };

    const expander = new Adw.ExpanderRow({
      title: zone,
      subtitle: hasOverride() ? 'Custom formatting' : 'Using defaults',
    });
    nameWidget(expander, `tzprefs-expander-${widgetId}`, `Formatting for ${zone}`);
    group.add(expander);

    const refreshSubtitle = () => {
      expander.subtitle = hasOverride() ? 'Custom formatting' : 'Using defaults';
    };

    // Guards the "Clear override" reset block below: programmatically
    // resetting every control's displayed value back to the effective
    // default (so the UI updates immediately) would otherwise trigger
    // each control's own 'notify::value'/'notify::rgba'/'notify::active'
    // handler and re-commit that (already-default) value as a brand-new
    // per-zone override -- silently undoing the clear by re-adding an
    // override that merely happens to numerically match the defaults
    // right now (and would stop tracking future default changes). While
    // this flag is true, commitField()/the color row's onChange are
    // no-ops.
    let suppressCommit = false;

    // Sanitizes `value`, folds it into whatever override this zone
    // already has, writes the whole map back read-modify-write style, and
    // refreshes the expander's "Custom formatting"/"Using defaults"
    // subtitle to match.
    //
    // IMPORTANT: a per-zone override is stored as a WHOLE blob (the
    // 'formatting' a{ss} map's values are complete formatting objects,
    // not per-field diffs -- see setZoneFormatting()'s doc comment in
    // formatting.js). So the first time a zone gets an override, `current`
    // is seeded from readEffective() (what the row controls are actually
    // showing right now -- the current global defaults, since no
    // per-zone override exists yet) rather than from DEFAULT_FORMATTING's
    // neutral shape. This is deliberate: it makes the write match what
    // the user visually sees (e.g. if "Bold time" is currently ON because
    // the global default is ON, changing only this zone's font size must
    // not silently flip its bold-time to off). The direct, documented
    // consequence is that setting a single per-zone field "locks in" the
    // *current* global defaults for every other field at the moment of
    // that edit -- this zone's override stops tracking the global
    // defaults for those other fields from then on, exactly like any
    // other per-zone override.
    const commitField = (field, value) => {
      if (suppressCommit) {
        return;
      }
      const map = readFormattingMap();
      const current = Object.prototype.hasOwnProperty.call(map, zone) ? parseFormatting(map[zone]) : readEffective();
      writeFormattingMap(setZoneFormatting(map, zone, { ...current, [field]: value }));
      refreshSubtitle();
    };

    const effective = readEffective();

    // --- Font size ---
    const sizeAdjustment = new Gtk.Adjustment({
      lower: SIZE_ADJUSTMENT_LOWER,
      upper: SIZE_ADJUSTMENT_UPPER,
      step_increment: 1,
      page_increment: 4,
      value: sanitizeFontSize(effective.size),
    });
    const sizeRow = new Adw.SpinRow({
      title: 'Font size',
      subtitle: `0 = inherit default; otherwise ${MIN_FONT_SIZE}-${MAX_FONT_SIZE} pt`,
      adjustment: sizeAdjustment,
      climb_rate: 1,
      digits: 0,
    });
    nameWidget(sizeRow, `tzprefs-size-${widgetId}`, `Font size for ${zone}`);
    sizeRow.connect('notify::value', () => {
      commitField('size', sanitizeFontSize(sizeRow.value));
    });
    expander.add_row(sizeRow);

    // --- Color ---
    const colorRow = this._buildColorRow({
      title: 'Color',
      subtitle: 'Leave unset to inherit the default color',
      name: `tzprefs-color-${widgetId}`,
      accessibleLabel: `Text color for ${zone}`,
      initialHex: sanitizeColor(effective.color),
      onChange: (hex) => commitField('color', hex),
      onClear: () => commitField('color', ''),
    });
    expander.add_row(colorRow);

    // --- Bold toggles ---
    const boldCityRow = this._buildBoldRow({
      title: 'Bold city',
      name: `tzprefs-bold-city-${widgetId}`,
      active: Boolean(effective.boldCity),
      onChange: (v) => commitField('boldCity', v),
    });
    expander.add_row(boldCityRow);

    const boldTimeRow = this._buildBoldRow({
      title: 'Bold time',
      name: `tzprefs-bold-time-${widgetId}`,
      active: Boolean(effective.boldTime),
      onChange: (v) => commitField('boldTime', v),
    });
    expander.add_row(boldTimeRow);

    const boldZoneRow = this._buildBoldRow({
      title: 'Bold zone',
      name: `tzprefs-bold-zone-${widgetId}`,
      active: Boolean(effective.boldZone),
      onChange: (v) => commitField('boldZone', v),
    });
    expander.add_row(boldZoneRow);

    // --- Clear override ---
    const clearRow = new Adw.ActionRow({
      title: 'Clear override',
      subtitle: 'Remove this zone’s custom formatting and fall back to the defaults above',
    });
    const clearButton = new Gtk.Button({
      icon_name: 'edit-clear-symbolic',
      valign: Gtk.Align.CENTER,
      css_classes: ['flat'],
    });
    nameWidget(clearButton, `tzprefs-clear-${widgetId}`, `Clear formatting override for ${zone}`);
    clearButton.connect('clicked', () => {
      // setZoneFormatting(map, zone, null) REMOVES the entry entirely
      // (rather than writing a neutral blob back) -- see formatting.js's
      // doc comment. This is what makes the zone fall back to
      // 'formatting-defaults' again.
      writeFormattingMap(setZoneFormatting(readFormattingMap(), zone, null));

      // Reset every control's displayed value to the (now-effective)
      // default, so the UI immediately reflects the cleared state without
      // requiring the row to be re-opened. Wrapped in the suppressCommit
      // guard (see its own comment above) so these programmatic value
      // changes -- which each fire their own 'notify::value'/
      // 'notify::rgba'/'notify::active' signal -- do NOT re-commit a
      // brand-new per-zone override that merely happens to match the
      // defaults right now; the entry the click just removed above must
      // stay removed.
      suppressCommit = true;
      const nowEffective = readEffective();
      sizeAdjustment.value = sanitizeFontSize(nowEffective.size);
      this._setColorWidgetHex(colorRow._tzColorWidget, sanitizeColor(nowEffective.color));
      boldCityRow.active = Boolean(nowEffective.boldCity);
      boldTimeRow.active = Boolean(nowEffective.boldTime);
      boldZoneRow.active = Boolean(nowEffective.boldZone);
      suppressCommit = false;
      refreshSubtitle();
    });
    clearRow.add_suffix(clearButton);
    clearRow.activatable_widget = clearButton;
    expander.add_row(clearRow);
  }

  // -----------------------------------------------------------------
  // Shared row builders
  // -----------------------------------------------------------------

  // Builds an Adw.ActionRow with a Gtk.ColorDialogButton (GTK 4.10+) when
  // available, degrading to a Gtk.ColorButton on older GTK4, plus an
  // explicit "clear" button (since a color chooser alone offers no way to
  // express "" / inherit). `onChange` receives an ALREADY-sanitized
  // '#rrggbb' hex string -- requirement 2: color is validated before ever
  // reaching the caller's write.
  _buildColorRow({ title, subtitle, name, accessibleLabel, initialHex, onChange, onClear }) {
    const row = new Adw.ActionRow({ title, subtitle });
    row.set_name(`${name}-row`);

    const hasColorDialogButton = typeof Gtk.ColorDialogButton === 'function';

    let colorWidget;
    if (hasColorDialogButton) {
      colorWidget = new Gtk.ColorDialogButton({
        dialog: new Gtk.ColorDialog({ with_alpha: false }),
        valign: Gtk.Align.CENTER,
      });
    } else {
      // Gtk.ColorButton fallback for GTK4 builds older than 4.10.
      colorWidget = new Gtk.ColorButton({ use_alpha: false, valign: Gtk.Align.CENTER });
    }
    nameWidget(colorWidget, name, accessibleLabel);
    this._setColorWidgetHex(colorWidget, initialHex);

    // Guards the "clear" button below: programmatically resetting the
    // swatch back to black after clearing would otherwise fire
    // 'notify::rgba'/'color-set' and immediately re-commit a real color,
    // undoing the clear it was meant to perform.
    let suppressLocalCommit = false;

    const commitFromWidget = () => {
      if (suppressLocalCommit) {
        return;
      }
      // rgbaToHex() (formatting.js) clamps out-of-range floats and always
      // returns a strict lowercase '#rrggbb' string that sanitizeColor()
      // accepts unchanged (verified in tests/run-tests.js); sanitizeColor()
      // is still applied here too, defense-in-depth, matching every other
      // write path in this file that never trusts a value is already
      // sanitized.
      onChange(sanitizeColor(rgbaToHex(colorWidget.rgba)));
    };

    if (hasColorDialogButton) {
      colorWidget.connect('notify::rgba', commitFromWidget);
    } else {
      colorWidget.connect('color-set', commitFromWidget);
    }

    const clearButton = new Gtk.Button({
      icon_name: 'edit-clear-symbolic',
      valign: Gtk.Align.CENTER,
      css_classes: ['flat'],
      tooltip_text: 'Inherit default color',
    });
    nameWidget(clearButton, `${name}-clear`, `Clear ${accessibleLabel.toLowerCase()}`);
    clearButton.connect('clicked', () => {
      onClear();
      suppressLocalCommit = true;
      this._setColorWidgetHex(colorWidget, '');
      suppressLocalCommit = false;
    });

    row._tzColorWidget = colorWidget;
    row.add_suffix(colorWidget);
    row.add_suffix(clearButton);
    return row;
  }

  _setColorWidgetHex(colorWidget, hex) {
    if (!colorWidget) {
      return;
    }
    colorWidget.rgba = hexToRgba(hex);
  }

  _buildBoldRow({ title, name, active, onChange }) {
    const row = new Adw.SwitchRow({ title, active });
    nameWidget(row, name, title);
    row.connect('notify::active', () => {
      onChange(Boolean(row.active));
    });
    return row;
  }
}
