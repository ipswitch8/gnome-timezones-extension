// tests/prefs-shim/extension-preferences.js
//
// Minimal stand-in for the real GNOME Shell resource module
// resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js, which
// only exists inside a running gnome-shell prefs process (gjs -m
// tests/run-prefs-tests.js is plain gjs, not that process). This shim is
// compiled into a throwaway GResource at test-run time (see
// run-prefs-tests.js) and registered under that EXACT resource path, so
// prefs.js's real, UNMODIFIED
//   import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
// resolves for real -- no source rewriting of prefs.js is needed to test
// it, unlike a plain mock-and-substitute approach.
//
// Only the one method prefs.js actually calls on its base class --
// getSettings() -- is implemented, backed by a real Gio.Settings loaded
// from this repo's schemas/ directory. The test harness forces
// GSETTINGS_BACKEND=memory before any Gio.Settings is constructed (see
// run-prefs-tests.js), so this never touches dconf or the session bus.
import Gio from 'gi://Gio';

export class ExtensionPreferences {
  getSettings(schemaId) {
    const source = Gio.SettingsSchemaSource.new_from_directory(
      globalThis.__TZ_SCHEMA_DIR__,
      Gio.SettingsSchemaSource.get_default(),
      false
    );
    const schema = source.lookup(schemaId || globalThis.__TZ_SCHEMA_ID__, true);
    return new Gio.Settings({ settings_schema: schema });
  }
}
