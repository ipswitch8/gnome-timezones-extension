'use strict';

import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GnomeDesktop from 'gi://GnomeDesktop?version=4.0';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import timezones from './timezones.js';
import cityAliases from './cityAliases.js';

// Whitelist of the only config keys this extension ever reads/writes.
// Anything else present in the 'config' GSettings value (e.g. from a
// tampered/foreign dconf entry) is ignored rather than blindly copied.
const CONFIG_KEYS = ['format24', 'showCity', 'showTimezone'];

// Maximum length of a user-supplied per-zone display label (Feature B).
// Long enough for short custom names ("Home", "Mom's house") while keeping
// the panel label and menu rows from growing unreasonably wide.
const MAX_LABEL_LENGTH = 32;

// Characters stripped from a label before it is ever rendered into an
// St.Label: C0 controls (incl. newline/tab), DEL and C1 controls, bidi
// override/isolate characters (which could visually reorder/hide
// surrounding panel text), zero-width spaces/joiners, and the BOM.
// Built from numeric code point ranges (rather than a regex literal
// containing the raw characters) so the source file never carries
// invisible/control bytes itself.
const UNSAFE_LABEL_RANGES = [
  [0x0000, 0x001f], // C0 controls
  [0x007f, 0x009f], // DEL + C1 controls
  [0x200b, 0x200d], // zero-width space/non-joiner/joiner
  [0x202a, 0x202e], // bidi embedding/override controls
  [0x2066, 0x2069], // bidi isolate controls
  [0xfeff, 0xfeff] // BOM / zero-width no-break space
];

const UNSAFE_LABEL_CHARS = new RegExp(
  `[${UNSAFE_LABEL_RANGES.map(([start, end]) => `\\u{${start.toString(16)}}-\\u{${end.toString(16)}}`).join('')}]`,
  'gu'
);

export default class TimezonesExtension extends Extension {
  enable() {
    this._config = {
      format24: true,
      showCity: true,
      showTimezone: false
    };
    this._hint = '';
    this._labels = {};

    // Invert the city-alias map once (zone -> ' city1 city2 ...') so each
    // zone's combined search string is built in a single O(n) pass over
    // cityAliases, rather than scanning all ~1.3k aliases per zone
    // (O(n*m)) inside the state-building loop below.
    let aliasesByZone = new Map();
    Object.keys(cityAliases).forEach((city) => {
      let zone = cityAliases[city];
      let existing = aliasesByZone.get(zone);
      aliasesByZone.set(zone, existing ? `${existing} ${city}` : city);
    });

    this._state = timezones.sort().map((item) => {
      let lowerTimezone = item.toLowerCase();
      let extraCities = aliasesByZone.get(item);
      return {
        timezone: item,
        // Precomputed once per zone: the zone id plus any alias city
        // names that map to it, used for menu filtering (Feature A).
        searchText: extraCities ? `${lowerTimezone} ${extraCities}` : lowerTimezone,
        active: item === 'UTC'
      };
    });

    this._settings = this.getSettings();

    this._loadSettings();

    let button = new PanelMenu.Button(0.5, this.metadata.name);
    button.set_y_align(Clutter.ActorAlign.CENTER);

    let label = new St.Label({
      text: '...',
      opacity: 150
    });
    button.add_child(label);

    this._button = button;
    this._label = label;

    this._initMenu();
    this._updateLabel();

    this._systemClock = new GnomeDesktop.WallClock();
    this._signalId = this._systemClock.connect('notify::clock', () => this._updateLabel());

    Main.panel.addToStatusArea(`${this.metadata.name} Indicator`, this._button, 1, 'center');
  }

  disable() {
    if (this._systemClock && this._signalId) {
      this._systemClock.disconnect(this._signalId);
    }
    this._signalId = null;
    this._systemClock = null;

    if (this._menu && this._menuOpenStateId) {
      this._menu.disconnect(this._menuOpenStateId);
    }
    this._menuOpenStateId = null;

    this._saveSettings();

    if (this._button) {
      this._button.destroy();
    }

    this._button = null;
    this._label = null;
    this._menu = null;
    this._activeMenu = null;
    this._inactiveMenu = null;
    this._configMenu = null;
    this._state = null;
    this._settings = null;
    this._config = null;
    this._hint = null;
    this._labels = null;
  }

  _loadSettings() {
    let timezonesVariant = this._settings.get_value('timezones');
    let timezonesArray = timezonesVariant.deep_unpack();
    if (timezonesArray.length > 0) {
      this._state.forEach((item) => {
        item.active = timezonesArray.indexOf(item.timezone) !== -1;
      });
    }

    let configVariant = this._settings.get_value('config');
    let configObj = configVariant.deep_unpack();
    CONFIG_KEYS.forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(configObj, key)) {
        this._config[key] = Boolean(configObj[key]);
      }
    });

    let labelsVariant = this._settings.get_value('labels');
    let labelsObj = labelsVariant.deep_unpack();
    this._labels = {};
    Object.keys(labelsObj).forEach((zone) => {
      // Only keep labels for zones this extension actually knows about;
      // a foreign/stale dconf entry referencing an unknown zone id is
      // dropped rather than carried forward.
      if (!this._state.some((item) => item.timezone === zone)) {
        return;
      }

      let sanitized = this._sanitizeLabel(labelsObj[zone]);
      if (sanitized.length > 0) {
        this._labels[zone] = sanitized;
      }
    });
  }

  // Strips control/bidi/zero-width characters that must never reach an
  // St.Label, trims whitespace, and caps the result at MAX_LABEL_LENGTH
  // (32) characters. Applied both when loading a label from GSettings and
  // when committing a newly-edited one, so no unsanitized value can ever
  // be stored or rendered.
  _sanitizeLabel(text) {
    if (typeof text !== 'string') {
      return '';
    }

    return text.replace(UNSAFE_LABEL_CHARS, '').trim().slice(0, MAX_LABEL_LENGTH);
  }

  // Sanitizes rawText and commits it as the display label for `zone`; an
  // empty-after-sanitize value deletes the existing label instead of
  // storing an empty string. Mirrors the acceptance-criteria commit order:
  // sanitize -> set/delete -> save -> refresh time labels -> rebuild the
  // active menu -> refresh the panel label.
  _setLabel(zone, rawText) {
    let sanitized = this._sanitizeLabel(rawText);
    if (sanitized.length > 0) {
      this._labels[zone] = sanitized;
    } else {
      delete this._labels[zone];
    }

    this._saveSettings();
    this._updateTimeLabels();
    this._updateActiveMenu();
    this._updateLabel();
  }

  _saveSettings() {
    if (!this._settings || !this._state || !this._config || !this._labels) {
      return;
    }

    this._settings.set_value(
      'timezones',
      new GLib.Variant(
        'as',
        this._state.filter((item) => item.active).map((item) => item.timezone)
      )
    );

    this._settings.set_value('config', new GLib.Variant('a{sb}', this._config));
    this._settings.set_value('labels', new GLib.Variant('a{ss}', this._labels));
  }

  _initMenu() {
    this._menu = this._button.menu;
    this._activeMenu = this._createScrollableMenuSection();
    this._inactiveMenu = this._createScrollableMenuSection();
    this._configMenu = this._createScrollableMenuSection();
    this._configMenu.itemActivated = () => {};

    this._addConfigSwitch({ label: '24 hours format', name: 'format24' });
    this._addConfigSwitch({ label: 'Show city name', name: 'showCity' });
    this._addConfigSwitch({ label: 'Show timezone', name: 'showTimezone' });
    this._activeMenu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Active clocks'));

    let inputFilter = new St.Entry({ width: 300, can_focus: true });
    inputFilter.clutter_text.connect('text-changed', (o) => {
      this._hint = o.get_text().toLowerCase();
      this._updateInactiveMenu();
    });

    let inputFilterItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
    inputFilterItem.add_child(inputFilter);

    this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Active clocks'));
    this._menu.addMenuItem(this._activeMenu);
    this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Add more clocks'));
    this._menu.addMenuItem(inputFilterItem);
    this._menu.addMenuItem(this._inactiveMenu);
    this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Config'));
    this._menu.addMenuItem(this._configMenu);
    this._configMenu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(''));
    this._configMenu.addAction('Clear clocks', () => this._clearClocks());

    this._menuOpenStateId = this._menu.connect('open-state-changed', (menu, open) => {
      if (open) {
        inputFilter.set_text('');
        this._hint = '';
        this._updateMenu();
      }
    });
  }

  _addConfigSwitch({ label, name }) {
    let configSwitch = new PopupMenu.PopupSwitchMenuItem(label, this._config[name]);
    configSwitch.connect('toggled', (item, state) => {
      this._config[name] = state;
      this._saveSettings();
      this._updateLabel();
    });
    this._configMenu.addMenuItem(configSwitch);
  }

  _createScrollableMenuSection() {
    let menu = new PopupMenu.PopupMenuSection();
    menu.actor = new St.ScrollView({
      style_class: 'popup-menu-content',
      hscrollbar_policy: St.PolicyType.NEVER,
      vscrollbar_policy: St.PolicyType.AUTOMATIC
    });
    // St.ScrollView only allocates the actor in its 'child' property;
    // a generic add_child() leaves the box unallocated (invisible) on
    // GNOME 46+. set_child() also works on 45 via the St.Bin parent.
    menu.actor.set_child(menu.box);
    return menu;
  }

  _updateLabel() {
    let text = '';
    this._state.forEach((item) => (text += item.active ? `    ${this._getLabelForTimezone({ item: item })}` : ''));
    text = text.trim();

    if (text.length === 0) {
      text = '...';
    }

    this._label.text = text;
  }

  _getLabelForTimezone({ item, full }) {
    let glibTimezone = GLib.TimeZone.new(item.timezone);
    let now = GLib.DateTime.new_now(glibTimezone);
    let alias = this._labels ? this._labels[item.timezone] : undefined;
    let timezoneLabel;

    if (full) {
      // Full form (active-clock menu rows): always show the zone id so
      // it stays identifiable; when a custom alias is set, prefix it and
      // keep the zone id visible in parens, e.g. "Home (America/Los_Angeles)".
      timezoneLabel = alias ? `${alias} (${item.timezone})` : item.timezone;
    } else {
      // Panel form: the alias substitutes for the city-name segment, so
      // it still respects the "Show city name" toggle like the text it
      // replaces.
      timezoneLabel = this._config.showCity ? alias || item.timezone.split('/').pop().replace('_', ' ') : '';
    }

    let offset = full || this._config.showTimezone ? ` ${now.format('%Z')} ` : ' ';
    return `${timezoneLabel}${offset}${now.format(this._config.format24 ? '%R' : '%l:%M %p')}`;
  }

  _updateMenu() {
    this._updateTimeLabels();
    this._updateActiveMenu();
    this._updateInactiveMenu();
  }

  _updateTimeLabels() {
    this._state.forEach((item) => (item.label = this._getLabelForTimezone({ item: item, full: true })));
  }

  _updateActiveMenu() {
    let active = String.fromCodePoint(parseInt('2714', 16));
    this._activeMenu.removeAll();

    this._state.filter((item) => item.active).forEach((item) => this._addActiveMenuRow(item, active));
  }

  // Builds one active-clock row as a custom PopupBaseMenuItem: a label
  // (checkmark + time, or an inline St.Entry while editing) plus a small
  // edit button. Replaces the previous addAction() rows so the label can
  // be swapped for an editable St.Entry per row.
  _addActiveMenuRow(item, activeMark) {
    let menuItem = new PopupMenu.PopupBaseMenuItem();

    let label = new St.Label({
      text: `${activeMark} ${item.label}`,
      x_expand: true,
      y_align: Clutter.ActorAlign.CENTER
    });
    menuItem.add_child(label);

    let entry = new St.Entry({
      can_focus: true,
      x_expand: true,
      y_align: Clutter.ActorAlign.CENTER,
      visible: false
    });
    menuItem.add_child(entry);

    let editIcon = new St.Icon({
      icon_name: 'document-edit-symbolic',
      style_class: 'popup-menu-icon'
    });
    let editButton = new St.Button({
      style_class: 'button',
      child: editIcon,
      reactive: true,
      can_focus: true,
      track_hover: true
    });
    menuItem.add_child(editButton);

    let enterEditMode = () => {
      entry.set_text(this._labels[item.timezone] || '');
      label.visible = false;
      entry.visible = true;
      entry.grab_key_focus();
    };

    // Guards the key-focus-out handler below: committing destroys and
    // rebuilds this row synchronously (via _updateActiveMenu), which can
    // itself cause this entry to lose key focus as it's torn down. Without
    // this flag that would re-enter cancelEdit() on an already-destroyed
    // actor.
    let committed = false;

    let cancelEdit = () => {
      if (committed) {
        return;
      }
      entry.visible = false;
      label.visible = true;
    };

    let commitEdit = () => {
      committed = true;
      // _setLabel() saves settings and calls _updateActiveMenu(), which
      // rebuilds every row (including this one), so no further local
      // cleanup of `entry`/`label` is needed here.
      this._setLabel(item.timezone, entry.get_text());
    };

    entry.clutter_text.connect('key-press-event', (actor, event) => {
      let symbol = event.get_key_symbol();
      if (symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter) {
        commitEdit();
        return Clutter.EVENT_STOP;
      }
      if (symbol === Clutter.KEY_Escape) {
        cancelEdit();
        return Clutter.EVENT_STOP;
      }
      return Clutter.EVENT_PROPAGATE;
    });

    // Losing keyboard focus (click elsewhere, menu closing, Tab away)
    // cancels the edit rather than committing it, so an accidental
    // focus-out can never silently save a half-typed value. Only Enter
    // (via the handler above) commits.
    entry.clutter_text.connect('key-focus-out', () => cancelEdit());

    // St.Button consumes its own button-press/release events (it returns
    // Clutter.EVENT_STOP internally as part of normal button behavior),
    // so a click on the edit icon never bubbles up to trigger this
    // PopupBaseMenuItem's 'activate' handler below. Only clicks that land
    // on the row itself (i.e. the label area, since the entry likewise
    // consumes its own clicks while visible) toggle the zone off.
    editButton.connect('clicked', () => enterEditMode());

    menuItem.connect('activate', () => this._toggleTimezone(item));

    this._activeMenu.addMenuItem(menuItem);
  }

  _updateInactiveMenu() {
    this._inactiveMenu.removeAll();
    this._state
      .filter((item) => !item.active && item.searchText.indexOf(this._hint) !== -1)
      .forEach((item) => this._inactiveMenu.addAction(item.label, () => this._toggleTimezone(item)));
  }

  _toggleTimezone(item) {
    item.active = !item.active;
    this._updateLabel();
    this._saveSettings();
  }

  _clearClocks() {
    this._state.forEach((item) => (item.active = false));
    this._updateMenu();
    this._updateLabel();
    this._saveSettings();
  }
}
