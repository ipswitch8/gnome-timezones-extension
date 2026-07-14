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

// Whitelist of the only config keys this extension ever reads/writes.
// Anything else present in the 'config' GSettings value (e.g. from a
// tampered/foreign dconf entry) is ignored rather than blindly copied.
const CONFIG_KEYS = ['format24', 'showCity', 'showTimezone'];

export default class TimezonesExtension extends Extension {
  enable() {
    this._config = {
      format24: true,
      showCity: true,
      showTimezone: false
    };
    this._hint = '';

    this._state = timezones.sort().map((item) => {
      return {
        timezone: item,
        lowerTimezone: item.toLowerCase(),
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
  }

  _saveSettings() {
    if (!this._settings || !this._state || !this._config) {
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
    let timezoneLabel = full ? item.timezone : this._config.showCity ? item.timezone.split('/').pop().replace('_', ' ') : '';
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

    this._state
      .filter((item) => item.active)
      .forEach((item) => this._activeMenu.addAction(`${active} ${item.label}`, () => this._toggleTimezone(item)));
  }

  _updateInactiveMenu() {
    this._inactiveMenu.removeAll();
    this._state
      .filter((item) => !item.active && item.lowerTimezone.indexOf(this._hint) !== -1)
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
