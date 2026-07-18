# Tests

Two plain-GJS assertion suites. No test framework, no npm.

## `run-tests.js` -- pure-function suite

Exercises `formatting.js`, `separators.js`, and `formattingPresets.js`
directly: escaping/sanitization, markup assembly, the `formatting` map's
read-modify-write helper (`setZoneFormatting`), RGBA->hex conversion
(`rgbaToHex`), and the per-zone/global-default precedence rule
(`getEffectiveFormatting`). No GTK/Adw involved.

```sh
gjs -m tests/run-tests.js
```

## `run-prefs-tests.js` -- real prefs.js GTK4/Adw suite

Constructs the ACTUAL, unmodified `prefs.js` window
(`TimezonesPrefs.fillPreferencesWindow()`) under real `Gtk.init()`/
`Adw.init()`, and drives real GObject property/signal interactions
(`spinRow.value = ...`, `switchRow.active = ...`,
`clearButton.emit('clicked')`, etc.) on the resulting widget tree,
asserting on the resulting GSettings state. This is what actually proves
the prefs window works, as opposed to the pure-function suite above,
which only proves its underlying helpers are individually correct.

```sh
gjs -m tests/run-prefs-tests.js
```

What it verifies:
- `fillPreferencesWindow()` constructs without throwing.
- The exact set of `tzprefs-*` widget names for a known zone list (not
  just a count -- a count alone would still pass even if the naming
  scheme silently changed, defeating the AT-SPI automation convention).
- Opening the window with zero interaction changes zero GSettings keys.
- Editing one field on a zone with no prior override creates an
  isolated override (other zones untouched), seeded from the
  *currently effective* values (global defaults), not neutral ones.
- A second edit on the same zone preserves the first (read-modify-write).
- Global-default edits never touch the per-zone `formatting` map.
- "Clear override" removes the zone's map entry entirely (never stores
  a neutral blob), and the subsequent UI-refresh step does not silently
  re-add it (the `suppressCommit` guard in `prefs.js`).

### How it resolves prefs.js's shell-only import

`prefs.js` imports
`resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js`, which
only exists inside a running `gnome-shell` prefs process. This suite
compiles `tests/prefs-shim/extension-preferences.js` (a minimal stand-in
implementing just `getSettings()`) into a throwaway GResource via
`glib-compile-resources` and registers it under that exact resource path,
so `prefs.js`'s real, **unmodified** import resolves for real -- no
source rewriting.

### Isolation

- `GSETTINGS_BACKEND` is forced to `memory` (via `GLib.setenv()`, before
  any `Gio.Settings` is constructed) so every settings read/write in this
  suite lives only in-process and is discarded on exit -- nothing reaches
  dconf or the session bus.
- No `gnome-extensions`/`gsettings`/`dconf` CLI invocation anywhere, and
  the extension is never installed anywhere.
- The only external process spawned is `glib-compile-resources`, writing
  to a throwaway temp file that is deleted immediately after the
  resource is loaded/registered.

### Skip behavior -- SKIP=FAIL by default

If GTK4/Adw typelibs or the `glib-compile-resources` tool are not
available in the running environment, the suite prints a loud
`SKIPPED: ... DID NOT RUN` banner. Per this project's standing rule
**SKIP=FAIL** (a skipped test is a failure, not a neutral outcome), this
banner is paired with a **non-zero exit by default** -- indistinguishable
from a real failure to anything that only checks the exit code (CI,
`run-all.sh`, a script piping through `$?`). This is deliberate: an
earlier version of this suite exited `0` on skip, which is exactly the
"looks clean from the outside, nothing was actually tested" failure mode
SKIP=FAIL exists to prevent.

Any failure of `prefs.js`'s actual behavior (an exception during
construction, a wrong widget name, a wrong resulting settings value) is
a distinct, ordinary test failure and also exits `1`, with per-assertion
`FAIL:` lines instead of the skip banner -- same discipline as
`run-tests.js`.

**Opt-out for a genuinely GTK-less environment:** set
`TZPREFS_ALLOW_SKIP=1` to explicitly downgrade a skip to exit `0`. The
banner says so plainly (`TZPREFS_ALLOW_SKIP=1 is set: downgrading this
skip to exit 0.`) so it is never confused with an actual pass when
reading the output. Not set by default anywhere in this repo (not in
`run-prefs-tests.js`, not in `run-all.sh`) -- it must be set explicitly
by whoever is running the suite in an environment where they've already
confirmed GTK4/Adw genuinely cannot be available.

```sh
# Default: cannot construct widgets -> loud banner -> exit 1 (SKIP=FAIL)
gjs -m tests/run-prefs-tests.js

# Explicit opt-out: same banner, but exits 0
TZPREFS_ALLOW_SKIP=1 gjs -m tests/run-prefs-tests.js
```

## Running both suites

```sh
tests/run-all.sh
```

Runs `run-tests.js` then `run-prefs-tests.js` (with
`GSETTINGS_BACKEND=memory` set for the latter as defense-in-depth) and
exits non-zero if either suite fails -- including a skipped prefs suite
(SKIP=FAIL, see above), unless `TZPREFS_ALLOW_SKIP=1` is set in the
environment before invoking `run-all.sh` (it is a normal environment
variable, so it is inherited by the `gjs` child process with no extra
plumbing in the script).

## Adding tests

Add new `test('name', () => { ... })` calls to the relevant suite, using
`assertEqual`/`assertTrue`/`assertFalse` for assertions. Never delete,
skip, or weaken an existing test to make a suite pass -- fix the
implementation instead.
