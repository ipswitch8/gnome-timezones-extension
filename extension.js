'use strict';

import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import GnomeDesktop from 'gi://GnomeDesktop?version=4.0';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import timezones from './timezones.js';
import cityAliases from './cityAliases.js';
import {
  escapeMarkup,
  parseFormatting,
  sanitizeFormatting,
  sanitizeColor,
  sanitizeFontSize,
  serializeFormatting,
  DEFAULT_FORMATTING,
  buildEntryText,
  buildEntryMarkup,
  getEffectiveFormatting,
  orderedEntrySegments,
} from './formatting.js';
import { SEPARATORS, resolveSeparatorValue } from './separators.js';
import { buildHoverPopupCells } from './hoverPopup.js';
// KAREN-GATE FIX (round 4, live-testing report): formattingPresets.js
// (FONT_SIZE_PRESETS/COLOR_PALETTE/resolvePresetId) was ONLY ever used by
// the popup menu's own "Font size"/"Color" submenus (round 2), both
// removed in round 3 -- see the this._separatorMenuItems field comment
// further down for the full history. A round-3 comment here claimed
// "prefs.js still imports and uses formattingPresets.js directly" --
// that claim was never actually verified and was FALSE: prefs.js has
// never imported formattingPresets.js at all (it uses a plain
// Adw.SpinRow for font size and its own color-chooser widget, not a
// curated preset list). With formattingPresets.js's only real caller
// gone, nothing in this project imports it any more, so the module
// itself (and its dedicated tests in tests/run-tests.js) was removed
// rather than left as dead code nothing reaches.

// Whitelist of the only config keys this extension ever reads/writes.
// Anything else present in the 'config' GSettings value (e.g. from a
// tampered/foreign dconf entry) is ignored rather than blindly copied.
const CONFIG_KEYS = ['format24', 'showCity', 'showTimezone', 'hideSystemClock', 'showSeparator', 'showHoverPopup', 'showWeekday'];

// Delay (ms) between the pointer entering the panel button and the hover
// popup actually opening -- mirrors the ordinary "tooltip" convention of
// not popping something up on a merely transient hover/pass-through.
// GLib.timeout_add()'s id is tracked in this._hoverShowTimeoutId and MUST
// be removed via GLib.Source.remove() on hide, on disable(), and before
// scheduling a new one -- see _scheduleHoverPopupShow()/
// _cancelHoverPopupShowTimeout() below (a leaked timeout here is an
// automatic e.g.o review failure, shexli EGO-L-003, exactly like every
// other timer/signal this file already tracks explicitly).
const HOVER_POPUP_SHOW_DELAY_MS = 400;

// Minimum gap between consecutive console.error() calls logging a panel
// markup parse failure (see _logMarkupFailureThrottled()). _updateLabel()
// runs on every clock tick, so this bounds journal spam if that
// should-be-unreachable branch is ever hit continuously.
const MARKUP_FAILURE_LOG_INTERVAL_SECONDS = 300;

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

// Checkmark prefix used for already-active zones, shared by the active-clock
// rows and the search-result rows (a checkmarked search result is already
// active; clicking it toggles it off, same as clicking it in Active clocks).
const ACTIVE_MARK = String.fromCodePoint(0x2714);

export default class TimezonesExtension extends Extension {
  enable() {
    this._config = {
      format24: true,
      showCity: true,
      showTimezone: false,
      hideSystemClock: false,
      showSeparator: false,
      // Hover-popup feature: a genuine 'config' a{sb} boolean, same
      // shape/pattern as every switch above -- OFF by default (feature
      // spec requirement). Whether hovering the panel clock shows a
      // BoxPointer-based popup listing every ACTIVE zone's current DATE
      // ONLY (no time, no name/city text -- that already lives in the
      // panel itself), in this._activeOrder order (reusing the SAME
      // 'date-format' key/resolveDateFormat()/formatDateForDisplay()
      // machinery every other date-rendering call site in this file
      // already uses -- see hoverPopup.js). See _initHoverPopup()/
      // _showHoverPopup()/_hideHoverPopup() below for the actor/timer/
      // signal plumbing.
      showHoverPopup: false,
      // Hover-popup sub-option: an ordinary 'config' a{sb} boolean, same
      // shape as every other switch here -- OFF by default. When true, the
      // hover popup's DATE segment for every zone is prefixed with the
      // locale-abbreviated short weekday ("Wed 20/07/2026" instead of
      // "20/07/2026"), via dateFormats.js's formatWeekday(); see
      // hoverPopup.js's buildHoverPopupCells() `showWeekday` param for the
      // actual prepend logic. Has no effect while showHoverPopup itself is
      // false (nothing reads it -- the popup isn't built at all).
      showWeekday: false
    };
    this._hint = '';
    this._labels = {};
    // Phase 2 formatting/separator state, populated by _loadSettings()
    // below. this._separatorId is the raw stored 'separator' key value
    // (resolved to a literal at render time via resolveSeparatorValue());
    // this._formatting maps zone id -> normalized formatting object
    // (parseFormatting() output); this._formattingDefaults is the single
    // normalized global-default formatting object.
    this._separatorId = '';
    // Raw stored 'date-format' key value (resolved to a literal
    // GLib.DateTime.format() pattern at render time via
    // resolveDateFormat(), exactly like this._separatorId/
    // resolveSeparatorValue() above). Only ever consulted by the
    // dates-only hover popup -- see _rebuildHoverPopupRow()/hoverPopup.js.
    this._dateFormat = '';
    this._formatting = {};
    this._formattingDefaults = { ...DEFAULT_FORMATTING };
    // Tracks whether WE hid GNOME Shell's own top-bar clock, so disable()
    // only ever restores visibility it actually changed (see
    // _applySystemClockVisibility()).
    this._hidSystemClock = false;
    // name -> PopupSwitchMenuItem, populated by _addConfigSwitch(). Lets
    // _syncConfigSwitches() force every switch's visual state back to
    // match this._config on every menu open, so the toggle visual and the
    // stored value can never permanently desync (see _syncConfigSwitches).
    this._configSwitches = {};
    // Phase 3 popup-menu picker state: id -> PopupMenuItem row, populated
    // by _buildSeparatorSubmenu(). Used by _syncSeparatorSubmenu() the
    // same way this._configSwitches is used by _syncConfigSwitches():
    // forces every row's ornament back to match the authoritative stored
    // value on every menu open and on every external gsettings change, so
    // the visual selection can never permanently desync (see
    // _updateMenu() and the 'changed' handler below).
    //
    // KAREN-GATE FIX -- live-testing report, GNOME Shell 47/x11, 4 rounds
    // total (see _buildSeparatorSubmenu()'s comment and
    // _buildFormattingSubmenu()'s comment for exactly where each row
    // attaches today):
    //   Round 1: a PopupSubMenuMenuItem's own `.menu` is an St.ScrollView;
    //     nesting one inside `this._configMenu` (also an St.ScrollView --
    //     see `_createScrollableMenuSection()` below) collapsed it to a
    //     ~2px invisible viewport. Fixed by moving it to `this._menu`.
    //   Round 2: a second, near-identical submenu ("Formatting", wrapping
    //     "Font size"/"Color") was nested the same way one level deeper.
    //     Fixed by flattening -- no PopupSubMenuMenuItem nested inside
    //     another PopupSubMenu.
    //   Round 3: flattening made the popup's total content tall enough
    //     that on real small-but-common screens (1280x720, 1024x768 --
    //     see tests/README.md's "Minimum supported screen height"
    //     section) GNOME Shell's own top-level available-height budget
    //     squeezed EVERY scrollable section (including
    //     _activeMenu/_inactiveMenu/_configMenu, never part of this bug)
    //     to single-digit pixels -- the identical "opens and shows
    //     nothing" symptom from total content volume, not ScrollView
    //     nesting. Fixed by removing "Font size"/"Color"/the three bold
    //     switches from the popup entirely.
    //   Round 4 (this state, a product decision, not a bug fix): the
    //     three "Bold city"/"Bold time"/"Bold zone" switches are
    //     RESTORED to the popup -- they are plain `PopupSwitchMenuItem`
    //     rows with no `St.ScrollView` of their own (unlike "Font
    //     size"/"Color", which were `PopupSubMenuMenuItem`s), so they
    //     never had the round-1/round-2 nesting defect, and re-measurement
    //     (see tests/README.md) confirmed the popup still renders at
    //     every resolution in the committed matrix with them present.
    //     "Font size" and "Color" remain OUT of the popup permanently --
    //     they were a poor substitute for prefs.js's real `Adw.SpinRow`/
    //     color-chooser widgets even before any of this, and prefs.js's
    //     "Defaults" group (_buildDefaultsGroup()) already provides full,
    //     independently-tested equivalents (plus per-zone overrides the
    //     popup never had), writing the same 'formatting-defaults'
    //     gsetting this extension reads from (_loadSettings()) and
    //     renders. The three bold switches persist into that same
    //     gsetting via _setFormattingDefaultField()/
    //     _saveFormattingDefaults() (restored, see those methods below) --
    //     extension.js WRITES 'formatting-defaults' again, for exactly
    //     these three fields, alongside prefs.js's own direct writes for
    //     size/color/the same three bold flags.
    this._separatorMenuItems = {};
    // Live drag landing-zone indicator (single reused actor, created
    // lazily on first use). See _showDropIndicatorAt()/_clearDropIndicator().
    this._dropIndicator = null;
    // { draggable, dragEndId } entries for every active-clock row's
    // DND.makeDraggable() instance, tracked so its 'drag-end' connection
    // can be explicitly disconnected (see _clearRowDraggables()) rather
    // than left for shexli/EGO-L-003 to flag as unmatched. Populated in
    // _addActiveMenuRow(), cleared in disable() and at the start of every
    // _updateActiveMenu() rebuild (before removeAll() destroys the rows
    // these draggables belong to).
    this._rowDraggables = [];

    // Hover-popup feature state (see _initHoverPopup() and
    // _syncHoverPopupLifecycle()'s own comments further down): the
    // BoxPointer actor + its row container, the pending show-delay
    // GLib.timeout_add() id, and the panel button's own 'notify::hover'
    // connection id. LAZY (karen-gate finding): all four stay null here
    // and are only ever created by _initHoverPopup() when
    // this._config.showHoverPopup is actually true -- never unconditionally
    // on enable() -- and unconditionally torn down in disable() via
    // _teardownHoverPopup() regardless of whether they were ever created,
    // whether the feature is currently toggled on, and whether the popup
    // happens to be showing or a show-timer is pending at the moment
    // disable() runs (see disable()'s own comment).
    this._hoverPopup = null;
    this._hoverPopupBox = null;
    this._hoverShowTimeoutId = null;
    this._hoverSignalId = null;

    // Feature A: flatten cityAliases once into {key, zone, display} rows.
    // cityAliases values are [zone, displayName] tuples keyed by the
    // lowercase search form (which may differ from displayName only in
    // case/diacritics, e.g. 'sao paulo' -> ['America/Sao_Paulo', 'Sao Paulo']).
    // This replaces the old per-zone concatenated search-string approach:
    // _updateInactiveMenu now matches each alias key against the hint
    // directly (one pass over this._aliases) instead of pre-joining city
    // names into every zone's row.
    this._aliases = Object.keys(cityAliases).map((key) => {
      let [zone, display] = cityAliases[key];
      return { key, zone, display };
    });

    this._state = timezones.sort().map((item) => {
      return {
        timezone: item,
        // Plain lowercase zone id, used to match the zone's own row when
        // no alias of it matches the current search hint.
        lower: item.toLowerCase(),
        active: item === 'UTC'
      };
    });

    // O(1) zone-id -> state-item lookup, built once. Feature A's ordered
    // active list (this._activeOrder) stores plain zone ids; this map is
    // how _updateLabel/_updateActiveMenu resolve each id back to its state
    // item (and its precomputed `label`) without a linear scan of
    // this._state (which stays alphabetically sorted for the search list).
    this._stateByZone = new Map(this._state.map((item) => [item.timezone, item]));

    // Authoritative display order for active clocks (Feature A); populated
    // by _loadSettings() below from the stored 'timezones' order.
    this._activeOrder = [];

    this._settings = this.getSettings();

    this._loadSettings();
    this._applySystemClockVisibility();

    let button = new PanelMenu.Button(0.5, this.metadata.name);
    button.set_y_align(Clutter.ActorAlign.CENTER);

    let label = new St.Label({
      text: '...',
      opacity: 150
    });
    button.add_child(label);

    this._button = button;
    this._label = label;

    // karen-gate FIX (round 1: the first-entry-colour fix poisoned
    // itself on the very next tick): _resolveThemeForegroundColorHex()
    // used to read this._label's OWN theme node WHILE an inline colour
    // override from a PREVIOUS _updateLabel() call was still applied to
    // it. St gives an inline style the highest cascade priority, so on
    // the tick AFTER the first entry got a colour, "the theme default"
    // resolved to that colour instead of the real ambient one, and every
    // colourless entry then inherited it -- no theme change or settings
    // change required, an ordinary WallClock tick was enough (confirmed
    // live in the karen-gate sandbox: baseline correct, very next
    // _updateLabel() leaks).
    //
    // karen-gate FIX (round 2: a dedicated colour-probe actor was the
    // new bug): sampling the ambient colour from a separate extra
    // St.Label child of this._button hit a different real bug --
    // PanelMenu.Button uses Clutter.FixedLayout, which cannot allocate a
    // child that is never given an explicit position/size. That
    // unpositioned probe measured with a real NaN allocation box and
    // spammed a real, repeating `Clutter-WARNING **: Can't update stage
    // views ... needs an allocation` into the shell log on every run.
    //
    // karen-gate FIX (round 3: this._button is not a valid stand-in for
    // "what this._label would render"): round 2's replacement -- reading
    // this._button's OWN theme node instead of a probe actor -- assumed
    // style changes propagating from a common ancestor down to both
    // this._button and this._label meant they always resolve the same
    // colour. That is true only for rules that don't distinguish them by
    // type/class. Measured directly (see tests/shell-driver/
    // extension.js's own "does set_style(null) immediately followed by
    // get_theme_node()..." record): loading a real, plausible theme
    // stylesheet with `StLabel { color: #abcdef !important; }` -- the
    // ordinary way a theme targets indicator label text specifically --
    // left this._button's theme node at the OLD colour
    // (buttonAfter=#f2f2f2) while this._label's theme node correctly
    // tracked the change (labelAfter=#abcdef). This._button and
    // this._label are DIFFERENT widgets any type/class selector can
    // legitimately treat differently -- there is no substitute for
    // reading this._label ITSELF.
    //
    // Fix: read this._label's own theme node, but ONLY ever while its
    // inline style is genuinely absent (round 1's mistake was reading it
    // WHILE contaminated, not reading this._label per se).
    // _refreshAmbientForegroundColorHex() below saves whatever inline
    // style is currently applied, clears it, reads the now-uncontaminated
    // theme node, then reapplies the saved style so the visible panel is
    // never affected by this. Measured directly (same diagnostic record
    // referenced above) that this sequencing gives the correct value
    // with NO extra delay needed: set_style(null) immediately followed
    // by get_theme_node().get_foreground_color() already returns the
    // fresh, uncontaminated colour synchronously
    // (immediatelyAfterClear=#abcdef, matching labelAfter exactly) --
    // St's lazy theme-node recomputation happens on set_style()'s own
    // style-changed emission, not deferred to some later idle/paint
    // step.
    //
    // Never done per clock tick: _updateLabel() runs every tick, and a
    // clear/read/reapply cycle both wastes work and is itself a style
    // change that would otherwise re-trigger this same logic --
    // resolved only here (once, at enable()) and from this._label's own
    // 'style-changed' signal below (fires on a real ambient
    // theme/stylesheet change, e.g. light/dark switch). That signal
    // handler must NOT react to style-changed emissions caused by our
    // OWN set_style() calls (round 1's exact self-poisoning shape, one
    // layer up) -- guarded by this._applyingOwnLabelStyle, the same
    // "ignore our own re-entrant emission" pattern this file already
    // uses for this._applyingExternalSettings (see the settings
    // 'changed' handler above/below). _setLabelStyle() is the ONLY
    // method allowed to call this._label.set_style() anywhere in this
    // file, specifically so that guard is never bypassed.
    this._applyingOwnLabelStyle = false;
    this._labelStyleChangedId = label.connect('style-changed', () => {
      if (this._applyingOwnLabelStyle) {
        return;
      }
      this._refreshAmbientForegroundColorHex();
      this._updateLabel();
    });

    this._initMenu();
    this._updateLabel();

    // Phase 3: react to settings changed EXTERNALLY (e.g. dconf-editor,
    // or another instance of this same extension code) so the panel AND
    // every new/existing menu control (separator + font-size + color
    // submenu ornaments, AND the boolean switches -- the 5 original
    // config switches plus the 3 Phase 3 bold switches) stay correct
    // without requiring a menu reopen or extension reload. Calls both
    // _syncConfigSwitches() (switches) and _syncMenuControls() (submenu
    // ornaments) -- mirroring exactly what _updateMenu() already does on
    // every menu open, see below -- so this is the FIRST code path that
    // can resync a stale switch/ornament without the user opening the
    // menu at all.
    //
    // REENTRANCY: this is also the first code path where
    // _syncConfigSwitches() can run OUTSIDE of a user-driven menu-open.
    // PopupSwitchMenuItem.setToggleState() (called by _syncConfigSwitches())
    // sets the underlying Switch's `state` property directly; verified by
    // reading this GNOME Shell's own popupMenu.js (Switch.set state()):
    // it only calls `this.notify('state')` -- which Switch's
    // 'notify::state' handler turns into an emitted 'toggled' signal --
    // when the new value actually DIFFERS from the current one. So
    // setToggleState() is a no-op-emission when the switch is already
    // showing the correct value (the common case), but DOES synchronously
    // emit 'toggled' on exactly the desync case this sync exists to fix --
    // and our _addConfigSwitch() 'toggled' handler writes to gsettings.
    // Without a guard, resyncing a stale switch from an external change
    // would itself trigger a synchronous extra write-back to gsettings
    // (same value, so not an infinite loop -- this._config[name]/
    // this._formattingDefaults would already match on the next pass, so
    // no further notify would fire -- but a redundant write with no
    // purpose). this._applyingExternalSettings guards exactly that
    // synchronous window: the 'toggled' handler below checks it and skips
    // writing while a 'changed'-triggered resync is in progress. Not
    // needed on the pre-existing _updateMenu() (menu-open) call to
    // _syncConfigSwitches() -- this guard only wraps the NEW reentrant
    // path introduced by this 'changed' listener.
    //
    // Connected here (after _initMenu() has built every submenu/switch)
    // so this._separatorMenuItems/this._configSwitches are already
    // populated by the time this could ever fire (a signal connected via .connect()
    // cannot receive emissions that happened before the connection was
    // made, so there is no window where this fires before _initMenu()
    // has run). Disconnected in disable() BEFORE this._settings is
    // nulled, so it can never run against torn-down state -- see the
    // matching teardown block there.
    this._applyingExternalSettings = false;
    this._settingsChangedId = this._settings.connect('changed', () => {
      this._applyingExternalSettings = true;
      try {
        this._loadSettings();
        this._updateLabel();
        this._syncConfigSwitches();
        this._syncMenuControls();
        // External toggle path (karen-gate finding): showHoverPopup can
        // be flipped from dconf/another instance of this same extension,
        // not just this menu's own switch -- _loadSettings() above has
        // already refreshed this._config.showHoverPopup by this point,
        // so this call sees the new value and creates/destroys the popup
        // to match, exactly like the switch's own setValue does for a
        // menu-driven toggle. See _syncHoverPopupLifecycle()'s own
        // comment for the full contract.
        this._syncHoverPopupLifecycle();
      } finally {
        this._applyingExternalSettings = false;
      }
    });

    this._systemClock = new GnomeDesktop.WallClock();
    this._signalId = this._systemClock.connect('notify::clock', () => this._updateLabel());

    Main.panel.addToStatusArea(`${this.metadata.name} Indicator`, this._button, 1, 'center');

    // karen-gate FIX: this._label is only genuinely staged once
    // addToStatusArea() above actually parents this._button (and
    // therefore this._label) into the panel -- get_theme_node() before
    // this point returns nothing usable (see the get_stage() guard in
    // _resolveThemeForegroundColorHex()), and St's 'style-changed'
    // signal only fires on a subsequent INVALIDATION, never for this
    // initial resolution (verified: st-widget.c's
    // get_root_theme_node()/on_theme_context_changed() only calls
    // st_widget_style_changed() in response to a REAL
    // StThemeContext::changed, never as an announcement that a widget's
    // very first style computation has happened) -- so without this,
    // this._ambientForegroundColorHex would stay '' until some
    // unrelated future theme change happened to occur. Resolve it for
    // real now that the label is staged, and re-render so the very
    // first real panel paint already benefits from a correct ambient
    // colour if the first entry has one configured.
    this._refreshAmbientForegroundColorHex();
    this._updateLabel();

    // ORDERING INVARIANT (karen gate, round 4 -- low-severity note, kept
    // as a comment because the current code is correct and a merged
    // single call would lose the pre-staging render):
    //
    // The _updateLabel() above near _initMenu() can run before the label
    // is staged, i.e. before _refreshAmbientForegroundColorHex() has a
    // usable theme node. If a persisted config already gives the FIRST
    // zone a colour, that earlier render computes colourless entries
    // against an unresolved ambient. That intermediate state is never
    // actually painted today only because everything between the two
    // _updateLabel() calls is synchronous JS -- nothing yields to the
    // Clutter frame clock, so the compositor never gets a chance to
    // repaint in between.
    //
    // That is a property of the current code, not something enforced.
    // If a future change inserts an `await`, a GLib.idle_add(), or any
    // other yield between those two calls, the wrong colours become
    // briefly visible as a flash on enable/unlock. If you add one, move
    // the ambient resolve BEFORE the first _updateLabel() (or drop the
    // earlier render) rather than relying on this invariant holding.
  }

  disable() {
    // Restore the system clock's visibility BEFORE the rest of teardown,
    // and only if we were the one who hid it. This runs first because
    // disable() is also called on lock screen (GNOME Shell disables
    // extensions there), so the system clock must reliably come back
    // rather than staying hidden behind a locked screen.
    if (this._hidSystemClock) {
      let clockDisplay = Main.panel.statusArea.dateMenu?._clockDisplay;
      if (clockDisplay) {
        clockDisplay.visible = true;
      }
    }
    this._hidSystemClock = null;

    if (this._systemClock && this._signalId) {
      this._systemClock.disconnect(this._signalId);
    }
    this._signalId = null;
    this._systemClock = null;

    // Phase 3: disconnect the settings 'changed' handler connected in
    // enable() BEFORE this._settings is nulled out below (_saveSettings()
    // near the end of this method still needs it).
    if (this._settings && this._settingsChangedId) {
      this._settings.disconnect(this._settingsChangedId);
    }
    this._settingsChangedId = null;
    this._applyingExternalSettings = null;

    if (this._menu && this._menuOpenStateId) {
      this._menu.disconnect(this._menuOpenStateId);
    }
    this._menuOpenStateId = null;

    // Hover popup teardown -- delegates to _teardownHoverPopup() (the
    // SAME implementation _syncHoverPopupLifecycle() uses when the
    // toggle is switched off at runtime, see its own comment) so there
    // is exactly one teardown implementation, not two. Called
    // unconditionally here, regardless of whether the toggle was ever
    // switched on this session (the popup may never have been created at
    // all -- _teardownHoverPopup() is a clean no-op in that case) and
    // regardless of whether the popup happens to be showing or a
    // show-timer happens to be pending right now (requirement: disable()
    // must be safe mid-show or mid-pending-timer -- proven by the shell-
    // driver's "hover teardown interleaving A/B/C" tests).
    this._teardownHoverPopup();

    // Explicitly torn down before this._button.destroy() below (which
    // would also destroy it as a side effect, since it's parented inside
    // the active menu's box) so there is never a dangling JS reference or
    // a code path that skips cleanup.
    this._clearDropIndicator();

    // shexli (EGO-L-003): disconnect every tracked per-row draggable's
    // 'drag-end' signal before the rows/handles themselves are destroyed
    // below. See _clearRowDraggables() for why this is also called at the
    // start of every _updateActiveMenu() rebuild, not just here.
    this._clearRowDraggables();

    this._saveSettings();

    // karen-gate FIX: this._label's own 'style-changed' handler
    // (enable()) is disconnected BEFORE this._label.destroy() below,
    // same pattern as every other tracked signal in this file (see
    // this._signalId/this._settingsChangedId/this._menuOpenStateId
    // above).
    if (this._label && this._labelStyleChangedId) {
      this._label.disconnect(this._labelStyleChangedId);
    }
    this._labelStyleChangedId = null;

    // shexli (EGO-L-002): this._label is a child of this._button (added via
    // button.add_child(label) in enable()), so this._button.destroy() below
    // already tears it down transitively -- functionally this was already
    // fine. Destroyed explicitly and BEFORE the button anyway, since
    // destroying a child before its parent is safe in Clutter (the parent
    // simply finds it already gone) and this is what makes the static
    // "every enable()-assigned object has a matching disable() destroy"
    // check pass.
    if (this._label) {
      this._label.destroy();
    }

    if (this._button) {
      this._button.destroy();
    }

    this._button = null;
    this._label = null;
    this._ambientForegroundColorHex = null;
    this._applyingOwnLabelStyle = null;
    this._menu = null;
    this._activeMenu = null;
    this._inactiveMenu = null;
    this._configMenu = null;
    this._state = null;
    this._settings = null;
    this._config = null;
    this._hint = null;
    this._labels = null;
    this._aliases = null;
    this._activeOrder = null;
    this._stateByZone = null;
    this._configSwitches = null;
    this._dropIndicator = null;
    this._rowDraggables = null;
    this._separatorId = null;
    this._dateFormat = null;
    this._formatting = null;
    this._formattingDefaults = null;
    this._separatorMenuItems = null;
  }

  _loadSettings() {
    let timezonesVariant = this._settings.get_value('timezones');
    let timezonesArray = timezonesVariant.deep_unpack();

    // Feature A: the stored 'timezones' array order is now authoritative
    // for display order (it used to be read only for membership, then
    // rendered alphabetically). Reconcile it against whatever is active in
    // this._state right now (only the enable()-time default -- UTC -- at
    // this point, since this runs before anything else touches state)
    // so a stored order that's missing a currently-active zone doesn't
    // silently drop that zone from the ordered list.
    let currentActive = this._state.filter((item) => item.active).map((item) => item.timezone);
    this._activeOrder = this._reconcileActiveOrder(timezonesArray, currentActive);

    this._state.forEach((item) => {
      item.active = this._activeOrder.indexOf(item.timezone) !== -1;
    });

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

    // Phase 2: separator + per-entry/global formatting. Resolution to an
    // actual literal value/effective-formatting-object happens at render
    // time (_resolveSeparatorValue()/_getEffectiveFormatting()) -- here we
    // only load and normalize the raw stored values.
    let separatorVariant = this._settings.get_value('separator');
    this._separatorId = separatorVariant.deep_unpack();

    // Date-format: raw stored value only, same "resolve at render time"
    // convention as 'separator' immediately above -- consulted only by
    // the dates-only hover popup (_rebuildHoverPopupRow()/hoverPopup.js's
    // resolveDateFormat(this._dateFormat)).
    let dateFormatVariant = this._settings.get_value('date-format');
    this._dateFormat = dateFormatVariant.deep_unpack();

    let formattingVariant = this._settings.get_value('formatting');
    let formattingObj = formattingVariant.deep_unpack();
    this._formatting = {};
    Object.keys(formattingObj).forEach((zone) => {
      // Same defensive pattern as 'labels' above: drop entries for zones
      // this extension doesn't know about (stale/foreign dconf entry).
      if (!this._state.some((item) => item.timezone === zone)) {
        return;
      }
      this._formatting[zone] = parseFormatting(formattingObj[zone]);
    });

    let formattingDefaultsVariant = this._settings.get_value('formatting-defaults');
    this._formattingDefaults = parseFormatting(formattingDefaultsVariant.deep_unpack());
    // KEEP THIS PRE-PARSE. getEffectiveFormatting() (formatting.js) now
    // accepts either raw JSON strings OR pre-parsed objects for both
    // this._formatting[zone] and this._formattingDefaults -- it no longer
    // REQUIRES this pre-parse for correctness (that was the bug: prefs.js
    // doesn't pre-parse, and used to silently get a raw string back). But
    // _getEffectiveFormatting() is called once per active zone on every
    // _updateLabel() -- i.e. every clock tick (see the WallClock
    // 'notify::clock' handler in enable()) -- so re-running
    // JSON.parse()+sanitizeFormatting() per zone per tick here, instead of
    // once per _loadSettings() call (enable() and every external
    // 'changed' event), would be pure per-tick waste for a value that
    // essentially never changes between ticks. Do not "simplify" this
    // away by deferring the parse into getEffectiveFormatting() calls.
  }

  // Pure reconciliation used when loading settings: takes the stored
  // order (which may reference unknown/removed zones, e.g. from an older
  // timezones.js or a hand-edited dconf entry) and a list of zones that
  // are considered active independent of that order, and produces the
  // reconciled order -- the stored order filtered to zones this extension
  // recognizes (this._stateByZone), followed by any active zone not
  // already present, appended in the order given.
  //
  // INVARIANT: this._activeOrder contains each zone id AT MOST ONCE,
  // always. This is enforced HERE (a single `seen` Set de-duplicates
  // across both the stored-order pass and the appended-active-zones
  // pass, first occurrence wins) and preserved afterwards by every other
  // mutator of this._activeOrder (_toggleTimezone's activate path and
  // _activateWithAlias both guard with indexOf before pushing;
  // _reorderActiveZone only ever removes-and-reinserts a single existing
  // occurrence). The stored 'timezones' GSettings value is a plain `as`
  // array with no uniqueness constraint, so a hand-edited/tampered dconf
  // entry could otherwise repeat a valid, known zone id arbitrarily many
  // times -- filtering to known zones alone does NOT bound the array's
  // length in that case, since a known id can still appear N times.
  // Without de-duplication, that would let _updateActiveMenu build one
  // full row (PopupBaseMenuItem + drag handle + edit button + entry) per
  // repetition on every menu open: unbounded actor construction driven
  // entirely by an untrusted settings value. With de-duplication,
  // this._activeOrder's length is bounded by the number of known zones
  // (~349) as an actual consequence of the invariant, so no separate
  // length cap is needed on top of it. See the scratch-node test for the
  // same logic parameterized on a plain knownZones Set, exercised without
  // gnome-shell imports.
  _reconcileActiveOrder(storedOrder, activeZones) {
    let order = [];
    let seen = new Set();

    storedOrder.forEach((zone) => {
      if (this._stateByZone.has(zone) && !seen.has(zone)) {
        order.push(zone);
        seen.add(zone);
      }
    });

    activeZones.forEach((zone) => {
      if (!seen.has(zone)) {
        order.push(zone);
        seen.add(zone);
      }
    });

    return order;
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
    if (!this._settings || !this._state || !this._config || !this._labels || !this._activeOrder) {
      return;
    }

    // Feature A: this._activeOrder is now the single source of truth for
    // both membership (which zones are active) and display order, so it's
    // written verbatim -- no re-deriving/re-sorting from this._state.
    this._settings.set_value('timezones', new GLib.Variant('as', this._activeOrder));

    this._settings.set_value('config', new GLib.Variant('a{sb}', this._config));
    this._settings.set_value('labels', new GLib.Variant('a{ss}', this._labels));
  }

  // Phase 3: persists this._separatorId (a curated SEPARATORS id, chosen
  // via the popup menu's "Separator" submenu) to the 'separator' gsetting.
  // Deliberately separate from _saveSettings() above (which only ever
  // touches 'timezones'/'config'/'labels' -- see its own comment) rather
  // than folded into it, so this new key's write path is independently
  // auditable and _saveSettings()'s existing guard/scope is untouched.
  _saveSeparatorSetting() {
    if (!this._settings) {
      return;
    }
    this._settings.set_value('separator', new GLib.Variant('s', this._separatorId || ''));
  }

  // Persists this._formattingDefaults (mutated by the popup menu's three
  // bold switches -- see _buildFormattingSubmenu() -- via
  // _setFormattingDefaultField() below) to the 'formatting-defaults'
  // gsetting via serializeFormatting(), which re-sanitizes defensively
  // regardless of whether the in-memory object is already sanitized --
  // values chosen in this menu UI always flow through the same sanitizers
  // as any other formatting source before reaching gsettings/markup.
  // KAREN-GATE FIX (round 4): restored -- round 3 removed this as dead
  // code after the bold switches were (temporarily, it turned out)
  // removed from the popup. See the this._separatorMenuItems field
  // comment in the constructor for the full round-1..4 history.
  _saveFormattingDefaults() {
    if (!this._settings) {
      return;
    }
    this._settings.set_value('formatting-defaults', new GLib.Variant('s', serializeFormatting(this._formattingDefaults)));
  }

  // Sanitizes and stores a single-field update to this._formattingDefaults
  // (e.g. { boldCity: true }), then persists it. Shared by the three bold
  // switches built in _buildFormattingSubmenu(), so every write to
  // this._formattingDefaults goes through sanitizeFormatting() exactly
  // once, in one place. KAREN-GATE FIX (round 4): restored, see
  // _saveFormattingDefaults()'s comment immediately above.
  _setFormattingDefaultField(field, value) {
    this._formattingDefaults = sanitizeFormatting({ ...this._formattingDefaults, [field]: value });
    this._saveFormattingDefaults();
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
    this._addConfigSwitch({ label: 'Hide system clock', name: 'hideSystemClock' });
    this._addConfigSwitch({ label: 'Show separator', name: 'showSeparator' });
    // Hover-popup feature: a single 'config' a{sb} boolean switch (the
    // ONLY control for this feature -- there is no separate "show date in
    // the menu" switch any more, see this._config.showHoverPopup's own
    // comment in the constructor), with a custom setValue (unlike every
    // switch above) so toggling it also drives the popup's own lazy
    // create/destroy -- see _syncHoverPopupLifecycle()'s own comment for
    // why this needs to be lazy at all (karen-gate finding: "off costs
    // nothing" is a hard requirement -- HEAD carries no hidden actor/
    // signal when this extension is used without the feature, and this
    // extension must not either). The popup itself is NOT part of
    // this._menu's own actor tree (see _initHoverPopup()): it is a
    // separate, standalone BoxPointer added directly to
    // Main.layoutManager.uiGroup, shown on panel-button hover rather than
    // click, and only ever created while the toggle is genuinely on.
    //
    // The key stays named `showHoverPopup` (not renamed) purely so an
    // already-saved user value in an existing dconf database is not
    // orphaned -- only the user-visible label changed, to describe the
    // simplified, dates-only popup this now drives (see hoverPopup.js).
    this._addConfigSwitch({
      label: 'Show dates on hover',
      name: 'showHoverPopup',
      setValue: (value) => {
        this._config.showHoverPopup = value;
        this._saveSettings();
        this._syncHoverPopupLifecycle();
      }
    });
    // Hover-popup sub-option: plain boolean, default _addConfigSwitch()
    // path (unlike showHoverPopup above, this needs no lifecycle side
    // effect -- the popup already rebuilds its rows from scratch on every
    // show via _rebuildHoverPopupRow(), which reads this._config.showWeekday
    // fresh each time, so a plain write + _saveSettings() is enough for
    // toggling this to be reflected live on the next hover).
    this._addConfigSwitch({ label: 'Show weekday', name: 'showWeekday' });

    this._activeMenu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Active clocks'));

    // Feature A (DnD, end-of-list drop): the active section's box actor is
    // created once by _createScrollableMenuSection() and persists across
    // _updateActiveMenu()'s removeAll() calls (only the menu ITEMS inside
    // it are destroyed/rebuilt), so it's a stable drop target for "drop
    // below the last row" -- always inserts at the end of this._activeOrder.
    //
    // BUG FIX (live-testing report): this USED to overwrite
    // `this._activeMenu.box._delegate` with a plain object. That was wrong:
    // PopupMenuBase's constructor sets `this.box._delegate = this` (the
    // PopupMenuSection instance itself), and that linkage matters for how
    // the shell resolves/manages this section as a menu item elsewhere.
    // Overwriting it is the same class of bug that caused the reported
    // "one drag -> triple rows" issue for the per-row delegates (see the
    // matching comment in _addActiveMenuRow): once `box._delegate` no
    // longer points back to `this._activeMenu`, anything that relies on
    // that link to identify/manage the section breaks silently.
    //
    // FIX: since `this._activeMenu.box._delegate === this._activeMenu`
    // already (shell-managed, untouched), attach handleDragOver/acceptDrop
    // as own properties DIRECTLY on `this._activeMenu` (the PopupMenuSection
    // instance) instead of replacing the delegate. dnd.js's
    // `target._delegate.handleDragOver` still resolves correctly.
    // DO NOT reassign `box._delegate` here or anywhere else in this file --
    // always add methods to the existing delegate instead.
    //
    // Shares _handleActiveDragOver()/_acceptActiveDrop() with every row's
    // own handleDragOver/acceptDrop (see _addActiveMenuRow): both compute
    // the candidate insertion index from LIVE row geometry rather than a
    // fixed "always append" assumption, so a drop anywhere in the box's
    // empty space below the last row still correctly resolves to
    // this._activeOrder.length via _computeInsertionIndex() (pointer below
    // every row's midpoint falls through to rows.length) -- no special
    // casing needed here beyond what the shared methods already do.
    this._activeMenu.handleDragOver = (source, actor, x, y) => this._handleActiveDragOver(source, actor, x, y);
    this._activeMenu.acceptDrop = (source, actor, x, y) => this._acceptActiveDrop(source, actor, x, y);

    let inputFilter = new St.Entry({ width: 300, can_focus: true });
    // shexli (EGO-L-003) fix: connectObject(..., inputFilter) instead of
    // plain connect() -- inputFilter is a GObject/Clutter actor, so this
    // auto-disconnects the moment inputFilter itself is destroyed (as part
    // of disable()'s this._button.destroy() cascade, which tears down the
    // whole menu tree including inputFilterItem/inputFilter below), rather
    // than needing an explicit disconnect call shexli can't statically
    // match. This is the idiomatic GNOME 45+ pattern and does not change
    // when/whether the connection fires during normal operation.
    inputFilter.clutter_text.connectObject(
      'text-changed',
      (o) => {
        this._hint = o.get_text().toLowerCase();
        this._updateInactiveMenu();
      },
      inputFilter
    );

    let inputFilterItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
    inputFilterItem.add_child(inputFilter);

    this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Active clocks'));
    this._menu.addMenuItem(this._activeMenu);
    this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Add more clocks'));
    this._menu.addMenuItem(inputFilterItem);
    this._menu.addMenuItem(this._inactiveMenu);
    this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Config'));
    this._menu.addMenuItem(this._configMenu);

    // Phase 3: separator picker + the three bold-flag switches.
    // Live-testing report, GNOME Shell 47/x11 -- 4 rounds of fixes, see
    // _buildSeparatorSubmenu()'s/_buildFormattingSubmenu()'s own comments
    // and the this._separatorMenuItems field comment above (in the
    // constructor) for the full history:
    //   Round 1: a PopupSubMenuMenuItem's own `.menu` is an St.ScrollView;
    //     nesting one inside `this._configMenu` (also an St.ScrollView,
    //     see `_createScrollableMenuSection()` below) collapsed it to a
    //     ~2px invisible viewport. Fixed by adding it to `this._menu`
    //     (never itself wrapped in a ScrollView) instead.
    //   Round 2: a second, near-identical submenu ("Formatting", wrapping
    //     "Font size"/"Color") was nested the same way one level deeper
    //     and had the same defect. Fixed by flattening -- no
    //     PopupSubMenuMenuItem nested inside another PopupSubMenu.
    //   Round 3: flattening made the popup's total content tall enough
    //     that on real small-but-common screens (1280x720, 1024x768)
    //     GNOME Shell's own top-level available-height budget squeezed
    //     EVERY scrollable section (including
    //     _activeMenu/_inactiveMenu/_configMenu, never part of this bug)
    //     down to single-digit pixels. Fixed by removing "Font
    //     size"/"Color"/the three bold switches from the popup entirely.
    //   Round 4 (this state, a product decision): the three bold
    //     switches are RESTORED -- plain `PopupSwitchMenuItem` rows with
    //     no `St.ScrollView` of their own, so they never had the
    //     round-1/2 nesting defect, and re-measurement confirmed the
    //     popup still renders at every resolution in the committed
    //     matrix with them present (see tests/README.md's "Minimum
    //     supported screen height" section for the re-measured floor).
    //     "Font size"/"Color" remain out of the popup permanently --
    //     prefs.js's "Defaults" group already provides full,
    //     independently-tested equivalents (plus per-zone overrides the
    //     popup never had).
    this._buildSeparatorSubmenu();
    this._buildFormattingSubmenu();

    this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(''));
    this._menu.addAction('Clear clocks', () => this._clearClocks());

    this._menuOpenStateId = this._menu.connect('open-state-changed', (menu, open) => {
      if (open) {
        inputFilter.set_text('');
        this._hint = '';
        this._updateMenu();
        // Hover-popup feature: the main click-to-open menu and the hover
        // popup must never be visible at the same time (design
        // requirement -- avoids two competing BoxPointer-shaped popups
        // fighting for the same screen space/attention). Cancel any
        // pending show-timer too, so a hover that started just before the
        // menu opened doesn't pop the hover popup up a moment later, on
        // top of the now-open menu.
        this._cancelHoverPopupShowTimeout();
        this._hideHoverPopup();
      }
    });

    // Lazy by design (karen-gate finding): the popup actor/signal are
    // only created here if the LOADED config already has the toggle on
    // (this._loadSettings() -- see the constructor -- has already run by
    // the time _initMenu() is called, so this._config.showHoverPopup is
    // authoritative at this point). If the toggle is off, as it is by
    // default, this call is a no-op -- see _syncHoverPopupLifecycle()'s
    // own comment for the full lazy create/destroy contract.
    this._syncHoverPopupLifecycle();
  }

  // --- Hover popup: "Show dates on hover" ---
  //
  // DESIGN: a single BoxPointer (imports.ui.boxpointer / this file's own
  // `BoxPointer` import), NOT a second PopupMenu.PopupMenu. this._button
  // already owns a click-to-open PopupMenu (this._menu); giving the SAME
  // actor a second menu-shaped popup with its own click/keyboard-grab
  // semantics would fight the first one over input. A bare BoxPointer has
  // none of that -- open()/close() just animate visibility and position,
  // with no modal grab, no keyboard nav, no 'activate' handling -- so it
  // coexists with this._menu cleanly. Built once in _initHoverPopup()
  // (called from _syncHoverPopupLifecycle(), itself called from
  // _initMenu() and from every toggle of the "Show dates on hover"
  // switch/gsetting) rather than freshly per-hover: unlike
  // this._dropIndicator (a genuinely transient, created-and-destroyed-
  // per-drag actor), this popup is shown/hidden repeatedly for as long as
  // the toggle stays on, so building it once per "toggle turned on" and
  // reusing it (rebuilding only its ROW CONTENT on each show, via
  // _rebuildHoverPopupRow()) is the simpler, lower-churn choice --
  // exactly how this._menu/this._activeMenu themselves are already
  // handled (built once in _initMenu(), rows rebuilt on each open via
  // _updateActiveMenu()).
  //
  // LAZY BY DESIGN (karen-gate finding): _initHoverPopup() -- and the
  // 'notify::hover' connection it makes -- must NEVER run just because
  // the extension was enabled. With the toggle off (the schema default),
  // this extension must be byte-identical to HEAD in what it adds to
  // Main.layoutManager.uiGroup and what it connects on this._button: no
  // hidden actor, no permanently-live signal connection firing (and
  // cheaply early-returning) on every panel hover. _syncHoverPopupLifecycle()
  // is the single place that decides whether the popup should currently
  // exist and creates/destroys it to match -- called from _initMenu()
  // (using the config _loadSettings() already loaded), from the
  // "Show dates on hover" switch's own setValue (menu-driven
  // toggle), and from the settings 'changed' handler in enable()
  // (external/dconf-driven toggle) -- so there is exactly one code path
  // that ever decides this, regardless of which of those three triggered
  // it.
  //
  // ACTOR ALLOCATION: added directly to Main.layoutManager.uiGroup (the
  // same parent PanelMenu.Button itself uses for this._menu.actor, see
  // panelMenu.js's setMenu()) rather than anywhere inside this._button's
  // own Clutter.FixedLayout tree -- a previous change in this codebase
  // added an unpositioned child directly to a FixedLayout parent and
  // produced a NaN allocation box plus continuous `Clutter-WARNING:
  // needs an allocation` journal spam (see the karen-gate round-2 comment
  // on this._labelStyleChangedId in enable()). BoxPointer sidesteps that
  // entirely: it overrides vfunc_allocate() itself and computes its own
  // real, finite allocation box from its source actor's live position
  // (see boxpointer.js's _reposition()) whenever that source actor is
  // mapped -- it does not depend on its PARENT's layout policy at all,
  // exactly like this._menu.actor already doesn't. setPosition() is
  // called once, right after construction below, before the popup is
  // ever shown -- BoxPointer recomputes the real screen position from
  // the live source-actor geometry on every subsequent open, so there is
  // no need to call it again per show.

  // Single source of truth for "should the hover-popup actor/signal
  // currently exist". Idempotent in both directions: creating when
  // already created, or tearing down when never created, are both
  // no-ops (checked via this._hoverPopup's own presence, exactly the
  // same "reference is the truth" discipline the rest of this file
  // already uses for this._hoverShowTimeoutId/this._hoverSignalId).
  // Called from three places, so the create/destroy decision is made in
  // exactly one place regardless of which one triggers it:
  //   1. _initMenu() (once per enable(), using whatever _loadSettings()
  //      already loaded into this._config.showHoverPopup).
  //   2. The "Show dates on hover" switch's own setValue (a genuine
  //      user click on the menu switch).
  //   3. The settings 'changed' handler in enable() (an EXTERNAL toggle,
  //      e.g. `gsettings set`/dconf-editor/another instance of this same
  //      extension code -- this._config.showHoverPopup has already been
  //      refreshed by that handler's own _loadSettings() call by the
  //      time this runs).
  // disable() does NOT call this -- it always tears down unconditionally
  // via _teardownHoverPopup() directly, regardless of the toggle's
  // current value, since by definition nothing should survive disable().
  _syncHoverPopupLifecycle() {
    if (this._config.showHoverPopup) {
      if (!this._hoverPopup) {
        this._initHoverPopup();
      }
    } else if (this._hoverPopup || this._hoverShowTimeoutId || this._hoverSignalId) {
      this._teardownHoverPopup();
    }
  }

  // The hover-popup teardown steps, extracted so there is exactly ONE
  // implementation shared by disable() (which always calls this
  // unconditionally, popup created or not -- see disable()'s own
  // comment) and _syncHoverPopupLifecycle() (which calls this only when
  // tearing down a live popup because the toggle was switched off).
  // Every step here is already proven safe regardless of WHICH moment in
  // the hover lifecycle it runs at (pending show-timer, popup genuinely
  // showing, just hidden) -- see the shell-driver's "hover teardown
  // interleaving A/B/C" tests -- and is safe to call when nothing was
  // ever created at all (every step below is independently null-checked,
  // so calling this on a never-initialized instance is a clean no-op):
  //   1. Cancel any pending show-delay timeout FIRST -- otherwise it
  //      could fire (calling _showHoverPopup(), which reads
  //      this._config/this._activeOrder/this._stateByZone) after the
  //      fields below are nulled, or after this._button/this._hoverPopup
  //      are destroyed.
  //   2. Disconnect the 'notify::hover' handler from this._button BEFORE
  //      this._button.destroy() (in disable()) -- same discipline as
  //      every other tracked signal in this file (this._signalId,
  //      this._settingsChangedId, this._labelStyleChangedId).
  //   3. Destroy this._hoverPopup itself (a real Clutter.Actor added to
  //      Main.layoutManager.uiGroup in _initHoverPopup()) -- this also
  //      destroys this._hoverPopupBox and every date/separator label
  //      inside it, since they are all its descendants; no separate
  //      destroy call is needed for those.
  _teardownHoverPopup() {
    this._cancelHoverPopupShowTimeout();

    if (this._button && this._hoverSignalId) {
      this._button.disconnect(this._hoverSignalId);
    }
    this._hoverSignalId = null;

    if (this._hoverPopup) {
      this._hoverPopup.destroy();
    }
    this._hoverPopup = null;
    this._hoverPopupBox = null;
  }

  _initHoverPopup() {
    this._hoverPopup = new BoxPointer.BoxPointer(St.Side.TOP);
    this._hoverPopup.style_class = 'popup-menu-boxpointer';
    this._hoverPopup.add_style_class_name('popup-menu');
    // Automation-friendly per project convention (see _addConfigSwitch()'s
    // own comment on accessible_name): there is no interactive control
    // inside this popup to name individually beyond the date/separator
    // labels themselves (each one's own accessible_name is set in
    // _rebuildHoverPopupRow()), but the container itself still gets a
    // stable name for tooling.
    this._hoverPopup.accessible_name = 'Timezones hover popup';

    // A single HORIZONTAL row of plain-text labels -- see
    // _rebuildHoverPopupRow()'s own comment for the full one-line,
    // dates-only layout (one date label per active zone, separator labels
    // interleaved between them, in this._activeOrder order -- no time,
    // no name/city text). `vertical: false` here is what makes this a
    // single row rather than the old two-line/per-column layout.
    this._hoverPopupBox = new St.BoxLayout({
      vertical: false,
      style_class: 'popup-menu-content'
    });
    this._hoverPopup.bin.set_child(this._hoverPopupBox);

    Main.layoutManager.uiGroup.add_child(this._hoverPopup);
    this._hoverPopup.hide();
    this._hoverPopup.setPosition(this._button, 0.5);

    // track_hover is already true on every PanelMenu.Button (see this
    // GNOME Shell's own panelMenu.js Button._init()), so this._button's
    // own `hover` property already tracks pointer enter/leave for us --
    // no separate enter-event/leave-event wiring needed. Explicitly
    // connect-id-tracked and disconnected in disable(), same discipline
    // as every other signal in this file (this._signalId,
    // this._settingsChangedId, this._labelStyleChangedId,
    // this._menuOpenStateId).
    this._hoverSignalId = this._button.connect('notify::hover', () => this._onButtonHoverChanged());
  }

  // Reacts to the real, GObject-level `hover` property change on
  // this._button (driven by track_hover -- see _initHoverPopup()'s
  // comment). On hover-IN: schedules the show-delay timer (unless the
  // feature is off, or the main click-to-open menu is currently open --
  // suppression requirement). On hover-OUT: cancels any pending timer and
  // hides the popup if it is currently showing. Any pending timer is
  // always cancelled first, on EITHER transition, so a rapid enter/leave/
  // enter sequence never accumulates more than one live timeout (timer
  // discipline requirement).
  _onButtonHoverChanged() {
    this._cancelHoverPopupShowTimeout();

    if (!this._button || !this._button.hover) {
      this._hideHoverPopup();
      return;
    }

    if (!this._config.showHoverPopup) {
      return;
    }

    if (this._menu && this._menu.isOpen) {
      return;
    }

    this._scheduleHoverPopupShow();
  }

  // Schedules _showHoverPopup() after HOVER_POPUP_SHOW_DELAY_MS. Any
  // previously-scheduled timer is cancelled first (see
  // _cancelHoverPopupShowTimeout()'s own comment) so this is always safe
  // to call even if a timer is already pending -- never leaves two live
  // timeouts. The id is nulled INSIDE the callback (before doing anything
  // else) as well as by the cancel path, so a fired-and-completed timer
  // is never mistaken for one still pending.
  _scheduleHoverPopupShow() {
    this._cancelHoverPopupShowTimeout();
    this._hoverShowTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HOVER_POPUP_SHOW_DELAY_MS, () => {
      this._hoverShowTimeoutId = null;
      this._showHoverPopup();
      return GLib.SOURCE_REMOVE;
    });
  }

  // Removes the pending show-delay timeout, if any, via
  // GLib.Source.remove() (never left to fire after a hide/disable/
  // reschedule -- shexli EGO-L-003, see HOVER_POPUP_SHOW_DELAY_MS's own
  // comment) and nulls the tracking field. Idempotent: safe to call when
  // no timer is pending.
  _cancelHoverPopupShowTimeout() {
    if (this._hoverShowTimeoutId) {
      GLib.Source.remove(this._hoverShowTimeoutId);
      this._hoverShowTimeoutId = null;
    }
  }

  // Rebuilds this._hoverPopupBox's row content from the CURRENT
  // this._activeOrder (so a reorder or an activate/deactivate that
  // happened while the pointer was merely resting, before the popup was
  // ever shown, is always reflected -- this is called fresh on every
  // show, exactly like _updateActiveMenu() rebuilds this._activeMenu on
  // every menu open) and opens the popup, UNLESS: the feature is off, the
  // main menu is open, the popup actor doesn't exist (disable() raced
  // ahead of a pending timer -- see disable()'s own comment), or there
  // are zero active zones to show (an empty floating popup would be
  // confusing, not informational). Every one of these guards is
  // deliberately re-checked here (not just at schedule time in
  // _onButtonHoverChanged()) so this method is itself safe to call
  // directly -- exactly what the test suite's "show path" assertions do.
  _showHoverPopup() {
    if (!this._config || !this._config.showHoverPopup) {
      return;
    }
    if (this._menu && this._menu.isOpen) {
      return;
    }
    if (!this._hoverPopup || !this._hoverPopupBox) {
      return;
    }

    this._rebuildHoverPopupRow();

    if (this._hoverPopupBox.get_n_children() === 0) {
      return;
    }

    // Matches PopupMenu.open()'s own z-ordering (see this GNOME Shell's
    // popupMenu.js `PopupMenu.open()`): raise the popup above every other
    // sibling in Main.layoutManager.uiGroup so it isn't hidden behind
    // some other already-open shell chrome.
    this._hoverPopup.get_parent().set_child_above_sibling(this._hoverPopup, null);
    this._hoverPopup.open(BoxPointer.PopupAnimation.NONE);
  }

  // Closes the popup if it is currently visible. Idempotent (BoxPointer's
  // own close() already no-ops when `!this.visible`, see boxpointer.js) --
  // safe to call unconditionally from every suppression/teardown path
  // (hover-out, main-menu-open, disable()).
  _hideHoverPopup() {
    if (this._hoverPopup && this._hoverPopup.visible) {
      this._hoverPopup.close(BoxPointer.PopupAnimation.NONE);
    }
  }

  // Computes the hover popup's per-zone CITY/ZONE segments -- exactly
  // what the panel itself would show for `zone` (respecting the "Show
  // city name"/"Show timezone" toggles and any custom per-zone
  // label/alias), with the TIME segment dropped entirely. Returned as
  // SEPARATE `{city, zone}` segments (not a pre-joined string) so
  // _rebuildHoverPopupRow() below can render each as its own St.Label and
  // apply bold independently per segment (see buildHoverPopupCells()'s
  // own comment on why the pure model needs them separate). `zone` is
  // `null` when the zone-abbreviation segment is hidden (the "Show
  // timezone" toggle's off state) -- the SAME convention
  // _computeEntrySegments() itself already uses. Returns `null` when
  // `zone` is not a currently-known active zone (defensive; mirrors the
  // prior '' fallback for an unresolvable zone).
  _getHoverPopupEntrySegments(zone) {
    let item = this._stateByZone.get(zone);
    if (!item) {
      return null;
    }
    let segments = this._computeEntrySegments({ item, full: false });
    return { city: segments.city, zone: segments.zone };
  }

  // Destroys and rebuilds every child in this._hoverPopupBox from
  // this._activeOrder, via the PURE buildHoverPopupCells() helper
  // (hoverPopup.js) -- kept pure/shell-independent so the zone-
  // selection-and-ordering logic is unit-testable without a running
  // gnome-shell (see tests/run-tests.js).
  //
  // ONE LINE, PER-ZONE FORMATTED SEGMENTS + DATE: each cell returned by
  // buildHoverPopupCells() is either a 'zone' cell (rendered via
  // _buildHoverZoneCell() below -- a small horizontal box of that zone's
  // CITY/ZONE/DATE segment labels, each carrying that zone's EFFECTIVE
  // size/colour/bold, see that method's own comment) or a 'separator'
  // cell (the panel's own separator literal, rendered exactly as before:
  // a single plain, UNFORMATTED St.Label -- separators are never
  // per-zone, so they are deliberately never touched by any zone's
  // formatting). There is deliberately still no per-zone TIME text here,
  // and therefore no column-alignment machinery is needed -- an ordinary
  // horizontal box of cells, in the same order and with the same
  // separator literal the panel itself uses, already reads as "the dates
  // for the zones you see above, in the same order, each one labeled and
  // styled the same way the panel labels/styles it" without needing to
  // line each date up pixel-for-pixel under its own zone's panel entry
  // (the panel is a single combined label, not one label per zone, so
  // per-zone alignment against it would have no stable target to align
  // to in the first place).
  //
  // LIVE TRACKING: _getHoverPopupEntrySegments()/_getEffectiveFormatting()
  // are both called fresh, right here, on every call to this method --
  // which itself runs fresh on every popup show (see _showHoverPopup())
  // -- so this always reads the CURRENT this._config.showCity/
  // showTimezone/this._labels AND the CURRENT this._formatting/
  // this._formattingDefaults at show time. Nothing about a cell's
  // segments or formatting is cached across shows (each show destroys
  // every previous child via the .destroy() loop below and rebuilds from
  // scratch), so toggling "Show city name"/"Show timezone" or editing a
  // zone's size/colour/bold in prefs and then hovering again always
  // reflects the change with no separate refresh wiring needed.
  //
  // PLAIN TEXT + CSS ONLY, NEVER MARKUP: every label uses `.text`
  // (`new St.Label({ text })`) and, when non-neutral, a CSS `style`
  // string (`set_style()`/the constructor `style` property) for
  // size/colour/bold -- never `.clutter_text.set_markup()`. See
  // hoverPopup.js's own module-header comment for why this popup
  // deliberately never touches the markup/escapeMarkup() surface at all:
  // since nothing here is ever parsed as Pango markup, there is no
  // injection path to defend against in the first place -- a hostile
  // custom label's markup metacharacters reach `label.text` completely
  // verbatim, in whichever segment label they belong to.
  _rebuildHoverPopupRow() {
    this._hoverPopupBox.get_children().forEach((child) => child.destroy());

    let cells = buildHoverPopupCells({
      activeOrder: this._activeOrder,
      knownZones: this._stateByZone,
      dateFormat: this._dateFormat,
      showWeekday: this._config.showWeekday,
      getEntrySegments: (zone) => this._getHoverPopupEntrySegments(zone),
      getFormatting: (zone) => this._getEffectiveFormatting(zone),
      separatorValue: this._resolveSeparatorValue()
    });

    cells.forEach((cell) => {
      if (cell.type === 'separator') {
        let label = new St.Label({
          text: cell.text,
          x_align: Clutter.ActorAlign.FILL,
          style: 'text-align: center;'
        });
        label.accessible_name = `Separator: ${cell.text}`;
        this._hoverPopupBox.add_child(label);
        return;
      }

      this._hoverPopupBox.add_child(this._buildHoverZoneCell(cell));
    });
  }

  // Builds the CSS `style` string for one hover-popup segment label, from
  // a cell's sanitized `fmt` (see buildHoverPopupCells()'s own comment)
  // and whether THIS specific segment should render bold. size/colour are
  // re-sanitized here via sanitizeFontSize()/sanitizeColor() -- defense in
  // depth, matching every other formatting.js consumer in this file, even
  // though hoverPopup.js already sanitized `fmt` once. A neutral value
  // (size 0 / colour '') omits its own CSS property entirely, so the
  // label simply inherits the popup's theme default -- exactly like an
  // unconfigured panel entry's markup omits its <span> attributes
  // entirely (see buildEntryMarkup()'s own comment in formatting.js).
  // Returns '' (never null) when nothing needs overriding, so callers can
  // always pass the result straight into an St.Label's `style` property.
  _hoverSegmentStyle(fmt, bold) {
    let parts = [];

    let size = sanitizeFontSize(fmt.size);
    if (size !== 0) {
      // St CSS 'font-size' takes a plain point size, unlike Pango
      // markup's 1024ths-of-a-point 'size' attribute (see
      // buildEntryMarkup()'s comment in formatting.js) -- no unit
      // conversion needed here.
      parts.push(`font-size: ${size}pt;`);
    }

    let color = sanitizeColor(fmt.color);
    if (color !== '') {
      parts.push(`color: ${color};`);
    }

    if (bold) {
      parts.push('font-weight: bold;');
    }

    return parts.join(' ');
  }

  // Builds one 'zone' cell's actor: a horizontal St.BoxLayout containing
  // up to three plain-text St.Labels -- CITY, ZONE-abbreviation, and DATE
  // -- with a plain spacer St.Label holding a single space between any
  // two ADJACENT segments that are actually present. WHICH segments exist
  // and in WHAT ORDER comes from formatting.js's own
  // orderedEntrySegments() -- the SAME shared decision
  // joinEntrySegments()/buildEntryText() (the panel/menu's plain-text
  // join) is built on -- rather than this method re-deriving that
  // presence/order rule a second time. This method itself only adds the
  // ONE thing orderedEntrySegments() cannot decide for it: whether to
  // actually render a given slot as a visible label. It drops an empty
  // CITY slot entirely (no label, no surrounding spacer) -- unlike the
  // panel/menu join, which keeps an empty city as a literal '' segment
  // (still contributing its leading space to the joined STRING, since a
  // plain-text entry has no visual "just don't render this part" option a
  // string join can express) -- unable to just call joinEntrySegments()
  // directly for that same reason: this popup needs SEPARATE actors per
  // segment for independent per-segment bold (boldCity/boldZone), which a
  // joined string cannot provide.
  //
  // CITY gets CSS `font-weight: bold` when `cell.fmt.boldCity`; ZONE gets
  // it when `cell.fmt.boldZone`; DATE (orderedEntrySegments()'s `last`
  // slot here) never does (this popup has no time segment for `boldTime`
  // to ever apply to, and the design brief is explicit that the date
  // itself is never bold) -- the `kind` tag orderedEntrySegments() puts on
  // each slot is what lets this method map straight to the right bold
  // flag without re-deriving "which slot is which" itself. Every segment
  // label AND the spacer labels between them share the SAME `font-size`/
  // `color` CSS from `cell.fmt` -- the whole CELL's effective per-zone
  // size/colour, exactly like the panel's own per-entry size/colour wraps
  // a whole markup entry in a single outer <span> (buildEntryMarkup()).
  // See hoverPopup.js's own module-header comment for why CSS
  // (`set_style()`/the `style` property) is used here, never Pango markup.
  _buildHoverZoneCell(cell) {
    let box = new St.BoxLayout({ vertical: false });

    let boldForKind = { city: cell.fmt.boldCity, zone: cell.fmt.boldZone, last: false };
    let parts = orderedEntrySegments({ city: cell.citySeg, zone: cell.zoneSeg, last: cell.dateText })
      // Drop an empty CITY slot entirely -- see this method's own comment
      // above for why that is a rendering-only decision layered on top of
      // the shared presence/order rule, not a re-divergence of it. The
      // ZONE slot is only ever present at all when orderedEntrySegments()
      // itself included it (zoneSeg non-null), and the DATE/`last` slot is
      // never dropped, matching the pre-existing "always show a date"
      // behavior.
      .filter((segment) => segment.kind !== 'city' || segment.text !== '')
      .map((segment) => ({ text: segment.text, bold: boldForKind[segment.kind] }));

    let spacerStyle = this._hoverSegmentStyle(cell.fmt, false);
    let fullTextParts = [];

    parts.forEach((part, index) => {
      if (index > 0) {
        let spacer = new St.Label({ text: ' ', style: spacerStyle });
        box.add_child(spacer);
      }

      let segmentStyle = this._hoverSegmentStyle(cell.fmt, part.bold);
      let label = new St.Label({
        text: part.text,
        x_align: Clutter.ActorAlign.FILL,
        style: segmentStyle ? `text-align: center; ${segmentStyle}` : 'text-align: center;'
      });
      label.accessible_name = part.text;
      box.add_child(label);
      fullTextParts.push(part.text);
    });

    box.accessible_name = fullTextParts.join(' ');
    return box;
  }

  // BUG FIX (live-testing report): toggling a switch OFF flipped the
  // visual but never persisted/applied -- ANCHOR FACT was that
  // `gsettings get ... config` kept reading every key as true after
  // turning switches off, i.e. the OFF write never reached settings.
  // Re-reading _saveSettings()/this._config[name] assignment top to bottom
  // found no `||`/truthy-default reconstruction and no obvious bug in the
  // write path itself -- this._config is written to the 'a{sb}' variant
  // verbatim. That points at the *input* to `this._config[name] = state`:
  // `state`, the SIGNAL's emitted parameter, going through GObject signal
  // marshaling. `item.state` (a plain property getter read directly off
  // the PopupSwitchMenuItem instance after the toggle) is the more
  // authoritative, lower-risk source of truth for "what is the switch
  // actually set to right now" and is used instead, eliminating any
  // possible mismatch between the two. Boolean(...) is applied explicitly
  // so only a real primitive boolean is ever stored/persisted.
  // Phase 3 EXTENSION: generalized with optional `parentMenu` (defaults
  // to this._configMenu, so every pre-Phase-3 call site above is
  // unchanged) and optional `getValue`/`setValue` (defaulting to reading/
  // writing this._config[name] + _saveSettings(), i.e. exactly the
  // original behavior). Used by the three bold-flag switches built in
  // _buildFormattingSubmenu() below (formattingBoldCity/Time/Zone), which
  // persist into this._formattingDefaults / the 'formatting-defaults'
  // gsetting instead of the 'config' a{sb} key -- their name is
  // deliberately NOT a member of CONFIG_KEYS and is never written into
  // this._config, so the 'config' key's shape/contents are completely
  // unaffected by them. (These three switches were briefly removed from
  // the popup in round 3 of the empty-submenu bug fix, then restored in
  // round 4 -- see the this._separatorMenuItems field comment in the
  // constructor for the full history. This generalization was kept
  // through round 3 specifically so restoring them in round 4 needed no
  // changes here at all.)
  _addConfigSwitch({ label, name, parentMenu, getValue, setValue }) {
    let menu = parentMenu || this._configMenu;
    let readValue = getValue || (() => this._config[name]);
    let writeValue =
      setValue ||
      ((value) => {
        this._config[name] = value;
        this._saveSettings();
      });

    let configSwitch = new PopupMenu.PopupSwitchMenuItem(label, Boolean(readValue()));
    // Automation-friendly per project convention: PopupMenuItem/
    // PopupSwitchMenuItem/PopupSubMenuMenuItem are all plain St.BoxLayout
    // subclasses (they ARE the actor, no separate `.actor` property), and
    // St/Clutter actors expose a settable `accessible_name` (backed by
    // Atk) -- this is the only stable, explicit "name" the shell popup
    // menu API offers per-row, so it's set everywhere a new row is built
    // in this phase (here, and in the submenu builders below).
    configSwitch.accessible_name = label;
    configSwitch.connect('toggled', (item) => {
      // Reentrancy guard (see the settings 'changed' handler in enable()
      // for the full explanation): setToggleState() -- called by
      // _syncConfigSwitches() -- synchronously emits 'toggled' when it
      // actually changes the switch's visual state, which is exactly
      // what happens when this sync is resolving a stale switch during
      // an external-change resync. Without this guard that would write
      // the (already-current) value straight back to gsettings from
      // inside the resync that just read it. This never blocks a real
      // user click: this._applyingExternalSettings is only ever true
      // while the 'changed' handler's own synchronous call stack is
      // still running.
      if (this._applyingExternalSettings) {
        return;
      }
      writeValue(Boolean(item.state));
      this._updateLabel();
      // Cheap/simple to call unconditionally for every config switch
      // (not just 'hideSystemClock'): it no-ops instantly when the
      // visibility already matches this._config.hideSystemClock. Also
      // harmless (still a no-op) for the Phase 3 bold-flag switches added
      // via this same method, since they never touch hideSystemClock.
      this._applySystemClockVisibility();
      // Bug fix (live-testing report, see _refreshVisibleTimeLabels()'s
      // own comment for the full root-cause analysis): every switch built
      // through this method shares the same class of staleness -- only
      // this._label (the panel) was refreshed above, never the ALREADY-
      // OPEN menu's own rows, which is the only place this switch is
      // reachable from at all. Called unconditionally here, exactly like
      // _applySystemClockVisibility() just above, for the same reason:
      // cheap, and correct/no-visible-effect for switches whose value
      // does not currently affect row content (showCity/showTimezone/
      // hideSystemClock/the three bold flags -- see
      // _computeEntrySegments()'s `full` branch, which does not consult
      // any of them) rather than requiring this handler to track which
      // switches matter today and silently going stale again the next
      // time one starts mattering.
      this._refreshVisibleTimeLabels();
    });
    this._configSwitches[name] = { item: configSwitch, getValue: readValue };
    menu.addMenuItem(configSwitch);
  }

  // Belt-and-suspenders companion to the fix above: forces every config
  // switch's VISUAL state back to match its authoritative source value
  // every time the menu opens (see _updateMenu()) or an external
  // gsettings change is observed (see the 'changed' handler in enable()).
  // This means even if a switch's displayed toggle position and its
  // stored value ever did desync for any reason, the visual self-heals --
  // the stored value always wins. Phase 3 EXTENSION: reads each entry's
  // own `getValue` (this._config[name] for the original boolean switches,
  // this._formattingDefaults.boldCity/boldTime/boldZone for the Phase 3
  // bold-flag switches) instead of unconditionally reading
  // this._config[name], so the bold switches are covered by the exact
  // same self-healing guarantee without reading a key that doesn't exist
  // in this._config for them.
  _syncConfigSwitches() {
    Object.keys(this._configSwitches).forEach((name) => {
      let entry = this._configSwitches[name];
      entry.item.setToggleState(Boolean(entry.getValue()));
    });
  }

  // Phase 3: builds the "Separator" submenu listing exactly the curated
  // SEPARATORS entries (separators.js), each shown with its label and a
  // literal preview of its value. Selecting a row persists that entry's
  // `id` to the 'separator' gsetting (see _selectSeparator()) -- the
  // stored key is always an id, never a raw literal, when chosen through
  // this UI (a hand-edited/tampered literal value is still supported for
  // rendering via resolveSeparatorValue()'s fallback, it just never shows
  // as "selected" here -- see _syncSeparatorSubmenu()).
  _buildSeparatorSubmenu() {
    let separatorItem = new PopupMenu.PopupSubMenuMenuItem('Separator');
    separatorItem.accessible_name = 'Separator picker';

    SEPARATORS.forEach((entry) => {
      let row = new PopupMenu.PopupMenuItem(`${entry.label}  "${entry.value}"`);
      row.accessible_name = `Separator: ${entry.label}`;
      row.connect('activate', () => this._selectSeparator(entry.id));
      separatorItem.menu.addMenuItem(row);
      this._separatorMenuItems[entry.id] = row;
    });

    // Added to `this._menu` (the top-level, non-scrollable menu), NOT
    // `this._configMenu` -- see the BUG FIX comment on the call site in
    // _initMenu() for why a scrollable-section-nested St.ScrollView
    // submenu collapses to an invisible ~2px viewport in real GNOME
    // Shell.
    this._menu.addMenuItem(separatorItem);
    this._syncSeparatorSubmenu();
  }

  // Persists the chosen curated separator id, refreshes which submenu row
  // shows the selection ornament, and re-renders the panel immediately
  // (acceptance criterion: no reload required).
  _selectSeparator(id) {
    this._separatorId = id;
    this._saveSeparatorSetting();
    this._syncSeparatorSubmenu();
    this._updateLabel();
  }

  // Marks exactly the row matching this._separatorId with Ornament.DOT
  // (GNOME 45+'s PopupMenu.Ornament -- verified present in this GNOME
  // Shell's popupMenu.js as NONE/DOT/CHECK/HIDDEN/NO_DOT) and clears
  // every other row's ornament. If this._separatorId is '' (never
  // touched this control -- legacy fallback, see _resolveSeparatorValue())
  // or a hand-edited literal that doesn't match any curated id, no row is
  // marked -- degrades gracefully rather than mis-highlighting anything.
  _syncSeparatorSubmenu() {
    Object.keys(this._separatorMenuItems).forEach((id) => {
      this._separatorMenuItems[id].setOrnament(
        id === this._separatorId ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE
      );
    });
  }

  // Builds the three "Bold city"/"Bold time"/"Bold zone" switches, added
  // as flat, direct children of `this._menu` (siblings of "Separator",
  // never nested inside any PopupSubMenu or `_createScrollableMenuSection()`
  // section). See the this._separatorMenuItems field comment in the
  // constructor for the full round-1..4 history of why "Font size" and
  // "Color" (both formerly `PopupSubMenuMenuItem`s, unlike these three
  // plain `PopupSwitchMenuItem` rows) are NOT here and never will be
  // again -- in short: these three never had the ScrollView-nesting
  // defect that broke "Font size"/"Color" in rounds 1-2 (a
  // PopupSwitchMenuItem has no `.menu`/no St.ScrollView of its own at
  // all), and re-measurement after restoring them (round 4, see
  // tests/README.md's "Minimum supported screen height" section)
  // confirmed the popup still renders correctly at every resolution in
  // the committed matrix with them present.
  _buildFormattingSubmenu() {
    this._addConfigSwitch({
      label: 'Bold city',
      name: 'formattingBoldCity',
      parentMenu: this._menu,
      getValue: () => this._formattingDefaults.boldCity,
      setValue: (value) => this._setFormattingDefaultField('boldCity', value),
    });
    this._addConfigSwitch({
      label: 'Bold time',
      name: 'formattingBoldTime',
      parentMenu: this._menu,
      getValue: () => this._formattingDefaults.boldTime,
      setValue: (value) => this._setFormattingDefaultField('boldTime', value),
    });
    this._addConfigSwitch({
      label: 'Bold zone',
      name: 'formattingBoldZone',
      parentMenu: this._menu,
      getValue: () => this._formattingDefaults.boldZone,
      setValue: (value) => this._setFormattingDefaultField('boldZone', value),
    });
  }

  // Refreshes the separator submenu's ornament. Shared by _updateMenu()
  // (menu-open resync) and the settings 'changed' handler in enable()
  // (external-change resync, e.g. when prefs.js writes a new separator
  // choice). The three bold switches built by _buildFormattingSubmenu()
  // above do NOT need their own entry here -- they ride the existing,
  // generic _syncConfigSwitches() mechanism (via this._configSwitches,
  // populated by _addConfigSwitch()) exactly like every other config
  // switch, already called alongside this method by both _updateMenu()
  // and the 'changed' handler; see _syncConfigSwitches()'s own comment.
  _syncMenuControls() {
    this._syncSeparatorSubmenu();
  }

  // Hides/shows GNOME Shell's own top-bar clock label to match
  // this._config.hideSystemClock. `_clockDisplay` is a private Shell
  // implementation member (not public API), so this is guarded to
  // silently no-op -- never throw -- if it's missing on some future
  // GNOME Shell version. this._hidSystemClock records whether WE were the
  // one to hide it, so disable() only restores visibility it actually
  // changed (never fighting another extension managing the same label).
  _applySystemClockVisibility() {
    let clockDisplay = Main.panel.statusArea.dateMenu?._clockDisplay;
    if (!clockDisplay) {
      return;
    }

    let shouldHide = Boolean(this._config.hideSystemClock);
    clockDisplay.visible = !shouldHide;
    this._hidSystemClock = shouldHide;
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

  // Feature A: iterates this._activeOrder (not this._state) so the panel
  // text reflects the user's chosen order rather than alphabetical.
  //
  // Phase 2: the panel is now rendered as Pango markup (per-segment bold,
  // per-entry font size/color) via clutter_text.set_markup(), joined with
  // the user-selected separator (falling back to the legacy ' | '/four-
  // space behavior when 'separator' is unset -- see
  // _resolveSeparatorValue()). The separator itself is escaped before
  // insertion since it is untrusted free-form text (see
  // resolveSeparatorValue()'s doc comment in separators.js). If the
  // assembled markup is ever invalid, this falls back to the equivalent
  // plain text via `.text` rather than breaking the panel.
  //
  // Phase 5 FIX (karen gate finding 1b): ClutterText.set_markup() does NOT
  // raise a JS-catchable exception on a Pango parse failure -- it fails
  // silently (a `Clutter-WARNING **: Failed to set the markup` on stderr
  // only) and leaves the label showing whatever it showed before, or
  // nothing. The `try { set_markup() } catch` below this comment used to
  // be the ONLY guard against a broken/blank panel, which made it
  // effectively dead code: nothing it could ever catch would actually be
  // thrown. The real validation now happens BEFORE set_markup() is ever
  // called, via _isMarkupValid() (an independent Pango.parse_markup()
  // oracle -- the same check tests/run-tests.js's pure suite and
  // tests/shell-driver/extension.js both use), so an invalid markup
  // string takes the plain-text fallback path unconditionally instead of
  // silently rendering as empty/stale. The try/catch around set_markup()
  // itself is kept as a second, defense-in-depth layer for any other
  // (non-parse) exception set_markup() might someday raise -- it is not
  // relied upon as the primary safety net any more.
  //
  // NOTE: this only affects the panel label. The 'full' form used by menu
  // rows (_updateTimeLabels()/item.label) and the drag-actor preview
  // continue to go through _getLabelForTimezone(), which always returns
  // plain text (see its own comment) -- they render via St.Label.text,
  // which would show raw markup syntax literally if given markup.
  //
  // Phase 6 FIX (live-testing report: the FIRST panel entry's colour --
  // both a global default and a per-zone override -- never actually
  // rendered, every other entry was fine): this is a real GNOME Shell /
  // Clutter / St platform quirk, not a bug in this file's markup
  // assembly, confirmed via a real ClutterText/Pango.AttrIterator
  // resolution against the real render (see the "panel: a GLOBAL
  // DEFAULT colour genuinely renders on the FIRST entry" and "panel: a
  // PER-ZONE colour override..." records in
  // tests/shell-driver/extension.js) and traced to gnome-shell's own
  // src/st/st-private.c::_st_set_text_from_style():
  // every St widget style pass installs its OWN whole-text (start=0,
  // end=G_MAXUINT) FOREGROUND Pango attribute via
  // clutter_text_set_attributes() to match the resolved CSS 'color'.
  // ClutterText's clutter_text_ensure_effective_attributes() (in
  // mutter's clutter/clutter/clutter-text.c) then merges that on TOP of
  // the markup-parsed attribute list via repeated pango_attr_list_insert()
  // calls (once per PangoAttrIterator run the whole-text attribute
  // spans), which -- given Pango resolves same-type/overlapping
  // attributes by "last in the list wins" -- means St's own whole-text
  // FOREGROUND ends up sorting AFTER any markup <span foreground> that
  // ALSO starts at byte offset 0, i.e. specifically the FIRST rendered
  // character(s). No restructuring of the markup STRING can fix this
  // (proven empirically: the parsed markup list is copied into the
  // merge ONCE, before St's attribute list is layered on top of it, so
  // a start=0 markup span always loses regardless of how it's built);
  // entries after the first are naturally immune since their span's
  // start_index is never 0. The only attribute St's own style pass
  // actually reads is the WIDGET's resolved CSS 'color' -- confirmed by
  // directly overriding it via St.Widget.set_style() and observing the
  // winning colour change -- so this works around it by giving the
  // FIRST entry's colour to the widget itself (so St's own base
  // attribute already matches it, no collision left to lose) and, so
  // that doesn't leak into any OTHER entry that has no colour of its
  // own (which would otherwise silently inherit the first entry's
  // colour instead of the theme default), giving every such "inherit"
  // entry an explicit span of its own using the theme's resolved
  // default colour. Only engages when the first entry actually has an
  // explicit colour; the common unconfigured case is untouched.
  _updateLabel() {
    let zones = this._activeOrder
      .map((zone) => this._stateByZone.get(zone))
      .filter((item) => item !== undefined);

    if (zones.length === 0) {
      this._setLabelStyle(null);
      this._setPanelText('...');
      return;
    }

    let separatorValue = this._resolveSeparatorValue();
    let escapedSeparator = escapeMarkup(separatorValue);

    let firstColor = this._getEffectiveFormatting(zones[0].timezone).color;
    let getMarkupForEntry;
    if (firstColor) {
      // this._ambientForegroundColorHex is a CACHED value, refreshed by
      // _refreshAmbientForegroundColorHex() (see enable() and
      // this._label's own 'style-changed' handler there) -- never
      // re-read off this._label directly here, since this._label is the
      // very widget the set_style() call below mutates (see the
      // karen-gate comment on that field's declaration for why reading
      // it while contaminated self-poisons the very next tick).
      let themeColor = this._ambientForegroundColorHex;
      this._setLabelStyle(`color: ${firstColor};`);
      getMarkupForEntry = (item, index) =>
        index === 0 ? this._getMarkupForTimezone(item) : this._getMarkupForTimezone(item, themeColor);
    } else {
      this._setLabelStyle(null);
      getMarkupForEntry = (item) => this._getMarkupForTimezone(item);
    }

    let markup = zones.map(getMarkupForEntry).join(escapedSeparator);
    let plainText = () => zones.map((item) => this._getLabelForTimezone({ item })).join(separatorValue);

    let validation = this._checkMarkupValid(markup);
    if (!validation.ok) {
      this._logMarkupFailureThrottled(validation.error);
      this._setPanelText(plainText());
      return;
    }

    try {
      this._label.clutter_text.set_markup(markup);
    } catch (e) {
      // Defense-in-depth only -- see the Phase 5 comment above. Every
      // dynamic piece of this markup is built through
      // escapeMarkup()/sanitizeColor()/sanitizeFontSize() AND has already
      // passed the _checkMarkupValid() pre-check above, so reaching this
      // catch block at all should be unreachable in practice; if it is
      // ever reached, the plain-text fallback below still applies so the
      // panel is never left broken/blank.
      this._logMarkupFailureThrottled(e);
      this._setPanelText(plainText());
    }
  }

  // Independent validation oracle for an assembled Pango markup string,
  // used BEFORE set_markup() is ever called (see the Phase 5 comment on
  // _updateLabel() for why set_markup()'s own failure mode cannot be
  // trusted as a safety net). Runs the exact same real Pango parser
  // set_markup() itself would use, but in a form that DOES raise a
  // JS-catchable exception (Pango.parse_markup() throws a GLib.MarkupError
  // GError on invalid markup, unlike ClutterText.set_markup()). Returns
  // `{ ok: true }` on success or `{ ok: false, error }` on failure --
  // never throws itself.
  _checkMarkupValid(markup) {
    try {
      // The third argument is the accelerator marker character (as a
      // single-character string, or '' for "no accelerator parsing" --
      // this extension's markup never uses one).
      Pango.parse_markup(markup, -1, '');
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e };
    }
  }

  // Logs the first panel-markup-parse failure immediately, then at most
  // once per MARKUP_FAILURE_LOG_INTERVAL_SECONDS thereafter, regardless of
  // how many ticks hit the catch block in between. _updateLabel() runs on
  // every clock tick (see the WallClock 'notify::clock' handler in
  // enable()), so an unthrottled console.error() here would spam the
  // journal once per tick indefinitely if this branch were ever reached
  // continuously (e.g. by a future GLib/Pango behavior change) -- this
  // bounds that to a manageable rate without silencing the condition
  // entirely (each occurrence still degrades to the plain-text fallback
  // above, unthrottled; only the logging is rate-limited).
  _logMarkupFailureThrottled(e) {
    let now = GLib.DateTime.new_now_local().to_unix();
    if (
      this._lastMarkupFailureLogTime !== undefined &&
      now - this._lastMarkupFailureLogTime < MARKUP_FAILURE_LOG_INTERVAL_SECONDS
    ) {
      return;
    }
    this._lastMarkupFailureLogTime = now;
    console.error(
      `${this.metadata?.name ?? 'Timezones extension'}: failed to render panel markup, falling back to plain text`,
      e
    );
  }

  // Sets the panel label to plain, non-markup text. Used both for the
  // empty-state '...' text and as the fallback if markup rendering fails.
  // Setting `.text` (rather than leaving stale markup in place) also
  // resets ClutterText's use-markup state back to plain text.
  _setPanelText(text) {
    this._label.text = text;
  }

  // Resolves the effective separator STRING to join panel entries with:
  // the curated/literal value from the 'separator' GSettings key when
  // set, otherwise the legacy behavior (this._config.showSeparator ? ' | '
  // : '    ') for exact backward compatibility with existing users who
  // have never touched the new key (its default is '').
  _resolveSeparatorValue() {
    let resolved = resolveSeparatorValue(this._separatorId);
    if (resolved !== null) {
      return resolved;
    }
    return this._config.showSeparator ? ' | ' : '    ';
  }

  // Effective formatting for `zone`: a per-entry override (this._formatting)
  // takes priority over the global default (this._formattingDefaults),
  // which itself defaults to DEFAULT_FORMATTING (see _loadSettings()).
  // Both this._formatting[zone] and this._formattingDefaults are always
  // already-normalized (parseFormatting()) full formatting objects, so no
  // per-field merge happens here -- an entry with a partial override
  // still gets DEFAULT_FORMATTING's neutral values for its other fields,
  // matching the 'formatting' schema key's documented shape.
  _getEffectiveFormatting(zone) {
    return getEffectiveFormatting(zone, this._formatting, this._formattingDefaults);
  }

  // Computes the three raw (unescaped, unformatted) segments -- city/
  // alias label, zone abbreviation (or null when hidden), and time --
  // shared by all three entry renderers: the plain-text join
  // (buildEntryText) and Pango markup (buildEntryMarkup) in formatting.js,
  // and the hover popup's per-segment cell builder (_buildHoverZoneCell),
  // which reuses the city/zone segments (dropping the time in favour of a
  // date). This is the exact same decision logic the pre-Phase-2 single
  // function used; it has just been split from the "how to render the
  // segments" step so that step can be swapped independently.
  //
  // `nameOverride`, when given, is a matched search-result alias display
  // name (Feature A) and takes priority over any stored per-zone label
  // (Feature B) for the city segment -- this is the single place that
  // decides "Name (zone/id)" vs plain city name, reused by both features
  // instead of duplicating the format logic at each call site.
  _computeEntrySegments({ item, full, nameOverride }) {
    let glibTimezone = GLib.TimeZone.new(item.timezone);
    let now = GLib.DateTime.new_now(glibTimezone);
    let alias = nameOverride || (this._labels ? this._labels[item.timezone] : undefined);
    let timezoneLabel;

    if (full) {
      // Full form (active-clock and search-result menu rows): always show
      // the zone id so it stays identifiable; when a name is given
      // (override or stored label), prefix it and keep the zone id visible
      // in parens, e.g. "Home (America/Los_Angeles)".
      timezoneLabel = alias ? `${alias} (${item.timezone})` : item.timezone;
    } else {
      // Panel form: the alias substitutes for the city-name segment, so
      // it still respects the "Show city name" toggle like the text it
      // replaces.
      timezoneLabel = this._config.showCity ? alias || item.timezone.split('/').pop().replace('_', ' ') : '';
    }

    let showZone = full || this._config.showTimezone;
    return {
      city: timezoneLabel,
      zone: showZone ? now.format('%Z') : null,
      time: now.format(this._config.format24 ? '%R' : '%l:%M %p')
    };
  }

  // Plain-text (never markup) form of an entry -- used for the 'full' form
  // consumed by menu rows (_updateTimeLabels()'s item.label, rendered via
  // plain St.Label.text) and the drag-actor preview, AND as the panel's
  // fallback text if markup rendering ever fails (_updateLabel()). Byte-
  // identical to the pre-Phase-2 output for the same inputs.
  _getLabelForTimezone({ item, full, nameOverride }) {
    let segments = this._computeEntrySegments({ item, full, nameOverride });
    return buildEntryText(segments);
  }

  // Pango-markup form of a single panel entry: per-segment bold and
  // per-entry font size/color from the effective formatting for `item`'s
  // zone. Only ever used for the panel (_updateLabel()); menu rows always
  // use the plain-text form above.
  //
  // `inheritColorOverride`, when given (a sanitized '#rrggbb' string),
  // replaces an EMPTY (inherit) effective color with that value; it is
  // never used to override a zone's OWN explicit color. This exists
  // solely for _updateLabel()'s first-entry base-attribute workaround
  // below -- see that method's comment for why it is needed.
  _getMarkupForTimezone(item, inheritColorOverride) {
    let segments = this._computeEntrySegments({ item, full: false });
    let fmt = this._getEffectiveFormatting(item.timezone);
    if (inheritColorOverride && !fmt.color) {
      fmt = { ...fmt, color: inheritColorOverride };
    }
    return buildEntryMarkup(segments, fmt);
  }

  // Reads `actor`'s currently-resolved theme foreground color (the color
  // _st_set_text_from_style() -- gnome-shell's src/st/st-private.c --
  // would otherwise turn into the base Pango FOREGROUND attribute
  // described in _updateLabel()'s comment) and returns it as a sanitized
  // '#rrggbb' string, or '' if unavailable (e.g. the actor has not been
  // through a style pass yet). Best-effort: this only ever feeds a
  // cosmetic fallback, so any failure here just means that fallback is
  // skipped for this one render, not a broken panel.
  //
  // karen-gate FIX (round 3): `actor` MUST have no inline style applied
  // at the moment this is called -- see _refreshAmbientForegroundColorHex()
  // below, the ONLY caller, which guarantees that by clearing
  // this._label's inline style immediately before calling this and
  // reapplying it immediately after.
  _resolveThemeForegroundColorHex(actor) {
    try {
      // St.Widget.get_theme_node() logs a St-CRITICAL (not a catchable
      // JS exception) if the actor is not currently in the stage --
      // guard against that explicitly rather than relying on the
      // try/catch below, which cannot suppress it.
      if (!actor || actor.get_stage() === null) {
        return '';
      }
      let themeNode = actor.get_theme_node();
      let color = themeNode.get_foreground_color();
      let toHex = (component) => Math.max(0, Math.min(255, Math.round(component))).toString(16).padStart(2, '0');
      return sanitizeColor(`#${toHex(color.red)}${toHex(color.green)}${toHex(color.blue)}`);
    } catch (e) {
      return '';
    }
  }

  // The ONLY method in this file allowed to call this._label.set_style()
  // -- every call site (_updateLabel(), _refreshAmbientForegroundColorHex()
  // below) MUST go through this, so this._applyingOwnLabelStyle can
  // reliably distinguish "this extension changed this._label's own
  // inline style" from "the real ambient theme changed" in this._label's
  // 'style-changed' handler (see enable()). Without this single choke
  // point, any direct this._label.set_style() call anywhere else would
  // silently bypass the guard and reproduce round 1's self-poisoning bug
  // one layer up (a set_style()-triggered 'style-changed' being
  // misread as a genuine ambient change).
  _setLabelStyle(style) {
    this._applyingOwnLabelStyle = true;
    try {
      this._label.set_style(style);
    } finally {
      this._applyingOwnLabelStyle = false;
    }
  }

  // Re-resolves this._ambientForegroundColorHex from this._label's OWN
  // theme node -- see the karen-gate round-3 comment on
  // this._labelStyleChangedId's declaration in enable() for why this._label
  // itself (not this._button, not a dedicated probe actor) is the only
  // correct source, and why it must never be read while an inline style
  // override is applied.
  //
  // Sequencing (measured directly against a real, type-targeted theme
  // stylesheet -- see tests/shell-driver/extension.js's own "does
  // set_style(null) immediately followed by get_theme_node()..." record):
  // save whatever inline style is currently applied, clear it via
  // _setLabelStyle() (guarded, so this does NOT recursively re-enter
  // this method through this._label's own 'style-changed' handler), read
  // the now-uncontaminated theme node, then reapply the saved style so
  // the visible panel is completely unaffected by this call. Measured
  // that this needs no extra delay: set_style(null) immediately followed
  // by get_theme_node().get_foreground_color() already returns the
  // fresh, uncontaminated colour synchronously -- St's theme-node
  // recomputation happens as part of set_style()'s own 'style-changed'
  // emission, not deferred to a later idle/paint step.
  _refreshAmbientForegroundColorHex() {
    if (!this._label) {
      return;
    }
    let savedStyle = this._label.get_style();
    this._setLabelStyle(null);
    this._ambientForegroundColorHex = this._resolveThemeForegroundColorHex(this._label);
    this._setLabelStyle(savedStyle);
  }

  _updateMenu() {
    this._updateTimeLabels();
    this._updateActiveMenu();
    this._updateInactiveMenu();
    this._syncConfigSwitches();
    this._syncMenuControls();
  }

  _updateTimeLabels() {
    this._state.forEach((item) => (item.label = this._getLabelForTimezone({ item: item, full: true })));
  }

  // Live-testing report (originally surfaced via a now-removed
  // menu-row date switch, but the root cause was never specific to that
  // switch): every config switch's 'toggled' handler (_addConfigSwitch(),
  // below) wrote the new value and refreshed only this._label (the
  // PANEL), never this._state's cached item.label or the already-open
  // menu's row actors. Those are only ever refreshed by _updateMenu(),
  // which historically only ran on menu OPEN (open-state-changed) or
  // _clearClocks() -- so toggling e.g. "24 hours format" while the menu
  // was already open left every visible row showing its stale pre-toggle
  // text until the menu was closed and reopened. This still matters with
  // the date feature removed: format24/showCity/showTimezone all still
  // change a row's rendered TEXT (see _computeEntrySegments()'s `full`
  // branch), so a live-open menu still needs this refresh on every
  // toggle, not just format24.
  //
  // FIX, scoped to the actual class of bug (every config switch, not just
  // whichever one first surfaced it -- see _addConfigSwitch()'s 'toggled'
  // handler, the single call site for this method): refresh this._state's
  // cached item.label (this._updateTimeLabels(), cheap: one
  // _getLabelForTimezone() call per
  // zone, same work _updateMenu() already did) and then update each
  // CURRENTLY-BUILT active row's own St.Label text IN PLACE, rather than
  // calling the heavier _updateActiveMenu() (which removeAll()s and
  // rebuilds every row from scratch on every keystroke-adjacent toggle).
  // That heavier rebuild is deliberately NOT used here: it would tear
  // down and recreate the drag handle + draggable of every active row
  // (see _clearRowDraggables()/_addActiveMenuRow()) and, worse, would
  // silently discard an in-progress inline rename (the row's `entry`
  // actor together with its typed-but-uncommitted text) the instant a
  // config switch happened to be toggled mid-edit -- neither of which a
  // config-switch toggle has any business doing. Updating each row's
  // label actor's `.text` property directly touches only what a switch
  // toggle should ever affect (the rendered TEXT), leaving every row
  // actor, its drag handle/draggable, and any open inline-rename `entry`
  // completely untouched -- the label itself even stays correct (freshly
  // set here) once a cancelled edit reveals it again.
  //
  // this._updateInactiveMenu() (the "Add more clocks" search-result rows,
  // which also render item.label in its `full: true` form -- see
  // _updateInactiveMenu()'s own addAction(item.label, ...) call) is safe
  // to call outright here: it already does a full removeAll()/rebuild on
  // every single keystroke of the search filter (see the 'text-changed'
  // handler in _initMenu()) and carries no per-row DnD/edit state of its
  // own to lose.
  _refreshVisibleTimeLabels() {
    this._updateTimeLabels();
    if (this._activeMenu) {
      this._activeMenu.box.get_children().forEach((row) => {
        // Real active-clock rows are the only children of this box that
        // are drop targets of their own (see _addActiveMenuRow(), which
        // attaches `acceptDrop` directly to `menuItem` -- exactly the
        // same discriminator tests/shell-driver/extension.js's own
        // findActiveRowLabelText() helper uses to find real rows).
        if (typeof row.acceptDrop !== 'function') {
          return;
        }
        let dragHandle = row.get_children().find((child) => child.dragZoneId !== undefined);
        let item = dragHandle && this._stateByZone.get(dragHandle.dragZoneId);
        if (!item) {
          return;
        }
        let label = row.get_children().find((child) => child instanceof St.Label);
        if (label) {
          label.text = `${ACTIVE_MARK} ${item.label}`;
        }
      });
    }
    if (this._inactiveMenu) {
      this._updateInactiveMenu();
    }
  }

  // Feature A: iterates this._activeOrder (the authoritative display
  // order) instead of filtering this._state, resolving each zone id via
  // this._stateByZone. Row build order no longer needs to carry an
  // explicit index for drop-target math: _handleActiveDragOver()/
  // _acceptActiveDrop() (shared by every row and by this._activeMenu's
  // own end-of-list target) compute the candidate insertion index from
  // LIVE row geometry read off the box's actual children at drag time
  // (see _getActiveRowGeometry()), not from a value captured at build time.
  _updateActiveMenu() {
    // shexli (EGO-L-003): disconnect the outgoing rows' draggables'
    // 'drag-end' signals before removeAll() destroys them -- see
    // _clearRowDraggables() for why this ordering is safe even when called
    // from inside a just-completed drop's own call stack.
    this._clearRowDraggables();
    this._activeMenu.removeAll();

    this._activeOrder.forEach((zone) => {
      let item = this._stateByZone.get(zone);
      if (item) {
        this._addActiveMenuRow(item, ACTIVE_MARK);
      }
    });
  }

  // Builds one active-clock row as a custom PopupBaseMenuItem: a drag
  // handle, a label (checkmark + time, or an inline St.Entry while
  // editing), and a small edit button. Replaces the previous addAction()
  // rows so the label can be swapped for an editable St.Entry per row.
  _addActiveMenuRow(item, activeMark) {
    let menuItem = new PopupMenu.PopupBaseMenuItem();

    // --- Feature A: drag-and-drop reorder ---
    //
    // DESIGN DECISION: makeDraggable() is attached to the drag-HANDLE icon
    // only, not to the whole row. The task explicitly allows this as the
    // safer fallback ("restrict makeDraggable to the drag-handle actor
    // instead of the whole row") and it's the choice made here: the row
    // (`menuItem`) already owns its own button-press/release handling for
    // 'activate' (toggle-off) via PopupBaseMenuItem, and a second listener
    // from _Draggable on the SAME actor for the SAME events is a real risk
    // of breaking click-to-toggle or the edit button in ways that can't be
    // statically verified from source alone (Clutter/GObject boolean-return
    // signal accumulators can stop later handlers on the same actor from
    // running at all, depending on connection order and return values).
    // Scoping the draggable to a small dedicated handle actor sidesteps
    // that risk entirely: clicks on the label/edit button are completely
    // unaffected, and dragging only starts from a press-and-drag on the
    // handle. Only the drag SOURCE (what starts the drag) is the small
    // handle actor -- the floating drag actor the user actually sees is a
    // separate, custom whole-row preview built by getDragActor() below, so
    // this scoping decision does not limit what's shown while dragging.
    //
    // ICON RISK (flag for runtime verification): 'list-drag-handle-symbolic'
    // is used below (and in the drag-actor preview further down) on the
    // assumption it exists in the running icon theme.
    // This cannot be confirmed from a static read of this repo. If it
    // renders as a missing-icon glyph, swap the icon_name (e.g. to
    // 'open-menu-symbolic' or another always-present symbolic icon) --
    // the DnD wiring itself does not depend on which icon is shown.
    let dragIcon = new St.Icon({
      icon_name: 'list-drag-handle-symbolic',
      style_class: 'popup-menu-icon'
    });
    let dragHandle = new St.Button({
      style_class: 'button',
      child: dragIcon,
      reactive: true,
      can_focus: true,
      track_hover: true
    });
    menuItem.add_child(dragHandle);

    // Tag the handle actor directly with the zone id it represents, and
    // pre-set its own _delegate to itself so it can serve as the drag
    // SOURCE's identity (read back via _getDragSourceZone()). This is safe
    // to overwrite because dragHandle is a plain St.Button we just created
    // -- it has no prior shell-managed _delegate, unlike menuItem/box
    // below. ASSUMPTION (flag for runtime verification): dnd.js's
    // _Draggable only sets `actor._delegate = this` if `actor._delegate`
    // is not already set, so pre-setting it here means acceptDrop's
    // `source` argument (whatever exact object dnd.js passes -- the
    // convention is not 100% certain from static reading alone) should
    // resolve to `dragHandle` either directly or via a `_delegate` hop;
    // _getDragSourceZone() below checks both shapes defensively.
    //
    // BUG FIX (live-testing report): dragHandle's self-delegate does NOT
    // implement handleDragOver/acceptDrop (it's a plain St.Button, not a
    // drop target). REASONING (documented per fix request, not verified
    // against a live shell): dnd.js's target search walks UP from the
    // actor under the pointer through ancestors, testing
    // `actor._delegate && actor._delegate.handleDragOver` at each level
    // and continuing to `actor.get_parent()` when that fails -- it does
    // not stop/dead-zone just because the immediate hit's delegate lacks
    // the method. So a drop landing directly on another row's dragHandle
    // should still resolve up to that row's `menuItem` (see below), whose
    // own delegate now has handleDragOver/acceptDrop. Flagged for runtime
    // verification: if dropping precisely on a handle turns out to be a
    // dead zone in practice, the walk-continues-upward assumption above is
    // what needs revisiting.
    dragHandle.dragZoneId = item.timezone;
    dragHandle._delegate = dragHandle;

    // BUG FIX (live-testing report): the handle rendered at the RIGHT end
    // of the row after a drag instead of staying at the left. ROOT CAUSE:
    // with no getDragActor() override, dnd.js's default behavior is to
    // drag the REAL `dragHandle` actor itself -- it reparents it to the
    // stage for the duration of the drag. `restoreOnSuccess: false` then
    // means it is never reparented back to its original spot in `menuItem`
    // on a successful drop; instead it's left wherever dnd.js's drop
    // handling puts it (effectively orphaned from its row), while
    // `_reorderActiveZone()`'s `_updateActiveMenu()` rebuild subsequently
    // adds a brand-new row (with its own brand-new handle) -- the stray
    // ex-handle actor ending up appended after everything else is what
    // rendered as "handle at the right end."
    //
    // UX POLISH (live-testing feedback): the clone-icon drag actor "looked
    // like small white dots" following the cursor -- unclear what was being
    // moved. FIX: getDragActor() now builds a freestanding, throwaway
    // St.BoxLayout styled like a real row (style_class 'popup-menu-item',
    // the same drag-handle icon, and a label showing this clock's current
    // full display text via _getLabelForTimezone({item, full:true}),
    // recomputed fresh here rather than trusting a possibly-stale
    // item.label). This is still a brand-new actor, never the real row or
    // any of its children -- no reparenting, so the handle-jump bug fixed
    // previously cannot be reintroduced. getDragActorSource() still
    // returns the real handle (dnd.js uses it to size/position the clone's
    // starting point); `restoreOnSuccess: false` remains moot since the
    // real actor is still never moved.
    dragHandle.getDragActor = () => {
      let preview = new St.BoxLayout({
        style_class: 'popup-menu-item',
        vertical: false
      });
      preview.add_child(
        new St.Icon({
          icon_name: 'list-drag-handle-symbolic',
          style_class: 'popup-menu-icon'
        })
      );
      preview.add_child(
        new St.Label({
          text: `${activeMark} ${this._getLabelForTimezone({ item, full: true })}`,
          y_align: Clutter.ActorAlign.CENTER
        })
      );
      return preview;
    };
    dragHandle.getDragActorSource = () => dragHandle;

    let draggable = DND.makeDraggable(dragHandle, { restoreOnSuccess: false, manualMode: false });
    // No 'drag-begin' handler: the drop indicator is created lazily on
    // first handleDragOver, not needed before a drag actually starts
    // moving, so there was nothing for a drag-begin handler to do -- a
    // shexli pass (EGO-L-003) flagged the previous no-op `.connect(
    // 'drag-begin', () => {})` as an unmatched signal connection, and since
    // it genuinely did nothing, it was removed rather than given a
    // matching disconnect.
    //
    // 'drag-end' IS kept and is load-bearing: it's the unconditional
    // teardown net for the live landing-zone indicator, firing on EVERY
    // drag end regardless of outcome (successful drop, cancelled via
    // Escape, or dropped outside any valid target), so clearing the
    // indicator here guarantees a cancelled/failed drag never leaves it
    // behind even though acceptDrop() (the success path) also clears it --
    // _clearDropIndicator() is idempotent, so both call sites are safe.
    //
    // shexli (EGO-L-003) fix for THIS connection: the handler id is stored
    // in this._rowDraggables and explicitly disconnected by
    // _clearRowDraggables() (called from disable() and from the start of
    // every _updateActiveMenu() rebuild) rather than left unmatched.
    // `draggable` (DND.makeDraggable()'s return value, dnd.js's internal
    // _Draggable) is NOT necessarily a GObject -- see the TYPE NOTE on
    // _clearRowDraggables() -- so explicit connect-id/disconnect is used
    // instead of connectObject(), which is only guaranteed to exist on
    // GObject instances.
    let dragEndId = draggable.connect('drag-end', () => this._clearDropIndicator());
    this._rowDraggables.push({ draggable, dragEndId });

    // Each row is itself a drop target (for reordering onto/around it);
    // the active section's box (see _initMenu) is the separate end-of-list
    // target. Both share _handleActiveDragOver()/_acceptActiveDrop(),
    // which compute the candidate insertion index from LIVE row geometry
    // (this row's own position is no longer captured/relied on at build
    // time -- see _getActiveRowGeometry()).
    //
    // BUG FIX (live-testing report, still applies): this USED to replace
    // `menuItem._delegate` wholesale with a plain { handleDragOver,
    // acceptDrop } object. That was wrong and caused the reported "drag one
    // row -> every active row triples" bug: PopupBaseMenuItem's own
    // constructor sets `this._delegate = this` (self-delegate), and
    // PopupMenuBase.removeAll() discovers which of its box's children are
    // menu items to destroy by reading each child's `_delegate` and
    // checking `instanceof PopupBaseMenuItem`. Overwriting `_delegate` with
    // a plain object made every row invisible to that check, so
    // `_updateActiveMenu()`'s `removeAll()` silently destroyed nothing --
    // old rows were orphaned (still in the box, still rendering) while a
    // fresh batch was appended on top every time the menu opened or a drop
    // occurred, producing duplicated/tripled rows.
    //
    // FIX (still in effect): attach handleDragOver/acceptDrop as own
    // properties DIRECTLY on `menuItem` instead, leaving `menuItem._delegate`
    // (== menuItem itself) completely untouched. dnd.js's
    // `target._delegate.handleDragOver` still resolves correctly
    // (`target._delegate` is `menuItem`, which now has the method
    // directly), and `removeAll()`'s `instanceof PopupBaseMenuItem` check
    // keeps working since the delegate is still the real menu item.
    // DO NOT reassign `menuItem._delegate` here or anywhere else in this
    // file -- always add methods to the existing delegate instead.
    menuItem.handleDragOver = (source, actor, x, y) => this._handleActiveDragOver(source, actor, x, y);
    menuItem.acceptDrop = (source, actor, x, y) => this._acceptActiveDrop(source, actor, x, y);

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

    // No interaction with the DnD wiring above: the edit button is a
    // distinct St.Button actor from dragHandle, with its own independent
    // button-press/release handling (same reasoning as the existing
    // St.Button-consumes-its-own-events comment on editButton.connect(...)
    // below applies equally to dragHandle). Dragging never starts a rename,
    // and committing/cancelling a rename never triggers a drag.
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

    // shexli (EGO-L-003) fix: connectObject(..., entry) for both of this
    // row's inline-rename key handlers, instead of plain connect() --
    // `entry` is the natural owner for signals on its own clutter_text:
    // when the row is rebuilt (_updateActiveMenu()'s removeAll(), e.g.
    // after a commit/rename or a reorder) or the extension is disabled,
    // `entry` is destroyed along with the rest of `menuItem`, and
    // connectObject auto-disconnects at exactly that point -- no explicit
    // disconnect call needed, and no change to when these handlers fire
    // during normal editing.
    entry.clutter_text.connectObject(
      'key-press-event',
      (actor, event) => {
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
      },
      entry
    );

    // Losing keyboard focus (click elsewhere, menu closing, Tab away)
    // cancels the edit rather than committing it, so an accidental
    // focus-out can never silently save a half-typed value. Only Enter
    // (via the handler above) commits.
    entry.clutter_text.connectObject('key-focus-out', () => cancelEdit(), entry);

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

  // With an empty hint, keep the original behavior: only inactive zones are
  // listed (so the section doesn't duplicate Active clocks when the user
  // isn't searching). Once the user types a hint, every matching zone is
  // shown -- including already-active ones, marked with ACTIVE_MARK -- so
  // search never hides a result just because it happens to be active.
  _updateInactiveMenu() {
    this._inactiveMenu.removeAll();
    let hint = this._hint;

    if (hint === '') {
      this._state
        .filter((item) => !item.active)
        .forEach((item) => this._inactiveMenu.addAction(item.label, () => this._toggleTimezone(item)));
      return;
    }

    // Per keystroke: one pass over this._aliases (~1.3k entries) to find
    // each zone's single best-matching alias, then one pass over
    // this._state (349 zones) to build at most one row per zone. No
    // per-zone re-scan of the alias list (that would be the O(n*m) cost
    // this precomputed/flattened structure is meant to avoid).
    let bestAliasByZone = new Map();
    this._aliases.forEach((alias) => {
      if (alias.key.indexOf(hint) === -1) {
        return;
      }
      let current = bestAliasByZone.get(alias.zone);
      if (!current || this._isBetterAliasMatch(alias, current, hint)) {
        bestAliasByZone.set(alias.zone, alias);
      }
    });

    this._state.forEach((item) => {
      let alias = bestAliasByZone.get(item.timezone);
      if (!alias && item.lower.indexOf(hint) === -1) {
        return;
      }

      // An alias match always wins over the zone's own row, even if the
      // zone id also happens to contain the hint -- at most one row per zone.
      let label = alias ? this._getLabelForTimezone({ item, full: true, nameOverride: alias.display }) : item.label;
      let text = item.active ? `${ACTIVE_MARK} ${label}` : label;

      this._inactiveMenu.addAction(text, () => {
        if (item.active) {
          // Checkmarked result: toggling off leaves any stored label alone.
          this._toggleTimezone(item);
        } else if (alias) {
          // Selecting an alias match both activates the zone and sets its
          // display label to the alias's display name (overwriting any
          // previously stored label for that zone).
          this._activateWithAlias(item, alias.display);
        } else {
          this._toggleTimezone(item);
        }
      });
    });
  }

  // Picks the better of two same-zone alias matches for a given hint:
  // prefer a key that startsWith(hint), then the shortest key, then
  // alphabetical order -- matching the phase spec's tie-break rules.
  _isBetterAliasMatch(candidate, current, hint) {
    let candidateStarts = candidate.key.startsWith(hint);
    let currentStarts = current.key.startsWith(hint);
    if (candidateStarts !== currentStarts) {
      return candidateStarts;
    }

    if (candidate.key.length !== current.key.length) {
      return candidate.key.length < current.key.length;
    }

    return candidate.key < current.key;
  }

  // Feature A: toggling on appends to the end of this._activeOrder (new
  // clocks join at the end, not alphabetically); toggling off removes the
  // zone from it. Renaming a zone never goes through this method, so
  // position is naturally preserved across renames. The indexOf guard on
  // the activate path is defense-in-depth for the this._activeOrder
  // no-duplicates invariant (see _reconcileActiveOrder): in normal UI
  // flow this is only ever called to activate a currently-inactive item,
  // so the guard should be a no-op, but it keeps this method idempotent
  // regardless, matching _activateWithAlias's existing guard.
  _toggleTimezone(item) {
    item.active = !item.active;

    if (item.active) {
      if (this._activeOrder.indexOf(item.timezone) === -1) {
        this._activeOrder.push(item.timezone);
      }
    } else {
      let index = this._activeOrder.indexOf(item.timezone);
      if (index !== -1) {
        this._activeOrder.splice(index, 1);
      }
    }

    this._updateLabel();
    this._saveSettings();
  }

  // Activates `item` and sets its stored display label to displayName in
  // one step (sanitize -> set -> activate -> single save -> refresh panel),
  // so the panel immediately shows the alias (e.g. "Seattle") instead of
  // requiring two separate settings writes. This intentionally overwrites
  // any label previously stored for the zone. Feature A: also appends to
  // this._activeOrder like _toggleTimezone's activate path (this method is
  // only ever called on a currently-inactive item, but the indexOf guard
  // keeps it idempotent/safe regardless).
  _activateWithAlias(item, displayName) {
    item.active = true;
    if (this._activeOrder.indexOf(item.timezone) === -1) {
      this._activeOrder.push(item.timezone);
    }

    let sanitized = this._sanitizeLabel(displayName);
    if (sanitized.length > 0) {
      this._labels[item.timezone] = sanitized;
    } else {
      delete this._labels[item.timezone];
    }

    this._updateLabel();
    this._saveSettings();
  }

  // Moves zoneId to targetIndex within this._activeOrder. Splicing out the
  // old entry shifts every later index down by one, so when the old
  // position is BEFORE targetIndex, the effective insertion index must be
  // decremented by one to land in the intended visual slot -- e.g. order
  // [A, B, C], moving A to "after C" (targetIndex 3) must insert at index 2
  // (post-removal length), not 3, or it would be clamped past the end and
  // silently behave like appending past a now-shorter array. Used by both
  // the per-row and end-of-list drop targets; produces exactly one
  // _saveSettings() + one _updateLabel() + one _updateActiveMenu() call
  // per completed drop, not per intermediate drag-over event (those only
  // return a DragMotionResult and never touch this._activeOrder).
  _reorderActiveZone(zoneId, targetIndex) {
    let oldIndex = this._activeOrder.indexOf(zoneId);
    if (oldIndex === -1) {
      return;
    }

    this._activeOrder.splice(oldIndex, 1);

    let insertAt = oldIndex < targetIndex ? targetIndex - 1 : targetIndex;
    insertAt = Math.max(0, Math.min(insertAt, this._activeOrder.length));

    this._activeOrder.splice(insertAt, 0, zoneId);

    this._saveSettings();
    this._updateLabel();
    this._updateActiveMenu();
  }

  // Resolves the zone id being dragged from dnd.js's `source` argument.
  // ASSUMPTION (flag for runtime verification): the exact shape of `source`
  // passed to acceptDrop/handleDragOver by this GNOME Shell version's
  // dnd.js is not confirmed from static reading alone -- it may be the
  // dragged actor itself, or its `_delegate`. Both shapes resolve here
  // because dragHandle.dragZoneId is set directly on the handle actor AND
  // dragHandle._delegate === dragHandle (see _addActiveMenuRow).
  _getDragSourceZone(source) {
    if (!source) {
      return null;
    }
    return source.dragZoneId ?? source._delegate?.dragZoneId ?? null;
  }

  // --- Live landing-zone feedback ---
  //
  // APPROACH CHOSEN: a single drop-indicator line, NOT live reflow of the
  // active rows. The task explicitly offered reflow as the user's stated
  // preference but named a drop-indicator line as an acceptable
  // lower-risk fallback, to be chosen if reflow "proves unstable under
  // the popup menu's modal grab" -- and explicitly said to build only ONE
  // approach. Reflow means mutating multiple rows' layout (margins/
  // translations) on every handleDragOver call (i.e. on every pointer-
  // motion event during the drag) while the popup holds its modal grab,
  // and then guaranteeing that mutation is perfectly undone on every exit
  // path (success, Escape, drop-outside, source-destroyed). This file has
  // already hit two separate DnD bugs from touching shell-managed state in
  // ways that looked correct locally but broke under the shell's actual
  // menu-item bookkeeping (the _delegate-overwrite duplication bug, and
  // the drag-actor-reparenting handle-jump bug) -- both were plausible-
  // looking code that could not be verified without a live shell. A single
  // extra, clearly-scoped, non-shell-managed actor (this._dropIndicator)
  // that is only ever inserted into and removed from one box, with no
  // per-row mutation and no dependency on shell-internal row bookkeeping,
  // is the smaller, more auditable surface area. Reflow is deferred rather
  // than attempted.
  //
  // Candidate insertion index is computed by the pure _computeInsertionIndex()
  // below from live row geometry (_getActiveRowGeometry()), and reused
  // identically by _handleActiveDragOver() (for positioning the indicator)
  // and _acceptActiveDrop() (for the real reorder), so the visual candidate
  // and the actual drop index can never diverge.

  // Pure: given the drag pointer's Y (dnd.js's handleDragOver/acceptDrop
  // `y` argument) and an array of currently-visible active rows'
  // { y, height } in top-to-bottom order (same coordinate space as each
  // row's own get_transformed_position()), returns the candidate insertion
  // index: 0 if pointerY is above the first row's midpoint, i+1 if it's
  // between row i and row i+1 (below row i's midpoint, at/above row i+1's),
  // rows.length if it's below the last row's midpoint (or rows is empty).
  // No gnome-shell dependency -- see the scratch-node test for
  // representative pointer-Y sequences including boundary rows.
  _computeInsertionIndex(pointerY, rows) {
    for (let i = 0; i < rows.length; i++) {
      if (pointerY < rows[i].y + rows[i].height / 2) {
        return i;
      }
    }
    return rows.length;
  }

  // Reads the live on-screen geometry of every active-clock row, in
  // top-to-bottom order, directly from this._activeMenu.box's actual
  // children at the moment of the call (not from anything captured at row-
  // build time). Filters out the drop-indicator actor itself via its
  // `isDropIndicator` tag so it is never mistaken for a row -- this matters
  // because the indicator is a real child of the same box while a drag is
  // in progress, and would otherwise shift the computed indices.
  //
  // KNOWN MINOR RISK (noted, not fixed -- out of scope per this fix):
  // filtering the indicator OUT of this array prevents it from being
  // counted as a row, but does not undo the fact that inserting it into
  // the box physically shifts every REAL row below the insertion point
  // down by the indicator's own height (a few px, since St.BoxLayout lays
  // out children in a vertical stack). That could cause the candidate
  // index to jitter by one right at a boundary as the indicator itself
  // moves. Left as-is: fixing it cleanly would mean either reading
  // geometry before the indicator affects layout or compensating for its
  // height, and neither is obviously safe to do without live-shell
  // verification, so it's flagged here rather than attempted.
  _getActiveRowGeometry() {
    return this._activeMenu.box.get_children()
      .filter((child) => !child.isDropIndicator)
      .map((child) => {
        let [, y] = child.get_transformed_position();
        return { y, height: child.get_height() };
      });
  }

  // BUG FIX (live-testing report): the drop-indicator line always showed at
  // the TOP of the list and never moved, even though the actual drop still
  // landed correctly. ROOT CAUSE: the `y` dnd.js passes to
  // handleDragOver/acceptDrop is in the TARGET ACTOR'S LOCAL coordinate
  // space (it transforms the stage pointer into whichever actor's
  // `_delegate` it's currently invoking -- roughly 0..rowHeight when over a
  // row, or box-local when over the box), but _getActiveRowGeometry()
  // builds row {y} from get_transformed_position(), which is STAGE
  // (absolute) coordinates -- typically hundreds of px. Comparing a small
  // local `y` against large stage `y` values in _computeInsertionIndex()
  // meant `pointerY < rows[0].y + height/2` was true for basically any
  // local y, so the computed index was always 0. The drop still landed in
  // the right place only incidentally (whatever the final resolved index
  // happened to be from other internal dnd.js state at release time) --
  // not something to rely on.
  //
  // FIX: use global.get_pointer() (returns [stageX, stageY, mods] in
  // absolute stage coordinates -- the standard GNOME Shell way to read the
  // current pointer position) instead of the passed `y`, so the pointer Y
  // and the row geometry are in the SAME coordinate space. The passed
  // (x, y) params are kept in the method signatures (dnd.js still calls
  // with them) but are no longer used for the index math.
  // _computeInsertionIndex() itself is unchanged/still pure.
  //
  // RUNTIME NOTE: global.get_pointer() cannot be exercised outside a
  // running GNOME Shell process, so this fix could not be scratch-tested
  // the way _computeInsertionIndex() was -- flagged for user runtime
  // re-verification (indicator should now track the pointer and land
  // exactly where shown).

  // Shared handleDragOver for both the per-row drop targets and the active
  // section's own end-of-list target (see _initMenu and _addActiveMenuRow):
  // computes the live candidate index and positions the drop-indicator
  // line there. Always returns MOVE_DROP -- this row/section is always a
  // valid reorder target while a clock is being dragged.
  _handleActiveDragOver(source, actor, x, y) {
    let [, pointerY] = global.get_pointer();
    let targetIndex = this._computeInsertionIndex(pointerY, this._getActiveRowGeometry());
    this._showDropIndicatorAt(targetIndex);
    return DND.DragMotionResult.MOVE_DROP;
  }

  // Shared acceptDrop for both the per-row drop targets and the active
  // section's own end-of-list target. Recomputes the same candidate index
  // (from the same live-geometry function AND the same stage-space pointer
  // source used by _handleActiveDragOver, so the actual drop index matches
  // whatever the indicator last showed), clears the indicator, then
  // performs the single reorder + save + refresh via _reorderActiveZone().
  _acceptActiveDrop(source, actor, x, y) {
    let zoneId = this._getDragSourceZone(source);
    if (!zoneId) {
      this._clearDropIndicator();
      return false;
    }

    let [, pointerY] = global.get_pointer();
    let targetIndex = this._computeInsertionIndex(pointerY, this._getActiveRowGeometry());
    this._clearDropIndicator();
    this._reorderActiveZone(zoneId, targetIndex);
    return true;
  }

  // Lazily creates the single drop-indicator actor (a thin highlighted
  // bar, styled inline since this extension ships no stylesheet.css) and
  // (re)inserts it into this._activeMenu.box at `index`, removing any
  // previous insertion first so there is never more than one indicator in
  // the tree at once. `isDropIndicator` tags it so _getActiveRowGeometry()
  // and any future logic can always recognize and skip it.
  //
  // RUNTIME ASSUMPTION (flag for verification): this actor is `reactive:
  // false`, intended to be click/pointer-transparent, but dnd.js's own
  // internal "what's under the pointer" resolution during a drag may use a
  // pick mode that considers non-reactive actors too. If so, pausing the
  // pointer precisely over the indicator's own thin strip could
  // momentarily resolve the drag-over target to this._activeMenu.box (the
  // end-of-list target) rather than a specific row, until the pointer moves
  // off it again. This is a cosmetic edge case at worst (the indicator is
  // only a couple of pixels tall) and cannot be confirmed without a live
  // shell -- flagged for user verification.
  _showDropIndicatorAt(index) {
    if (!this._dropIndicator) {
      this._dropIndicator = new St.Widget({
        style: 'height: 2px; margin: 2px 6px; background-color: #3584e4; border-radius: 1px;',
        reactive: false,
        x_expand: true
      });
      this._dropIndicator.isDropIndicator = true;
    }

    let box = this._activeMenu.box;
    if (this._dropIndicator.get_parent() === box) {
      box.remove_child(this._dropIndicator);
    }

    let clampedIndex = Math.max(0, Math.min(index, box.get_n_children()));
    box.insert_child_at_index(this._dropIndicator, clampedIndex);
  }

  // Removes and destroys the drop-indicator actor if one exists. MUST be
  // called on every drag exit path -- successful drop (_acceptActiveDrop),
  // cancelled/failed drag (the draggable's 'drag-end', which fires
  // regardless of outcome -- see _addActiveMenuRow), and defensively here
  // before _updateActiveMenu() rebuilds rows (that rebuild only destroys
  // actual PopupBaseMenuItem/PopupMenuSection rows via removeAll()'s
  // delegate-based discovery -- the indicator is a plain St.Widget child
  // added directly to the box, not a menu item, so removeAll() does not
  // know about it and would otherwise leave it orphaned in the tree
  // forever). Idempotent: safe to call when no indicator is present, and
  // safe to call more than once per drag.
  _clearDropIndicator() {
    if (!this._dropIndicator) {
      return;
    }
    if (this._dropIndicator.get_parent()) {
      this._dropIndicator.get_parent().remove_child(this._dropIndicator);
    }
    this._dropIndicator.destroy();
    this._dropIndicator = null;
  }

  // shexli (EGO-L-003): disconnects every tracked per-row draggable's
  // 'drag-end' signal (see this._rowDraggables, populated in
  // _addActiveMenuRow()) and empties the tracking array. `draggable`
  // (DND.makeDraggable()'s return value) is dnd.js's internal _Draggable
  // class -- TYPE NOTE: this could not be confirmed by live introspection,
  // but GNOME Shell's dnd.js has historically implemented _Draggable with
  // the plain-JS Signals mixin (imports.signals / misc/signals.js), NOT as
  // a GObject.Object subclass, so `connectObject`/`disconnectObject`
  // (GObject-only APIs) may not exist on it. Explicit id-based
  // connect()/disconnect() is used instead specifically because that pair
  // is guaranteed to work on EITHER a GObject or a Signals-mixin object,
  // sidestepping the need to be certain which one `draggable` actually is.
  //
  // Called both in disable() (final teardown) and at the start of every
  // _updateActiveMenu() rebuild, before removeAll() destroys the rows
  // (and their dragHandle/draggable instances) these entries reference --
  // otherwise every reorder would leave the just-replaced rows' draggables
  // (and their now-meaningless signal connections) tracked forever,
  // accumulating across repeated drags. Safe to call when a drag on one of
  // these rows is still finishing: _acceptActiveDrop() already calls
  // _clearDropIndicator() explicitly before _reorderActiveZone() triggers
  // the rebuild that gets here, so disconnecting a 'drag-end' handler that
  // hasn't fired yet for the just-completed drag never skips clearing the
  // indicator -- that already happened via the explicit call. A genuinely
  // cancelled/failed drag (Escape, drop outside a valid target) never
  // reaches _updateActiveMenu() at all (nothing triggers a rebuild), so
  // that row's own 'drag-end' handler is never disconnected prematurely
  // and still fires normally to clear the indicator.
  _clearRowDraggables() {
    this._rowDraggables.forEach(({ draggable, dragEndId }) => {
      draggable.disconnect(dragEndId);
    });
    this._rowDraggables = [];
  }

  _clearClocks() {
    this._state.forEach((item) => (item.active = false));
    this._activeOrder = [];
    this._updateMenu();
    this._updateLabel();
    this._saveSettings();
  }
}
