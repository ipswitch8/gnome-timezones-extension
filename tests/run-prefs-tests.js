#!/usr/bin/env -S gjs -m
// tests/run-prefs-tests.js
//
// Real, re-runnable GTK4/Adw widget-construction + interaction test for
// prefs.js. Unlike tests/run-tests.js (which only tests pure functions),
// this suite constructs the ACTUAL, UNMODIFIED prefs.js window --
// TimezonesPrefs.fillPreferencesWindow() -- via real Gtk.init()/Adw.init()
// and drives real GObject property/signal interactions on the resulting
// widget tree, then asserts on the resulting GSettings state.
//
// How prefs.js's shell-only import is resolved without a running
// gnome-shell prefs process:
//   prefs.js does `import { ExtensionPreferences } from
//   'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';`,
//   which only exists as a compiled-in GNOME Shell resource. This harness
//   compiles tests/prefs-shim/extension-preferences.js into a throwaway
//   GResource (via `glib-compile-resources`, an ordinary build-time tool,
//   already required to build extension.js's schema) and registers it
//   under that EXACT resource path, so prefs.js's import resolves for
//   real with NO source rewriting of prefs.js itself. See
//   tests/prefs-shim/extension-preferences.js's header comment for what
//   the shim implements (just getSettings()).
//
// Isolation (mandatory -- this must never touch the user's live session):
//   - GSETTINGS_BACKEND is forced to 'memory' (via GLib.setenv(), before
//     any Gio.Settings is ever constructed in this process) so every
//     settings read/write in this suite lives only in this process's
//     memory and is discarded on exit -- nothing reaches dconf or the
//     session bus.
//   - No gnome-extensions/gsettings/dconf CLI invocation anywhere in this
//     file, and the extension is never installed anywhere.
//   - The only external process spawned is `glib-compile-resources`,
//     writing to a throwaway temp file, exactly analogous to
//     `glib-compile-schemas` already being used to verify schemas/.
//
// Run: gjs -m tests/run-prefs-tests.js
//
// SKIP behavior: if GTK4/Adw typelibs or the `glib-compile-resources`
// tool are not available in this environment, the suite prints a loud
// "SKIPPED" banner (never a silent pass) and exits 0 -- see
// `skipLoudly()` below. Any failure of prefs.js's ACTUAL code (an
// exception during construction, a wrong widget name, a wrong settings
// value after an interaction) is a real test FAILURE and exits 1, same
// as tests/run-tests.js.

import GLib from 'gi://GLib';

// Forced BEFORE any Gio.Settings object is ever constructed anywhere in
// this process (Gio's GSettingsBackend is selected lazily, on first
// Settings construction -- verified empirically: setting this here, well
// before the shim's getSettings() ever runs, is sufficient). This is the
// isolation guarantee: nothing this suite does can reach dconf/the
// session bus.
GLib.setenv('GSETTINGS_BACKEND', 'memory', true);

import Gio from 'gi://Gio';

const SCRIPT_PATH = GLib.filename_from_uri(import.meta.url)[0];
const TESTS_DIR = GLib.path_get_dirname(SCRIPT_PATH);
const REPO_DIR = GLib.path_get_dirname(TESTS_DIR);
const SHIM_DIR = GLib.build_filenamev([TESTS_DIR, 'prefs-shim']);
const SHIM_XML = GLib.build_filenamev([SHIM_DIR, 'tzprefs-shim.gresource.xml']);
const SCHEMA_DIR = GLib.build_filenamev([REPO_DIR, 'schemas']);
const SCHEMA_ID = 'org.gnome.shell.extensions.timezones';

let passCount = 0;
let failCount = 0;
const failures = [];

function record(name, ok, detail) {
  if (ok) {
    passCount += 1;
    print(`PASS: ${name}`);
  } else {
    failCount += 1;
    failures.push(name);
    print(`FAIL: ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}

function test(name, fn) {
  try {
    fn();
    record(name, true);
  } catch (e) {
    record(name, false, e instanceof Error ? e.message : String(e));
  }
}

function assertEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg ? `${msg}: ` : ''}expected ${e}, got ${a}`);
  }
}

function assertTrue(value, msg) {
  if (value !== true) {
    throw new Error(msg || `expected true, got ${JSON.stringify(value)}`);
  }
}

// Prints an unambiguous "this suite did not actually run" banner and
// exits. Never used for a real failure of the code under test -- only
// for "this environment can't run GTK4/Adw widget construction at all".
//
// Project rule: SKIP=FAIL. A skipped suite is a failure, not a neutral
// outcome, so by DEFAULT this exits non-zero (1) -- indistinguishable
// from a real failure to anything that gates on exit status alone (CI,
// run-all.sh, the next agent just checking `$?`), which is deliberate:
// a silent-exit-0 skip is exactly what let a previous skip go unnoticed.
//
// The one legitimate opt-out is a genuinely GTK-less environment (no
// display-independent GTK4/Adw typelibs, or no glib-compile-resources
// available at all) where failing the whole suite would be a false
// alarm about prefs.js itself. That is opted into EXPLICITLY, never by
// default, via TZPREFS_ALLOW_SKIP=1 -- which downgrades this exact skip
// to exit 0, and says so plainly in the banner so it's never confused
// with a real pass either.
function skipLoudly(reason) {
  const allowSkip = GLib.getenv('TZPREFS_ALLOW_SKIP') === '1';
  print('');
  print('================================================================');
  print('SKIPPED: tests/run-prefs-tests.js DID NOT RUN');
  print(`Reason: ${reason}`);
  print('This is NOT a pass. Zero prefs.js assertions were exercised.');
  if (allowSkip) {
    print('TZPREFS_ALLOW_SKIP=1 is set: downgrading this skip to exit 0.');
    print('================================================================');
    imports.system.exit(0);
  } else {
    print('Per project policy SKIP=FAIL: exiting non-zero.');
    print('Set TZPREFS_ALLOW_SKIP=1 to explicitly accept this skip (exit 0)');
    print('for a genuinely GTK4/Adw-less environment.');
    print('================================================================');
    imports.system.exit(1);
  }
}

// --- Feature detection: GTK4 + Adw typelibs -------------------------

let Gtk, Adw;
try {
  imports.gi.versions.Gtk = '4.0';
  imports.gi.versions.Adw = '1';
  ({ default: Gtk } = await import('gi://Gtk'));
  ({ default: Adw } = await import('gi://Adw'));
} catch (e) {
  skipLoudly(`GTK4/Adw typelibs not importable: ${e instanceof Error ? e.message : String(e)}`);
}

try {
  Gtk.init();
  Adw.init();
} catch (e) {
  skipLoudly(`Gtk.init()/Adw.init() failed: ${e instanceof Error ? e.message : String(e)}`);
}

// --- Compile the shim GResource and register it ---------------------

let gresourcePath;
let tmpDir;
try {
  tmpDir = GLib.dir_make_tmp('tzprefs-shim-XXXXXX');
  if (!tmpDir) {
    throw new Error('GLib.dir_make_tmp failed');
  }
  gresourcePath = GLib.build_filenamev([tmpDir, 'tzprefs-shim.gresource']);

  const proc = Gio.Subprocess.new(
    ['glib-compile-resources', `--sourcedir=${SHIM_DIR}`, `--target=${gresourcePath}`, SHIM_XML],
    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
  );
  const [, , stderrBytes] = proc.communicate_utf8(null, null);
  if (!proc.get_successful()) {
    throw new Error(`glib-compile-resources failed: ${stderrBytes}`);
  }
} catch (e) {
  skipLoudly(`Could not compile the prefs.js resource shim (is glib-compile-resources installed?): ${e instanceof Error ? e.message : String(e)}`);
}

try {
  const resource = Gio.Resource.load(gresourcePath);
  resource._register();
} catch (e) {
  skipLoudly(`Could not load/register the shim GResource: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  // The GResource keeps its data mapped in memory once registered, so the
  // backing temp file/directory is safe to remove immediately rather than
  // leaking a fresh throwaway directory into /tmp on every test run.
  //
  // GLib.unlink()/GLib.rmdir() return a plain integer (0 on success,
  // non-zero on failure) rather than throwing on failure -- a prior
  // version of this cleanup only wrapped these in try/catch, which never
  // actually caught anything, since a non-zero return isn't a thrown
  // exception. That let ~9 stale empty tzprefs-shim-* directories
  // accumulate under /tmp across a session: GLib.rmdir() likely raced the
  // GResource mmap of the just-unlinked backing file on some runs (the
  // directory entry is gone, but the containing directory can still
  // transiently report non-empty/busy immediately after), and the failure
  // was silently swallowed instead of retried. Retrying rmdir a few times
  // with a short backoff (checking its actual return value) is
  // "make cleanup robust" without deferring the rmdir indefinitely or
  // reusing a single directory across runs -- either of which would be a
  // bigger structural change than this leak warrants.
  GLib.unlink(gresourcePath);
  let rmdirResult = -1;
  for (let attempt = 0; attempt < 5 && rmdirResult !== 0; attempt += 1) {
    if (attempt > 0) {
      GLib.usleep(20 * 1000); // 20ms backoff between retries.
    }
    rmdirResult = GLib.rmdir(tmpDir);
  }
  if (rmdirResult !== 0) {
    // Still non-fatal (a leftover empty temp dir is not a test failure),
    // but no longer silent -- if this ever fires it is a visible signal
    // that the retry budget above needs revisiting, not another silent
    // leak.
    print(`(cleanup warning: could not remove temp dir ${tmpDir} after retries -- non-fatal, suite continues)`);
  }
}

// --- From here on, every failure is a REAL failure of prefs.js's own
// code (or this harness's own bug), not an environment limitation -- so
// it is reported via test()/record() and contributes to a non-zero exit,
// same discipline as tests/run-tests.js. ------------------------------

globalThis.__TZ_SCHEMA_DIR__ = SCHEMA_DIR;
globalThis.__TZ_SCHEMA_ID__ = SCHEMA_ID;

const { default: TimezonesPrefs } = await import(`file://${REPO_DIR}/prefs.js`);
const { DEFAULT_FORMATTING, serializeFormatting, parseFormatting, rgbaToHex } = await import(`file://${REPO_DIR}/formatting.js`);
const { DATE_FORMATS, DEFAULT_DATE_FORMAT_ID } = await import(`file://${REPO_DIR}/dateFormats.js`);

function newSettings() {
  const source = Gio.SettingsSchemaSource.new_from_directory(SCHEMA_DIR, Gio.SettingsSchemaSource.get_default(), false);
  const schema = source.lookup(SCHEMA_ID, true);
  // GSETTINGS_BACKEND=memory (forced above) means this Gio.Settings is
  // entirely in-process; nothing here touches dconf.
  return new Gio.Settings({ settings_schema: schema });
}

function findByName(root, name) {
  if (!root) return null;
  if (root.get_name && root.get_name() === name) return root;
  if (typeof root.get_first_child === 'function') {
    let child = root.get_first_child();
    while (child) {
      const found = findByName(child, name);
      if (found) return found;
      child = child.get_next_sibling();
    }
  }
  return null;
}

function collectNamedWidgets(root, out) {
  if (!root) return;
  const name = root.get_name ? root.get_name() : null;
  if (name && name.startsWith('tzprefs-')) {
    out.push(name);
  }
  if (typeof root.get_first_child === 'function') {
    let child = root.get_first_child();
    while (child) {
      collectNamedWidgets(child, out);
      child = child.get_next_sibling();
    }
  }
}

// Mirrors prefs.js's private zoneToWidgetId() -- '/' -> '_' -- so this
// harness can compute the exact expected widget names for a known zone
// list without needing prefs.js to export that helper.
function zoneToWidgetId(zone) {
  return zone.replace(/\//g, '_');
}

function expectedWidgetNamesFor(zones) {
  const names = [
    'tzprefs-page',
    'tzprefs-defaults-group',
    'tzprefs-separator',
    'tzprefs-show-date',
    'tzprefs-date-format',
    'tzprefs-date-format-custom',
    'tzprefs-global-size',
    'tzprefs-global-color-row',
    'tzprefs-global-color',
    'tzprefs-global-color-clear',
    'tzprefs-global-bold-city',
    'tzprefs-global-bold-time',
    'tzprefs-global-bold-zone',
    'tzprefs-perzone-group',
  ];
  for (const zone of zones) {
    const id = zoneToWidgetId(zone);
    names.push(
      `tzprefs-expander-${id}`,
      `tzprefs-size-${id}`,
      `tzprefs-color-${id}-row`,
      `tzprefs-color-${id}`,
      `tzprefs-color-${id}-clear`,
      `tzprefs-bold-city-${id}`,
      `tzprefs-bold-time-${id}`,
      `tzprefs-bold-zone-${id}`,
      `tzprefs-clear-${id}`
    );
  }
  return names.sort();
}

const KNOWN_ZONES = ['UTC', 'America/Los_Angeles'];

// =====================================================================
// Suite 1: construction, exact widget-name set, zero-write-on-open
// =====================================================================

{
  const settings = newSettings();
  settings.set_strv('timezones', KNOWN_ZONES);
  settings.set_string('formatting-defaults', serializeFormatting({ ...DEFAULT_FORMATTING, size: 14, boldTime: true }));
  settings.set_value('formatting', new GLib.Variant('a{ss}', { UTC: serializeFormatting({ ...DEFAULT_FORMATTING, color: '#ff0000' }) }));

  const beforeSeparator = settings.get_string('separator');
  const beforeDefaults = settings.get_string('formatting-defaults');
  const beforeFormatting = settings.get_value('formatting').deep_unpack();
  const beforeTimezones = settings.get_strv('timezones');
  const beforeDateFormat = settings.get_string('date-format');
  const beforeConfig = settings.get_value('config').deep_unpack();

  const prefsObj = new TimezonesPrefs();
  prefsObj.getSettings = () => settings;
  const window = new Adw.PreferencesWindow();

  test('fillPreferencesWindow() constructs the real prefs.js window without throwing', () => {
    prefsObj.fillPreferencesWindow(window);
  });

  const names = [];
  collectNamedWidgets(window, names);
  names.sort();

  test('exact set of tzprefs-* widget names matches the documented naming scheme (not just a count)', () => {
    assertEqual(names, expectedWidgetNamesFor(KNOWN_ZONES));
  });

  test('opening the window with zero interaction changes zero GSettings keys (backward compat, requirement 5)', () => {
    assertEqual(settings.get_string('separator'), beforeSeparator, 'separator');
    assertEqual(settings.get_string('formatting-defaults'), beforeDefaults, 'formatting-defaults');
    assertEqual(settings.get_value('formatting').deep_unpack(), beforeFormatting, 'formatting');
    assertEqual(settings.get_strv('timezones'), beforeTimezones, 'timezones');
    // Date feature additions: zero-interaction must also leave the new
    // 'date-format' key AND the 'config' key (holding "Show date") alone --
    // both are newly-touchable by this file as of this feature, so this
    // guarantee is worth asserting explicitly, not just assumed to be
    // covered by the pre-existing keys above.
    assertEqual(settings.get_string('date-format'), beforeDateFormat, 'date-format');
    assertEqual(settings.get_value('config').deep_unpack(), beforeConfig, 'config');
  });
}

// =====================================================================
// Suite 1b: INITIAL DISPLAYED WIDGET VALUES for a zone with a pre-
// existing override, and for a zone with no override (must show the
// current global defaults, not neutral DEFAULT_FORMATTING).
//
// REGRESSION COVERAGE: this is the exact gap that let the
// readEffective()-returns-a-raw-string bug through -- the earlier
// version of this suite seeded a UTC override before construction but
// never asserted what the widgets actually DISPLAYED for it. The bug
// (getEffectiveFormatting() handing prefs.js a raw JSON string instead
// of a parsed object for any zone with an existing override) made every
// one of that zone's controls silently show neutral defaults (size 0,
// color black/unset, every bold flag off) instead of the real saved
// values -- reproduced directly against the real prefs.js by the
// validator gate. Every field below is deliberately given a DISTINCT,
// non-neutral, non-default value so a silent fallback to neutral OR to
// the wrong precedence level is guaranteed to be caught.
// =====================================================================

{
  const settings = newSettings();
  settings.set_strv('timezones', KNOWN_ZONES);
  // Global defaults and UTC's override are each deliberately given EVERY
  // field non-neutral (DEFAULT_FORMATTING's bool fields are all `false`,
  // so a bool must be `true` here to differ from neutral) -- a fallback
  // to neutral defaults instead of the correct precedence level would be
  // caught on every single field, for both fixtures. size/color also
  // differ between the two fixtures (24/#123456 vs 14/#3584e4), which is
  // what catches a "wrong precedence level" bug (override vs defaults
  // swapped) independently of the neutral-fallback check.
  const globalDefaults = { size: 14, color: '#3584e4', boldCity: true, boldTime: true, boldZone: true };
  settings.set_string('formatting-defaults', serializeFormatting(globalDefaults));
  const utcOverride = { size: 24, color: '#123456', boldCity: true, boldTime: true, boldZone: true };
  settings.set_value('formatting', new GLib.Variant('a{ss}', { UTC: serializeFormatting(utcOverride) }));
  // America/Los_Angeles deliberately gets NO override -- it must display
  // globalDefaults, not DEFAULT_FORMATTING's neutral values.

  const prefsObj = new TimezonesPrefs();
  prefsObj.getSettings = () => settings;
  const window = new Adw.PreferencesWindow();
  prefsObj.fillPreferencesWindow(window);

  const laWidgetId = 'America_Los_Angeles';

  test('a zone with a pre-existing override displays the OVERRIDE size, not neutral/defaults', () => {
    const widget = findByName(window, 'tzprefs-size-UTC');
    assertTrue(widget !== null, 'UTC size SpinRow not found');
    assertEqual(widget.value, utcOverride.size, `UTC size widget should show ${utcOverride.size}`);
  });

  test('a zone with a pre-existing override displays the OVERRIDE color, not neutral/defaults', () => {
    const widget = findByName(window, 'tzprefs-color-UTC');
    assertTrue(widget !== null, 'UTC color widget not found');
    assertEqual(rgbaToHex(widget.rgba), utcOverride.color, `UTC color widget should show ${utcOverride.color}`);
  });

  test('a zone with a pre-existing override displays the OVERRIDE boldCity, not neutral/defaults', () => {
    const widget = findByName(window, 'tzprefs-bold-city-UTC');
    assertTrue(widget !== null, 'UTC boldCity SwitchRow not found');
    assertEqual(widget.active, utcOverride.boldCity, 'UTC boldCity widget should match the override');
  });

  test('a zone with a pre-existing override displays the OVERRIDE boldTime, not neutral/defaults', () => {
    const widget = findByName(window, 'tzprefs-bold-time-UTC');
    assertTrue(widget !== null, 'UTC boldTime SwitchRow not found');
    assertEqual(widget.active, utcOverride.boldTime, 'UTC boldTime widget should match the override');
  });

  test('a zone with a pre-existing override displays the OVERRIDE boldZone, not neutral/defaults', () => {
    const widget = findByName(window, 'tzprefs-bold-zone-UTC');
    assertTrue(widget !== null, 'UTC boldZone SwitchRow not found');
    assertEqual(widget.active, utcOverride.boldZone, 'UTC boldZone widget should match the override');
  });

  test('a zone with NO override displays the current GLOBAL DEFAULTS size (not DEFAULT_FORMATTING)', () => {
    const widget = findByName(window, `tzprefs-size-${laWidgetId}`);
    assertTrue(widget !== null, 'LA size SpinRow not found');
    assertEqual(widget.value, globalDefaults.size, `LA size widget should show the global default ${globalDefaults.size}`);
  });

  test('a zone with NO override displays the current GLOBAL DEFAULTS color (not DEFAULT_FORMATTING)', () => {
    const widget = findByName(window, `tzprefs-color-${laWidgetId}`);
    assertTrue(widget !== null, 'LA color widget not found');
    assertEqual(rgbaToHex(widget.rgba), globalDefaults.color, `LA color widget should show the global default ${globalDefaults.color}`);
  });

  test('a zone with NO override displays the current GLOBAL DEFAULTS bold flags (not DEFAULT_FORMATTING)', () => {
    const boldCity = findByName(window, `tzprefs-bold-city-${laWidgetId}`);
    const boldTime = findByName(window, `tzprefs-bold-time-${laWidgetId}`);
    const boldZone = findByName(window, `tzprefs-bold-zone-${laWidgetId}`);
    assertEqual(boldCity.active, globalDefaults.boldCity, 'LA boldCity should match the global default');
    assertEqual(boldTime.active, globalDefaults.boldTime, 'LA boldTime should match the global default (true) -- DEFAULT_FORMATTING would wrongly show false');
    assertEqual(boldZone.active, globalDefaults.boldZone, 'LA boldZone should match the global default');
  });
}

// =====================================================================
// Suite 1c: date controls ("Show date" switch, the curated date-format
// ComboRow, and the free-form custom EntryRow) -- initial displayed
// values for both a curated stored id and a custom/literal stored value,
// plus real interactions on each control.
// =====================================================================

{
  const settings = newSettings();
  settings.set_strv('timezones', KNOWN_ZONES);
  settings.set_value('config', new GLib.Variant('a{sb}', { format24: true, showCity: true, showTimezone: false, hideSystemClock: false, showSeparator: false, showDate: true }));
  settings.set_string('date-format', 'iso'); // a curated id

  const prefsObj = new TimezonesPrefs();
  prefsObj.getSettings = () => settings;
  const window = new Adw.PreferencesWindow();
  prefsObj.fillPreferencesWindow(window);

  test('"Show date" SwitchRow displays the current config.showDate value (true)', () => {
    const widget = findByName(window, 'tzprefs-show-date');
    assertTrue(widget !== null, 'tzprefs-show-date not found');
    assertEqual(widget.active, true, 'Show date switch should display true');
  });

  test('date-format ComboRow preselects the curated entry matching the stored id ("iso")', () => {
    const widget = findByName(window, 'tzprefs-date-format');
    assertTrue(widget !== null, 'tzprefs-date-format not found');
    const isoIndex = DATE_FORMATS.findIndex((e) => e.id === 'iso');
    assertEqual(widget.selected, isoIndex, 'ComboRow should preselect the "iso" entry');
  });

  test('custom date-format EntryRow is EMPTY when the stored value is a curated id, not the literal id string', () => {
    const widget = findByName(window, 'tzprefs-date-format-custom');
    assertTrue(widget !== null, 'tzprefs-date-format-custom not found');
    assertEqual(widget.text, '', 'custom entry should be empty for a curated stored id');
  });

  test('toggling the real "Show date" switch writes config.showDate and NOT date-format/formatting-defaults', () => {
    const widget = findByName(window, 'tzprefs-show-date');
    widget.active = false;
    const config = settings.get_value('config').deep_unpack();
    assertEqual(config.showDate, false, 'config.showDate should now be false');
    assertEqual(settings.get_string('date-format'), 'iso', 'date-format must be untouched by the Show date switch');
  });

  test('selecting a different curated entry on the real ComboRow writes its id to date-format', () => {
    const widget = findByName(window, 'tzprefs-date-format');
    const weekdayIndex = DATE_FORMATS.findIndex((e) => e.id === 'weekday');
    assertTrue(weekdayIndex >= 0, 'test setup problem: "weekday" entry not found');
    widget.selected = weekdayIndex;
    assertEqual(settings.get_string('date-format'), 'weekday', 'date-format should now be "weekday"');
  });

  test('typing a literal pattern into the real custom EntryRow writes it verbatim to date-format, overriding the ComboRow pick', () => {
    const widget = findByName(window, 'tzprefs-date-format-custom');
    widget.text = '%G-W%V';
    assertEqual(settings.get_string('date-format'), '%G-W%V', 'date-format should now be the literal custom pattern');
  });

  test('clearing the custom EntryRow back to empty does NOT write an empty date-format (leaves the last real value in place)', () => {
    const widget = findByName(window, 'tzprefs-date-format-custom');
    widget.text = '';
    assertEqual(settings.get_string('date-format'), '%G-W%V', 'date-format should still hold the last non-empty custom value');
  });
}

// =====================================================================
// Suite 1d: a PRE-EXISTING custom/literal date-format value (not a
// curated id) must show up verbatim in the custom EntryRow, and the
// ComboRow must fall back to displaying the curated default rather than
// silently resolving to index 0 for an unrelated reason.
// =====================================================================

{
  const settings = newSettings();
  settings.set_strv('timezones', KNOWN_ZONES);
  settings.set_string('date-format', '%d.%m.%Y'); // literal, not a curated id

  const prefsObj = new TimezonesPrefs();
  prefsObj.getSettings = () => settings;
  const window = new Adw.PreferencesWindow();
  prefsObj.fillPreferencesWindow(window);

  test('custom date-format EntryRow displays the PRE-EXISTING literal value verbatim', () => {
    const widget = findByName(window, 'tzprefs-date-format-custom');
    assertEqual(widget.text, '%d.%m.%Y', 'custom entry should show the stored literal pattern');
  });

  test('date-format ComboRow falls back to the curated DEFAULT_DATE_FORMAT_ID for a non-curated stored value', () => {
    const widget = findByName(window, 'tzprefs-date-format');
    const defaultIndex = DATE_FORMATS.findIndex((e) => e.id === DEFAULT_DATE_FORMAT_ID);
    assertEqual(widget.selected, defaultIndex, 'ComboRow should fall back to the curated default entry');
  });

  test('opening prefs with a pre-existing literal date-format and touching nothing does not overwrite it', () => {
    assertEqual(settings.get_string('date-format'), '%d.%m.%Y', 'date-format must be unchanged by construction alone');
  });
}

// =====================================================================
// Suite 2: real interactions on the constructed widget tree
// =====================================================================

{
  const settings = newSettings();
  settings.set_strv('timezones', KNOWN_ZONES);
  settings.set_string('formatting-defaults', serializeFormatting({ ...DEFAULT_FORMATTING, size: 14, boldTime: true }));
  settings.set_value('formatting', new GLib.Variant('a{ss}', { UTC: serializeFormatting({ ...DEFAULT_FORMATTING, color: '#ff0000' }) }));

  const prefsObj = new TimezonesPrefs();
  prefsObj.getSettings = () => settings;
  const window = new Adw.PreferencesWindow();
  prefsObj.fillPreferencesWindow(window);

  const laWidgetId = 'America_Los_Angeles';

  test('editing a field on a zone with NO prior override creates one, isolated from other zones', () => {
    const laSize = findByName(window, `tzprefs-size-${laWidgetId}`);
    assertTrue(laSize !== null, 'LA size SpinRow not found');
    laSize.value = 22;

    const map = settings.get_value('formatting').deep_unpack();
    assertTrue(Object.prototype.hasOwnProperty.call(map, 'America/Los_Angeles'), 'LA override not created');
    assertEqual(parseFormatting(map['America/Los_Angeles']).size, 22, 'LA override size');
    assertEqual(map.UTC, serializeFormatting({ ...DEFAULT_FORMATTING, color: '#ff0000' }), 'UTC untouched by LA edit');
  });

  test('new override is seeded from the CURRENTLY EFFECTIVE values, not neutral defaults (regression: boldTime must not silently flip off)', () => {
    // The global default has boldTime: true (set above) and LA had no
    // prior override before the previous test's size edit. If LA's new
    // override had been seeded from DEFAULT_FORMATTING (all-neutral)
    // instead of the effective/global-default values the SpinRow/Switch
    // rows were actually showing, boldTime would have been silently
    // reset to false here even though the "Bold time" switch still shows
    // ON in the UI.
    const map = settings.get_value('formatting').deep_unpack();
    assertEqual(parseFormatting(map['America/Los_Angeles']).boldTime, true, 'LA boldTime should match the effective global default at edit time');
  });

  test('a second field edit on the SAME zone preserves the first (read-modify-write within one zone)', () => {
    const laBoldCity = findByName(window, `tzprefs-bold-city-${laWidgetId}`);
    laBoldCity.active = true;

    const map = settings.get_value('formatting').deep_unpack();
    const fmt = parseFormatting(map['America/Los_Angeles']);
    assertEqual(fmt.size, 22, 'LA size should still be 22 after the boldCity edit');
    assertEqual(fmt.boldCity, true, 'LA boldCity should now be true');
  });

  test('global-default edits never touch the per-zone formatting map', () => {
    const globalSize = findByName(window, 'tzprefs-global-size');
    globalSize.value = 18;

    const map = settings.get_value('formatting').deep_unpack();
    assertEqual(Object.keys(map).sort(), ['America/Los_Angeles', 'UTC'], 'per-zone map keys should be unchanged by a global-default edit');
    assertEqual(parseFormatting(settings.get_string('formatting-defaults')).size, 18, 'global default size should be persisted');
  });

  test('"Clear override" REMOVES the zone entry entirely rather than storing a neutral blob', () => {
    const utcClear = findByName(window, 'tzprefs-clear-UTC');
    assertTrue(utcClear !== null, 'UTC clear button not found');
    utcClear.emit('clicked');

    const map = settings.get_value('formatting').deep_unpack();
    assertTrue(!Object.prototype.hasOwnProperty.call(map, 'UTC'), 'UTC entry should be removed entirely');
    assertTrue(Object.prototype.hasOwnProperty.call(map, 'America/Los_Angeles'), 'LA override should survive clearing UTC');
  });

  test('suppressCommit guard prevents the display-reset from re-firing and re-adding the just-cleared entry', () => {
    // The "Clear override" click handler resets every row's displayed
    // value to the (now-effective) default so the UI updates immediately
    // -- each of those programmatic value changes fires its own
    // 'notify::value'/'notify::rgba'/'notify::active' signal. Without the
    // suppressCommit guard in prefs.js, that would silently re-add a
    // per-zone override that merely happens to match the defaults right
        // now, undoing the clear. Assert it does NOT happen.
    const map = settings.get_value('formatting').deep_unpack();
    assertTrue(!Object.prototype.hasOwnProperty.call(map, 'UTC'), 'UTC entry must still be absent after the display-reset following clear');

    const utcSize = findByName(window, 'tzprefs-size-UTC');
    // The now-effective size for UTC (no override) is the current global
    // default (18, set above) -- the SpinRow should display it even
    // though no write was re-committed.
    assertEqual(utcSize.value, 18, 'UTC size widget should display the effective (global default) value after clearing');
  });

  test('after "Clear override", ALL FIVE of the cleared zone\'s controls display the current global defaults', () => {
    // Companion to the suppressCommit test above, which only checked
    // size. This is the "Clear override" half of the same
    // readEffective()-must-return-a-parsed-object regression: the reset
    // block in prefs.js reads settings.get_string('formatting-defaults')
    // (a raw string) via readEffective()/getEffectiveFormatting() for
    // every control, not just size.
    const currentDefaults = parseFormatting(settings.get_string('formatting-defaults'));
    assertEqual(currentDefaults.size, 18, 'sanity: global default size should be 18 at this point in the suite');

    const utcColor = findByName(window, 'tzprefs-color-UTC');
    // An empty color ('' -- "inherit"/unset) has no direct RGBA
    // representation, so the color-picker widget's swatch conventionally
    // shows opaque black for it (see hexToRgba()'s doc comment in
    // prefs.js); only a genuinely non-empty default color is expected to
    // round-trip through the widget's rgba property exactly.
    const expectedColorHex = currentDefaults.color || '#000000';
    assertEqual(rgbaToHex(utcColor.rgba), expectedColorHex, 'UTC color widget should display the current global default color after clearing');

    const utcBoldCity = findByName(window, 'tzprefs-bold-city-UTC');
    const utcBoldTime = findByName(window, 'tzprefs-bold-time-UTC');
    const utcBoldZone = findByName(window, 'tzprefs-bold-zone-UTC');
    assertEqual(utcBoldCity.active, currentDefaults.boldCity, 'UTC boldCity widget should display the current global default after clearing');
    assertEqual(utcBoldTime.active, currentDefaults.boldTime, 'UTC boldTime widget should display the current global default (true) after clearing');
    assertEqual(utcBoldZone.active, currentDefaults.boldZone, 'UTC boldZone widget should display the current global default after clearing');
  });
}

// =====================================================================
// Suite 3: unknown/foreign zone ids in the 'timezones' key are dropped
// from the per-zone formatting UI, mirroring extension.js's own
// "stale/foreign dconf entry" filtering (see _loadSettings()). A
// hand-edited/tampered dconf 'timezones' value containing an id this
// extension doesn't recognize (e.g. a markup payload, or simply a typo'd
// zone) must not produce an Adw.ExpanderRow at all -- in particular, it
// must never reach Adw.ExpanderRow.title, which libadwaita interprets as
// Pango markup.
// =====================================================================

{
  const settings = newSettings();
  const hostileZone = '<b>evil</b>';
  settings.set_strv('timezones', ['UTC', hostileZone, 'Not/AZone']);

  const prefsObj = new TimezonesPrefs();
  prefsObj.getSettings = () => settings;
  const window = new Adw.PreferencesWindow();

  test('fillPreferencesWindow() does not throw when the timezones key contains unknown/hostile entries', () => {
    prefsObj.fillPreferencesWindow(window);
  });

  test('an unknown/hostile zone id produces no expander widget at all', () => {
    const widget = findByName(window, `tzprefs-expander-${zoneToWidgetId(hostileZone)}`);
    assertTrue(widget === null, 'hostile zone must not get an expander row');
  });

  test('an unrecognized-but-benign-looking zone id ("Not/AZone") also produces no expander widget', () => {
    const widget = findByName(window, `tzprefs-expander-${zoneToWidgetId('Not/AZone')}`);
    assertTrue(widget === null, 'unknown zone must not get an expander row');
  });

  test('the known zone (UTC) still gets its expander even when other timezones entries are unknown', () => {
    const widget = findByName(window, 'tzprefs-expander-UTC');
    assertTrue(widget !== null, 'UTC expander should still be built');
  });

  test('only the known-zone widget names are present -- unknown entries contribute nothing to the widget tree', () => {
    const names = [];
    collectNamedWidgets(window, names);
    names.sort();
    assertEqual(names, expectedWidgetNamesFor(['UTC']));
  });
}

// =====================================================================
// summary
// =====================================================================

print('');
print(`Summary: ${passCount} passed, ${failCount} failed, ${passCount + failCount} total`);

if (failCount > 0) {
  print('');
  print('Failed tests:');
  for (const name of failures) {
    print(`  - ${name}`);
  }
}

imports.system.exit(failCount > 0 ? 1 : 0);
