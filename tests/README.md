# Tests

Three suites: two plain-GJS assertion suites, plus a shell-level driver
that runs a real gnome-shell process. No test framework, no npm.

## `run-tests.js` -- pure-function suite

Exercises `formatting.js`, `separators.js`, `dateFormats.js`, and
`hoverPopup.js` directly: escaping/sanitization, markup assembly, the
`formatting` map's read-modify-write helper (`setZoneFormatting`),
RGBA->hex conversion (`rgbaToHex`), the per-zone/global-default
precedence rule (`getEffectiveFormatting`), date-format resolution and
null-safe formatting (`resolveDateFormat`/`formatDateForDisplay`), and
the dates-only hover popup's single-line cell model
(`hoverPopup.js`'s `buildHoverPopupCells()`). No GTK/Adw involved.

(`formattingPresets.js` was deleted along with the popup menu's Font
size/Color preset submenus -- prefs.js uses a real spin control and
colour picker instead, and never imported it.)

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

## `run-shell-tests.sh` -- real gnome-shell driver (Phase 5)

Closes the gap the two suites above cannot reach: everything that only
exists once a real GNOME Shell is actually running -- panel rendering, the
popup menu's separator/formatting-default controls, drag-and-drop reorder,
inline rename, and `disable()`/lock-screen teardown.

```sh
tests/run-shell-tests.sh
```

### How it works

1. Creates a throwaway sandbox directory (`mktemp -d /tmp/tzshell-XXXXXX`
   -- deliberately short, since `dbus-run-session`/dconf create `AF_UNIX`
   sockets under `XDG_RUNTIME_DIR` and the kernel caps `sun_path` at 108
   bytes) and points `HOME`/`XDG_DATA_HOME`/`XDG_CONFIG_HOME`/
   `XDG_CACHE_HOME`/`XDG_RUNTIME_DIR` at it.
2. Copies the **real, unmodified** target extension source
   (`extension.js`, `formatting.js`, `separators.js`, `dateFormats.js`,
   `hoverPopup.js`, `timezones.js`, `cityAliases.js`, `metadata.json`,
   `schemas/`) into the sandbox's extensions directory verbatim -- never
   edited, never reimplemented -- and recompiles its schema there. This
   list must match the one in `run-shell-tests.sh` itself; if you add a
   module the extension imports, add it in both places or the sandboxed
   shell will fail to load the extension.
3. Copies `tests/shell-driver/` (this project's own small companion test
   extension, `shell-driver@tests.local`) alongside it.
4. Runs `gsettings set org.gnome.shell enabled-extensions
   '["shell-driver@tests.local"]'` and launches `gnome-shell --headless
   --virtual-monitor 800x600`, both inside the **same** `dbus-run-session`
   (so the pre-seeded setting and the shell process share one isolated
   session bus).
5. The driver's `enable()` runs automatically at shell startup (see
   `tests/shell-driver/extension.js`): it enables the real target
   extension via `Main.extensionManager.enableExtension()`, reaches its
   real running instance via `Main.extensionManager.lookup(uuid).stateObj`,
   and drives its real instance methods and real GObject/PopupMenu signals
   directly -- not a reimplementation of any of its logic.
6. This script polls for the driver's JSON result file, prints every
   `PASS`/`FAIL` line plus a summary, greps the shell's own log for `JS
   ERROR`/`JS WARNING` lines that reference the sandbox's own path (i.e.
   originate from either extension copied into it), and tears the sandbox
   down (best-effort `fusermount`/`umount` of any `xdg-desktop-portal`
   documents mount first, then `rm -rf`).

### What it actually drives (and what it doesn't)

See `tests/shell-driver/extension.js` for the exact assertions and their
own inline reasoning, and the "Verification coverage" section below for
the honest boundary between what this proves and what remains manual-only.
In short: this reaches into the REAL, already-enabled extension instance
and calls its real methods / emits real signals on its real widget tree
(separator submenu rows, the real `_reorderActiveZone`/
`_computeInsertionIndex`/`_handleActiveDragOver`/`_acceptActiveDrop`/
`_getDragSourceZone`, the real `_setLabel()`, and a real, argument-free
`key-focus-out` signal emission for rename-cancel) -- but it does **not**
synthesize real pointer-driven drag input or a real keyboard `Return`
keypress (both would require constructing raw `Clutter.Event`s outside the
shell's own input pipeline, which was judged too likely to crash/hang this
headless Clutter/Mutter build to attempt for a test driver -- this is the
same class of limitation the DnD section below has always documented).

### Skip behavior -- SKIP=FAIL by default, with a narrow exception

If `gnome-shell` or `dbus-run-session` is not installed at all, this
script prints a loud `SKIPPED` banner and exits non-zero by default, same
as `run-prefs-tests.js`. Set `TZSHELL_ALLOW_SKIP=1` to explicitly downgrade
**that specific case** to exit `0`.

Every other failure mode -- a real assertion failure, the result file
never appearing within the timeout, the sandboxed shell process dying
early, or a `JS ERROR`/`JS WARNING` in its log -- is always a real failure
and always exits non-zero, **regardless of `TZSHELL_ALLOW_SKIP`**: that
variable only covers "gnome-shell genuinely isn't installed here," never
"the shell ran but something was wrong."

```sh
# Default: real assertion failures / timeouts always exit 1
tests/run-shell-tests.sh

# Only affects the "gnome-shell not installed at all" case
TZSHELL_ALLOW_SKIP=1 tests/run-shell-tests.sh
```

### Isolation / live-session safety

- Every runtime command (`gsettings`, `gnome-shell`) runs inside its own
  `dbus-run-session`, never against the invoking user's real session bus.
- `HOME`/`XDG_DATA_HOME`/`XDG_CONFIG_HOME`/`XDG_CACHE_HOME`/
  `XDG_RUNTIME_DIR` are all redirected into the throwaway sandbox before
  anything is launched, so nothing here ever reads or writes the invoking
  user's real `~/.local/share/gnome-shell/extensions`, their real dconf
  database, or their real GNOME Shell session.
- The target extension's real source files are **copied** into the
  sandbox; the checked-out repo tree is never modified.
- The whole `dbus-run-session`/`dbus-daemon`/`gnome-shell` process tree is
  launched under `setsid` as its own process group and killed by negative
  PID (`kill -- -$SHELL_PID`, TERM then KILL) on every exit path,
  including a timeout or a real assertion failure -- a plain `kill` of
  just the backgrounded job (an earlier version of this script) does NOT
  propagate to the `gnome-shell` process it execs into, and was confirmed
  to orphan a full process tree on every single run, including successful
  ones (see the "karen gate" section above, finding 4).
- The sandbox directory (including its `xdg-desktop-portal` documents
  FUSE mount, if any) is deleted on every exit path (`trap ... EXIT INT
  TERM`), success or failure. The FUSE unmount is attempted
  unconditionally, not gated by a directory-existence check (a
  disconnected FUSE mount fails `[ -d ... ]`, which silently skipped the
  unmount in an earlier version of this script -- same finding 4).

### Resolution matrix and minimum supported screen height (karen-gate rounds 3-4)

`run-shell-tests.sh` runs its ENTIRE shell-driver suite once per
resolution in a small, committed matrix by default -- `1024x768`,
`1280x720`, `1366x768`, `1600x1200` -- re-invoking itself once per
resolution with `TZSHELL_VIRTUAL_MONITOR` set. Any one resolution failing
fails the whole script. `TZSHELL_VIRTUAL_MONITOR` remains available to
force a single resolution (fast local iteration, or reproducing one
matrix entry in isolation); when it is set, the matrix sweep is skipped
and exactly that one resolution runs.

```sh
# Default: sweeps the full resolution matrix, one full sandboxed run each
tests/run-shell-tests.sh

# Force a single resolution (skips the matrix)
TZSHELL_VIRTUAL_MONITOR=1280x720 tests/run-shell-tests.sh
```

**Why this exists:** an earlier round of this project's popup-menu
empty-submenu bug fix (see extension.js's comment on the
`this._separatorMenuItems` field, and `tests/shell-driver/extension.js`'s
section 3b/5b, for the full 3-round history) was verified only against a
single virtual-monitor resolution. During development that resolution was
bumped from `800x600` to `1600x1200` specifically because the bug stopped
reproducing at the larger size -- which turned out to be masking the
defect, not fixing it: a karen-gate review reproduced the same
empty-submenu collapse at `1280x720` (a genuinely common real display
height) even though `1366x768` passed cleanly. A single "comfortable"
resolution is not sufficient evidence a popup renders usably on real
hardware -- hence the committed matrix.

**Root cause of the round-3 collapse** (distinct from rounds 1-2's
nested-`St.ScrollView` structural bug): `PopupSubMenu` sizes itself as
`min(naturalHeight, availableSpace)`. GNOME Shell's top-level `PopupMenu`
has no scrolling of its own (only the individual
`_createScrollableMenuSection()`-wrapped sections -- active zones,
inactive zones, config switches -- scroll independently); when the
popup's total flattened content (switches + active/inactive zone lists +
however many top-level submenus) exceeds the real screen's available
height, GNOME Shell squeezes EVERY flexible (scrollable) child roughly
proportionally to fit, including sections that have nothing to do with
whichever submenu is open. On a short-enough real screen, that squeeze
collapses everything -- including a perfectly-flat, non-nested submenu --
to a few unusable pixels. This is a genuinely different mechanism from
rounds 1-2's ScrollView-in-ScrollView nesting bug, but produces the
identical user-visible symptom ("opens and shows nothing").

**Fix (round 3):** reduce what the popup menu holds, rather than trying
to make an ever-taller flat list fit an arbitrarily short real screen.
`extension.js` kept only the "Separator" submenu in the popup menu.
"Font size", "Color", and the three "Bold city"/"Bold time"/"Bold zone"
switches were removed from the popup entirely -- `prefs.js`'s "Defaults"
group (`_buildDefaultsGroup()`) already provides full, equivalent,
independently-tested controls for all five (plus per-zone overrides the
popup never had), writing to the exact same `formatting-defaults`
gsetting `extension.js` reads from and renders.

**Product decision (round 4):** the three "Bold city"/"Bold time"/"Bold
zone" switches were RESTORED to the popup menu -- a deliberate scope
decision, not a bug fix. They are plain `PopupSwitchMenuItem` rows with
no `St.ScrollView` of their own (unlike "Font size"/"Color", which were
`PopupSubMenuMenuItem`s -- see the round-1/round-2 nesting bug above),
so they never had the structural defect that motivated removing "Font
size"/"Color", and the user judged them "cheap, plain rows... the thing a
user is most likely to flip quickly without opening a preferences
window," while font size/color are "deliberate, occasional settings"
better served by `prefs.js`'s real spin control and colour picker.
`extension.js` writes `formatting-defaults` again (via
`_setFormattingDefaultField()`/`_saveFormattingDefaults()`, restored) for
exactly these three fields -- NOT the `config` a{sb} key -- alongside
`prefs.js`'s own direct writes for size/color/the same three bold flags.
"Font size" and "Color" remain out of the popup permanently.

**Measured practical minimum screen height, re-measured for round 4**
(the three restored bold switches are three more fixed-height rows,
changing the total layout budget): using a fixed `800px` width and
binary-searching the height with `TZSHELL_VIRTUAL_MONITOR`, both with the
default 2-zone active list and with ~10 active zones:

| Height (at 800px width) | Round 3 (no bold switches) | Round 4 (bold switches restored) |
|---|---|---|
| 515px | FAILS | FAILS |
| 520px | PASSES | FAILS |
| 600px, 650px | PASSES | FAILS |
| 651px | PASSES | FAILS |
| 652px | PASSES | **PASSES** |
| 655px, 665px, 680px, 700px | PASSES | PASSES |

**The floor rose meaningfully: from ~520px (round 3) to ~652px (round
4)** -- a rise of ~132px, which is exactly consistent with three restored
`PopupSwitchMenuItem` rows at their measured ~44px each (3 x 44 = 132).
This is the real number; it is reported here plainly rather than
smoothed over. It is still comfortably below every resolution in the
committed matrix: the shortest, `1280x720`, has 720px of nominal screen
height (before the top panel and window-manager margins are even
subtracted), a margin of roughly 68px over the measured 652px floor --
tight enough that `1280x720` is kept in the matrix specifically as the
early-warning entry closest to this floor. If a future change adds
meaningfully more fixed-height content to the popup, re-run this exact
binary search before assuming any resolution in the matrix still has
headroom -- do not just widen the matrix without re-measuring, and if a
future floor rises above a matrix entry, that is a STOP-and-report
condition (a bug this test would then be failing to catch), not a reason
to quietly bump the matrix past it.

### Text scaling narrows that margin further

The 68px margin is measured in raw pixels at the default text scale, and
that is not the only thing that consumes it. A karen gate re-ran the real
suite at `1280x720` with GNOME's `text-scaling-factor` injected into the
sandbox before shell launch:

| `text-scaling-factor` | Result at 1280x720 |
| --- | --- |
| 1.0 (default) | 42/42 PASSES |
| 1.25 (GNOME's built-in "Large Text" toggle) | 42/42 PASSES |
| 1.3 | 42/42 PASSES |
| 1.35 | **40/42 FAILS** -- Separator submenu collapses |
| 1.4 | **40/42 FAILS** -- same collapse |

So the shipped "Large Text" accessibility toggle is safe, but scaling
beyond ~1.3 at this resolution reproduces the original empty-submenu bug.
GNOME Tweaks and some accessibility sliders go well past that (up to
3.0), so a user CAN reach it without doing anything exotic. This is a
residual fragility of the layout, not a regression introduced by the fix
-- but it means the real margin is "68px at default scale", not "68px
unconditionally". Anyone re-measuring the floor should sweep text scaling
too, not just resolution.

## Running all three suites

```sh
tests/run-all.sh
```

Runs `run-tests.js`, then `run-prefs-tests.js` (with
`GSETTINGS_BACKEND=memory` set for the latter as defense-in-depth), then
`run-shell-tests.sh`, and exits non-zero if any of the three fails --
including a skipped prefs or shell suite (SKIP=FAIL, see above), unless
`TZPREFS_ALLOW_SKIP=1` and/or `TZSHELL_ALLOW_SKIP=1` are set in the
environment before invoking `run-all.sh` (both are normal environment
variables, so they are inherited by the child processes with no extra
plumbing in the script).

## Adding tests

For `run-tests.js`/`run-prefs-tests.js`: add new `test('name', () => {
... })` calls to the relevant suite, using
`assertEqual`/`assertTrue`/`assertFalse` for assertions. For
`tests/shell-driver/extension.js`: add new `record('name', () => { ...
})` / `await recordAsync('name', async () => { ... })` calls inside
`_runAll()`, using the same `assertEqual`/`assertTrue`/`assertFalse`
helpers defined at the top of that file. Never delete, skip, or weaken an
existing test to make a suite pass -- fix the implementation instead.

## Verification coverage (as of Phase 5)

This section records exactly which behaviors are proven by a committed,
re-runnable test versus a one-off manual/interactive check, so the
boundary travels with the code instead of living only in a session
transcript. It reflects a genuine attempt to close the gap via AT-SPI
automation (per this project's convention of AT-SPI-friendly widget
naming) inside an isolated `dbus-run-session` + `gnome-shell --headless
--virtual-monitor` sandbox -- what worked, what didn't, and why -- and,
for everything AT-SPI could not reach, a second attempt via a committed
GJS-level shell driver (`tests/shell-driver/`, run by
`tests/run-shell-tests.sh`) that drives the real extension directly
instead of through synthesized input. See that script's own section above
for how it works.

**Machine-verified, committed, re-run on every `run-all.sh`:**
- All pure escaping/sanitization/markup-assembly/precedence logic
  (`run-tests.js`), including real `Pango.parse_markup()` round-trips of
  hostile payloads (proving Pango treats them as inert text, not just
  that the assembled string looks escaped) and a full write-path ->
  GSettings -> read-path pipeline test.
- `hoverPopup.js`'s pure single-line, dates-only cell-model logic
  (`run-tests.js`): exact `_activeOrder` ordering for date cells (not
  membership-only, not alphabetical), a separator cell interleaved
  between every pair of date cells and never before the first/after the
  last, reflecting a reorder, `dateText` via the real
  `resolveDateFormat()`/`formatDateForDisplay()`, skipping stale/unknown
  zone ids (with no stray separator cell left behind), the empty/
  single-zone edge cases, the `separatorValue` default, and that
  `dateText` survives completely verbatim from `formatDateForDisplay()`
  (this module never escapes anything -- see its own module comment for
  why that is correct, not a gap). This module has no dependency on
  panel entry text at all (no times, no zone/city names) -- that
  information already lives in the panel itself.
- `prefs.js`'s real widget tree: construction, the exact `tzprefs-*`
  widget-name set, zero-write-on-open, per-zone override
  seeding/isolation/read-modify-write, "Clear override", and unknown/
  hostile `timezones` entries producing no expander row
  (`run-prefs-tests.js`). This drives real GObject properties directly
  (`spinRow.value = ...`, `switchRow.active = ...`,
  `clearButton.emit('clicked')`) in an offscreen `Gtk.init()`/
  `Adw.init()` process -- it does **not** go through the AT-SPI D-Bus
  protocol an external assistive/automation tool would actually use.
- The REAL `extension.js`, running inside a real (headless) `gnome-shell`
  process, driven directly by `tests/shell-driver/extension.js`
  (`run-shell-tests.sh`) -- see the dedicated list below for exactly what
  this covers.

### Shell-driver coverage (`tests/run-shell-tests.sh`)

Everything below is driven against `Main.extensionManager.lookup(uuid)
.stateObj` -- the REAL, currently-enabled `TimezonesExtension` instance --
inside a real headless `gnome-shell` process, not a reimplementation of
its logic. Every claim here was verified to genuinely discriminate by
temporarily breaking the corresponding real behavior in `extension.js`
(via `cp`/edit/`cp`-restore/`diff`, never `git checkout`/`stash`/`reset`)
and confirming the exact matching assertion -- and only that
assertion -- failed, then restoring the file and confirming a clean
`diff` and a clean re-run:
- `_reorderActiveZone()` made a no-op -> exactly the two DnD-order
  assertions failed (plus the shell's own `JS WARNING: unreachable code
  after return statement`, independently caught by this script's own
  shell-log scan).
- The `WallClock` signal disconnect skipped in `disable()` -> exactly the
  GObject-level leak-detection assertion and the 3-cycle re-enable/disable
  assertion failed; everything else, including the unrelated
  `_menuOpenStateId`/actor-nulling checks, still passed.

#### A karen gate found three "cannot fail" holes in an earlier version of this driver -- all fixed, and each fix independently proven

1. **Every "renders via markup without throwing" assertion trusted
   `ClutterText.set_markup()`'s own (silent) failure mode.** The gate
   reverted `escapeMarkup()` to a no-op in `extension.js` and reran the
   driver: all 32 assertions still passed, because `set_markup()` does
   NOT raise a JS-catchable exception on a Pango parse failure -- it fails
   silently (only a `Clutter-WARNING **: Failed to set the markup` on
   stderr) and extension.js's own `_lastMarkupFailureLogTime` (what those
   assertions inspected) was never set either. **Fixed**: every such
   assertion now uses `Pango.parse_markup()` itself, called directly by
   the driver (`pangoOracle()`/`panelMarkup()` in
   `tests/shell-driver/extension.js`), as an INDEPENDENT oracle on the
   real, reconstructed markup string -- the same technique `run-tests.js`
   already used -- asserting on recovered Pango attribute counts (0 for
   unconfigured/hostile-but-escaped input, an exact count for a known
   real formatting combination, non-zero for the popup-menu-driven
   formatting-defaults case) rather than trusting `extension.js`'s
   internal state.
2. **This was also a real product bug (not just a test bug), fixed in
   `extension.js` itself**: since `set_markup()` never throws on a parse
   failure, the pre-existing `try { set_markup() } catch` plain-text
   fallback in `_updateLabel()` was effectively dead code -- a markup
   failure would never trigger it, leaving the panel showing whatever
   `set_markup()` left behind. `_updateLabel()` now validates the
   assembled markup with `Pango.parse_markup()` itself (a new
   `_checkMarkupValid()` method) BEFORE ever calling `set_markup()`, and
   takes the plain-text fallback path when validation fails; the original
   `try/catch` around `set_markup()` remains as defense-in-depth only.
   Proven end-to-end by a dedicated driver test ("panel: an
   invalid-markup case ... genuinely engages the real plain-text
   fallback") that temporarily forces `_getMarkupForTimezone()` to return
   genuinely invalid markup (escaping makes this unreachable via any real
   input, so this is defense-in-depth for a "shouldn't happen" case) and
   confirms the panel falls back to real, readable plain text -- not
   empty, not raw markup syntax. (Verifying this test itself surfaced an
   unrelated, narrower fact worth recording: `St.Label`/`ClutterText`'s
   `.text = X` setter is a no-op regarding the `use-markup` flag
   specifically when `X` already equals the currently-cached text --
   confirmed with a standalone probe extension. The test forces a
   sentinel value first so its assertions can never be masked by that
   coincidence; this is a test-determinism fix, not a further product
   change.)
3. **The shell-log scanner was broken by construction.** The old scanner
   piped `grep -nE 'JS (ERROR|WARNING)'` through `grep -F "$SANDBOX"`, but
   GJS puts the failing file's path on the FOLLOWING stack-trace line, not
   the matched line itself -- so the sandbox-path filter discarded every
   real hit. The gate injected a genuinely uncaught JS error and the
   script still reported "32/32, none found, exit 0". **Fixed**: the
   sandbox-path filter is removed entirely (this sandbox's `shell.log`
   belongs to a throwaway `gnome-shell` process running nothing but this
   OS's bundled services plus the two extensions copied in -- there is no
   legitimate reason for ANY `JS ERROR`/`JS WARNING` line to appear in
   it), and a `Clutter-WARNING **: Failed to set the markup` line is now
   also treated as a hard failure (the actual OS-level signal of exactly
   the swallowed-parse-failure class of bug in finding 1). Proven three
   ways: injecting a genuinely uncaught JS error (driver still reports
   33/33 clean, but the run now correctly fails); injecting a real
   `Clutter-WARNING`/markup failure directly (same: 33/33 clean, run
   correctly fails); removing both and confirming a clean run again.
4. **Every run -- including a fully successful one -- orphaned a whole
   `gnome-shell --headless` + `dbus-daemon` process tree.**
   `cleanup()`'s `kill "$SHELL_PID"` only signalled the immediate
   backgrounded `dbus-run-session` job, which does not propagate to the
   `gnome-shell` process it execs into. Across ~16 runs this exhausted a
   real per-UID D-Bus connection limit and broke an unrelated legitimate
   re-run -- a sandbox escape in the sense that it consumed real,
   session-wide OS resources. **Fixed**: the whole chain now launches
   under `setsid` (its own process group), and `cleanup()` kills the
   ENTIRE group by negative PID (`kill -- -$SHELL_PID`), TERM then KILL,
   on every exit path. A second, related bug surfaced and was fixed while
   verifying this: the FUSE `xdg-desktop-portal` documents mount left
   under `$SANDBOX/run/doc` enters a "Transport endpoint is not
   connected" state once its backing process is killed, and bash's
   `[ -d ... ]` test returns FALSE for a disconnected FUSE mount --
   silently skipping the old guarded unmount attempt every time and
   leaking the sandbox directory forever despite a reported clean exit.
   The unmount is now attempted unconditionally (harmless no-op when
   nothing is mounted). Proven by running the fixed script 4+ times in a
   row and confirming via `ps`/`ls /tmp`/`mount` that zero
   `gnome-shell`/`dbus-daemon` processes and zero `/tmp/tzshell-*`
   directories or mounts remain after each run, and separately confirming
   both the timeout path (`TZSHELL_TIMEOUT_SECONDS=1` against a real
   launch) and the failure path (a real assertion failure via the same
   `_reorderActiveZone` mutation) also clean up completely.  Also
   reconfirmed after all of the above: `TZSHELL_ALLOW_SKIP=1` still only
   affects the "gnome-shell genuinely not installed" case (verified with
   a constructed `PATH` excluding `gnome-shell`/`dbus-run-session`/
   `setsid`) and has no effect on the timeout path or a real failure path
   (both still exit 1 with `TZSHELL_ALLOW_SKIP=1` set).

A further self-audit (prompted by the gate's finding that six vacuous
assertions had been found so far, and that "no leaked signals" is
trivially easy to assert vacuously) found and fixed three more:
- **"System clock visibility is restored after disable()"** used
  `!clockDisplay || clockDisplay.visible === true`, which passes
  VACUOUSLY if `clockDisplay` is ever falsy -- and, separately, nothing
  in the driver ever actually hid the clock first, so the assertion
  passed only because the clock was already visible the whole time,
  never exercising `disable()`'s restore branch at all. Fixed by adding a
  dedicated test that drives the real "Hide system clock" config switch
  first (confirming the real clock display actually becomes hidden and
  `_hidSystemClock` becomes true), removing the `!clockDisplay ||`
  shortcut, and requiring `clockDisplay` to genuinely exist (confirmed
  empirically via a standalone probe that it does, in this environment).
- **`_acceptActiveDrop`'s test** only checked `accepted === true` and
  that `_activeOrder.length` was unchanged -- but `_reorderActiveZone`
  removes-then-reinserts a single element, so length is unchanged whether
  or not a reorder actually happened. A no-op `_acceptActiveDrop` that
  did nothing but `return true` would have passed the old test. Fixed by
  wrapping the REAL `_reorderActiveZone` with a spy that records its call
  arguments and then calls straight through to the original (never
  replacing its logic), proving `_acceptActiveDrop` genuinely resolved
  the correct dragged zone id and genuinely invoked the real reorder
  method with it.
- **`_handleActiveDragOver`'s test** only checked its return value
  (`MOVE_DROP`) -- but per `extension.js`'s own comment, this method
  "Always returns MOVE_DROP", so almost any implementation, even a
  near-total no-op, would still pass a return-value-only check. Fixed by
  additionally verifying the real side effect: `_showDropIndicatorAt()`
  actually inserting the real drop-indicator actor into the real active
  menu box.
- Also strengthened without a specific prior failure: a baseline
  assertion (button parented + status-area entry present, right after
  `enable()`) now precedes the teardown section's "unparented"/"status
  area entry removed" checks, so those could never have passed vacuously
  against a button that was never parented/registered in the first
  place.

#### A later karen round found a fifth hole -- in the very test written to close the fourth

The throttle-suppression test added for finding 3's follow-up (proving a
SECOND markup failure inside the 300s window is actually suppressed)
asserted `assertEqual(inst._lastMarkupFailureLogTime, t1)` after failure
#2. That is **timing-dependent**, for the same whole-second-granularity
reason the "re-arm" assertion below it already documented and worked
around: `GLib.DateTime...to_unix()` has one-second resolution, so if the
throttle guard were deleted outright, failure #2's reassignment would
produce the SAME integer as `t1` whenever both calls land inside one
wall-clock second -- and the assertion would pass regardless of whether
suppression happened.

Worth recording precisely, because "cannot fail" is not quite the right
diagnosis: deleting the entire guard from `_logMarkupFailureThrottled()`
produced three consecutive vacuous passes in one review, and a correct
failure on the first attempt in another. The assertion caught the
regression only when a second boundary happened to fall between the two
calls. A flaky discriminator is arguably worse than an absent one -- it
reads as proof and is not.

**Fixed**: failure #2 is now preceded by overwriting
`_lastMarkupFailureLogTime` with a sentinel (`t1 - 60`) that is (a) still
inside the 300s window, so a working guard must suppress and leave it
untouched, and (b) 60 seconds in the past, so a forward-moving real clock
can never reassign that exact value. The result no longer depends on when
in the second the test runs.

**Proven**: with the entire throttle guard block deleted from
`_logMarkupFailureThrottled()`, the shell suite now fails on exactly this
assertion (34/35) on **three consecutive runs** -- where the old
assertion's behavior varied run to run. Guard restored via `cp`, `diff`
verified byte-identical, clean re-run at 35/35.

Known residual, stated rather than glossed: `t1 - 60` is
coincidence-RESISTANT, not coincidence-PROOF. A broken guard's
freshly-assigned `now` could still equal it if the system wall clock
stepped BACKWARD by ~60 seconds in the sub-second window between
capturing `t1` and the next call -- an NTP step correction, a VM/container
clock renormalization, or a manual adjustment landing exactly there. DST
shifts (±1h) and leap seconds (±1s) cannot produce it, and suspend/resume
normally corrects forward via the RTC, so this needs an unusual and
specific clock event rather than an ordinary one. Making it strictly
impossible would mean injecting a fake `GLib.DateTime` for the test's
duration; `GLib.get_monotonic_time()` is not an option here because the
code under test deliberately uses wall-clock time for log-timestamp
correctness, so the test has to mirror that clock source. Judged low
severity and left as-is -- but it is a residual risk, not a proof.

Generalized lesson applied to the rest of this phase: any assertion
comparing two values both derived from a real wall clock within a single
test is suspect for this reason. The absence of a written discrimination
proof for this one test -- while every other assertion in this section
had one -- turned out to correlate exactly with the absence of a real
proof. Treat "I can't write down how I proved this discriminates" as
evidence that it probably doesn't.

Covered:
- **`enable()`/panel rendering**: the button/label actors exist and are
  parented/registered (with a genuine `enable()`-time baseline for the
  teardown checks below); the default single-active-zone panel text
  matches the expected 24h shape; the default (unconfigured) render and a
  render with a real per-zone formatting override (written through the
  real `formatting` GSettings key, reloaded via the real
  `_loadSettings()`) both produce valid Pango markup with the expected
  recovered attribute counts (0 for the unconfigured case; exactly 3 --
  size, foreground, bold weight -- for the configured case), verified via
  the driver's own independent `Pango.parse_markup()` oracle, not by
  trusting `extension.js`'s internal `use_markup`/`_lastMarkupFailureLogTime`
  state alone (those are still checked too, as corroborating signals).
  Also covered: a dedicated, genuinely-invalid-markup case proving the
  real plain-text fallback engages and renders readable text (see finding
  1/1b above).
- **Popup menu separator picker**: emitting the real `'activate'` signal
  on the real curated-separator row (not calling `_selectSeparator()`
  directly -- this proves the row's own signal wiring) writes the
  `separator` GSettings key and the panel re-joins with that literal
  value. Also covered (see "Popup menu: submenus actually render" below):
  opening the REAL top-level popup and the REAL "Separator" submenu with
  real `BoxPointer` positioning, proving it is genuinely mapped and
  allocated on-screen space, not just present in the object graph, at
  every resolution in the committed matrix and with both a default and a
  ~10-zone active list.
- **Formatting defaults -- font size, color (popup-menu-side, round 3) /
  font size, color, 3 bold switches (round 4 for the bold switches)**:
  "Font size" and "Color" were REMOVED from the popup menu permanently
  (karen-gate round 3 -- see "Minimum supported screen height" below and
  the extension.js comment on the `this._separatorMenuItems` field for
  the full history) and now live exclusively in `prefs.js`'s "Defaults"
  group, covered by `run-prefs-tests.js`'s own real-GTK4/Adw widget suite.
  This driver covers extension.js's remaining responsibility for those
  two fields -- reading and rendering a `formatting-defaults` write made
  the same way `prefs.js` makes it (`serializeFormatting()` into the
  gsettings key directly) -- by writing that key directly (font size,
  then color, separately) and asserting `_loadSettings()`/
  `this._formattingDefaults` picks each one up. The three bold switches
  were RESTORED to the popup in round 4 (a product decision, not a bug
  fix -- see "Resolution matrix..." below) and are covered as real popup
  rows again: emitting the real `PopupSwitchMenuItem.toggle()` on all
  three writes `formatting-defaults` (NOT the `config` a{sb} key,
  explicitly checked), and a real external `formatting-defaults` gsettings
  write (simulating a real `prefs.js` write from a separate process) is
  proven to flow through the real `'changed'` handler,
  `_loadSettings()`/`_syncConfigSwitches()`, and the existing reentrancy
  guard, all the way to the real switch's own visual `.state` flipping
  (polled, not assumed synchronous). The panel is also asserted to
  re-render as valid markup with non-zero recovered Pango attributes
  after all of the above (independent oracle).
- **Popup menu: submenus actually render, not just exist**: opening the
  real top-level popup (real `BoxPointer.open()`) and the real
  "Separator" submenu, then asserting the submenu's own actor/box are
  `mapped === true` with a real, non-collapsed on-screen height (not an
  exact height -- see the "Minimum supported screen height" section below
  for why that would be the wrong assertion), and that its first row is
  genuinely within that allocated viewport. Run twice per resolution:
  once with the default (2-zone) active list, once after populating ~10
  active zones (the scrollable-list-competing-for-space scenario the
  karen gate specifically reproduced against). A known-good, pre-existing
  config switch is checked the same way as a calibration control, proving
  the measurement technique itself produces a real positive reading.
- **Drag-and-drop**: the real `_computeInsertionIndex()`,
  `_reorderActiveZone()` (order + persistence to the `timezones` key),
  `_getDragSourceZone()` (both source shapes), `_handleActiveDragOver()`
  (return value AND the real drop-indicator side effect), and
  `_acceptActiveDrop()` (spy-wrapped call-argument proof plus a full
  simulated drop from a drag-handle-shaped source object) are all driven
  directly, plus the "each zone id appears at most once" invariant.
  **This covers the reorder LOGIC and its persistence, not real
  pointer-driven dragging** -- synthesizing actual pointer motion/button
  events was judged infeasible here for the same reason AT-SPI's own
  attempts above failed (no working synthetic input path in this
  headless Wayland/mutter build).
- **Inline rename**: commit is driven via the real `_setLabel()` method
  (both a normal label and one containing markup metacharacters). The
  hostile-label case is proven via Pango's OWN recovered plain text
  (`Pango.parse_markup()`'s 3rd return value) containing the hostile
  string back out VERBATIM as inert text content -- the same
  "recovers as literal inert text" technique `run-tests.js` uses,
  independent of whatever bold/size/color formatting-defaults happen to
  be active at that point in the run. Cancel is driven via a **real,
  argument-free `key-focus-out` GObject signal emission** on the real
  live row's real `St.Entry` -- genuinely invoking the real
  `cancelEdit()` closure with no synthesized input needed at all (that
  handler ignores its signal parameters). **Committing via a synthesized
  `Return` keypress was not attempted** -- it would require constructing
  a raw `Clutter.Event` outside the shell's own input pipeline, judged
  too likely to crash/hang this headless Clutter/Mutter build for a test
  driver; `_setLabel()` is real, production code either way, just invoked
  directly rather than via a synthesized key event.
- **`disable()`/lock-screen teardown**: `g_signal_handler_is_connected()`
  (a real GObject-level check, not just "the JS bookkeeping field is
  null") proves the `WallClock` `notify::clock` handler and the
  `GSettings` `changed` handler are actually disconnected after
  `disable()`; every enable()-assigned instance field is confirmed null;
  the panel's status-area entry no longer references the destroyed
  button; the destroyed button actor is unparented; system clock
  visibility is restored (after this run genuinely hid it first -- see
  above); and three further enable/disable cycles repeat all of the
  above cleanly with no accumulating leaks. (The menu's own
  `open-state-changed` handler is Signals-mixin-based, not a real
  GObject signal in this GNOME Shell version -- confirmed empirically,
  see the comment in `tests/shell-driver/extension.js` -- so its teardown
  is verified at the JS-bookkeeping level plus the source fact that
  `disable()` unconditionally disconnects it before nulling it, rather
  than via `g_signal_handler_is_connected()`.)
- **Hover popup ("Show dates on hover")**: a single line of DATES ONLY --
  no time, no zone/city name/text (that information already lives in the
  panel itself, "the normal display of the times") -- with the panel's
  own resolved separator interleaved between every pair of zones, in
  `_activeOrder` order, e.g.:
  ```
  20/07/2026 | 20/07/2026 | 21/07/2026
  ```
  The pure cell-selection-and-ordering logic
  (`hoverPopup.js`'s `buildHoverPopupCells()`) is covered independently
  by `run-tests.js` (see below); this shell driver covers everything that
  logic alone cannot -- the real actor/signal/timer plumbing AND the real
  layout allocation in `extension.js`:
  - **Content and exact order, dates only**: with the toggle ON,
    `_showHoverPopup()` builds one plain-text date label per zone in
    `_activeOrder`, in that EXACT order (asserted by index, not just
    membership), plus one separator label between every adjacent pair --
    never before the first or after the last. Each date label is asserted
    ISO-shaped and cross-checked byte-for-byte against the real
    `date-format` gsetting/`resolveDateFormat()`/`formatDateForDisplay()`
    machinery for that zone's "right now". Each separator label is
    asserted equal to the real, currently-resolved
    `_resolveSeparatorValue()`. The design-critical negative assertion:
    neither active zone's real panel-style entry text
    (`inst._getLabelForTimezone({ item })`) nor any city name appears
    anywhere in the popup's combined text -- proving times/names never
    leak into what is now a dates-only surface. A real
    `_reorderActiveZone()` call is proven to change the label order on
    the NEXT show, then the order is restored for the DnD section that
    follows.
  - **Plain-text-only, never markup, and a hostile custom label does not
    leak in at all**: a hostile per-zone custom label
    (`<b>evil</b> & "quotes"`) is set on an active zone and the popup is
    shown -- since the popup no longer renders any per-zone label/entry
    text at all (dates only), the hostile string is asserted absent from
    the popup entirely, and `clutter_text.get_use_markup()` is confirmed
    `false` for every label in the popup, proving this popup never
    touches the markup surface at all (see `hoverPopup.js`'s own module
    comment for why that is a deliberate design choice, not an
    oversight).
  - **Lazy by design -- inert when disabled (karen-gate finding)**: with
    the toggle off (the schema default), this extension must add
    *nothing* to `Main.layoutManager.uiGroup` and connect *nothing* to
    `this._button` -- byte-identical to a build with no hover-popup
    feature at all. This is now an asserted property, not an assumption:
    `enable()` with the toggle untouched leaves `_hoverPopup`/
    `_hoverPopupBox`/`_hoverSignalId`/`_hoverShowTimeoutId` all `null`,
    `Main.layoutManager.uiGroup`'s child COUNT unchanged from a baseline
    captured right before this section (not just a falsy-field check --
    a leaked *other* actor would not be caught by that), and no actor
    anywhere in `uiGroup` carries this feature's own `accessible_name`.
    Calling the real show path (`_showHoverPopup()`) with the toggle off
    is a harmless no-op (no actor is created as a side effect, confirmed
    not to throw). Toggling the real switch ON is proven to lazily
    CREATE the popup actor (a real child of `uiGroup`) and connect
    `notify::hover` (`g_signal_handler_is_connected()`, not just a
    JS-field check); toggling it back OFF is proven to lazily DESTROY the
    same actor and disconnect the same real signal id -- with
    `g_signal_handler_is_connected()` confirming the disconnection and a
    `uiGroup` membership check confirming the actor is gone, not just
    that the JS fields were reassigned. Toggling ON/OFF/ON/OFF/ON five
    times in a row is confirmed to create a genuinely FRESH actor and
    signal id every time (never reusing/resurrecting a destroyed one) and
    to leave `uiGroup`'s child count back at its pre-cycle value after
    every OFF. An EXTERNAL settings change -- a direct `GSettings` write
    simulating `dconf`/another instance of this same extension, not the
    menu switch -- is proven to drive the exact same lazy create/destroy
    through the `changed` handler. Finally, `disable()` after a session
    that never touches the toggle at all (the popup genuinely never
    created) is confirmed to run cleanly with no errors and no change to
    `uiGroup`'s child count -- `_teardownHoverPopup()` (the single
    teardown implementation both `disable()` and the lazy toggle-off path
    share) is a true no-op when there is nothing to tear down.
  - **Rendering, not just object graph or model**: after a real show, the
    popup actor and every date/separator label are confirmed
    `mapped === true` with a real, finite, positive `get_allocation_box()`
    -- the same class of check that catches the "empty submenu"/
    NaN-allocation bug class this project has hit before (see the
    karen-gate history on `this._separatorMenuItems` in `extension.js`).
    Successive labels are asserted not to overlap horizontally (a real
    left-to-right single row). Per-zone pixel alignment against the
    panel is deliberately NOT attempted or asserted here -- the panel is
    a single combined label, not one label per zone, so there is no
    stable per-zone target to align a date under; see this feature's own
    design note (flagged for the user) for why a single clean row of
    dates, in the same order and with the same separator the panel uses,
    is the target instead.
  - **Suppression, both directions**: with the real main menu open,
    `_showHoverPopup()` does not display the popup; opening the real main
    menu WHILE the hover popup is showing hides it (via the real,
    extended `open-state-changed` handler).
  - **Timer discipline**: scheduling then cancelling removes the pending
    `GLib.timeout_add()` source, verified via
    `GLib.MainContext.default().find_source_by_id()` -- a real GLib-level
    proof, not just a nulled JS field (the same standard
    `g_signal_handler_is_connected()` sets for signals elsewhere in this
    driver); a cancelled timer is confirmed to never show the popup even
    after the real delay elapses; a timer genuinely PENDING at the exact
    moment `disable()` runs is confirmed gone afterward, and the same is
    re-checked across three further enable/disable cycles with no
    accumulation.
  - **The real `notify::hover` GObject signal, end to end**: setting
    `this._button.hover = true` (a real GObject property write -- what
    `track_hover` would flip on a genuine pointer enter) is proven to
    schedule the real timer and, after the real
    `HOVER_POPUP_SHOW_DELAY_MS` delay elapses, show the real popup;
    setting it back to `false` is proven to cancel any pending timer and
    hide the popup.
  - **Teardown**: the panel button's `notify::hover` handler is confirmed
    connected before `disable()` (a real, positive `g_signal_handler_is_
    connected()` reading on the still-live button); every hover-related
    field (`_hoverPopup`, `_hoverPopupBox`, `_hoverShowTimeoutId`,
    `_hoverSignalId`) is confirmed nulled after `disable()`; the hover
    popup actor is confirmed no longer a child of
    `Main.layoutManager.uiGroup` (a reference-identity check against a
    snapshot taken while it was still live -- never a method call on the
    destroyed actor itself, see the karen-gate fix below). Deliberately
    NOT verified via a post-`disable()`
    `GObject.signal_handler_is_connected()` call on the button itself --
    see the karen-gate fix note immediately below for why.

  **KAREN-GATE FIX**: an earlier version of this section's teardown
  check DID call `GObject.signal_handler_is_connected()` on the button
  AFTER `disable()`, and produced a real `Gjs-CRITICAL **: Object
  .Gjs_ui_panelMenu_PanelMenuButton ... has been already disposed --
  impossible to access it` on every run, caught by the generalized
  shell-log scanner (finding 3 below) rather than by the assertion
  itself, which "passed" by returning a falsy read off a disposed
  object -- not a real proof of anything. Unlike `this._systemClock`/
  `this._settings` (never destroyed, only disconnected-from),
  `this._button` IS genuinely destroyed by `disable()` itself, so this is
  the exact same disposed-object-access class of bug a previous karen
  gate already found and fixed once in this file's pre-existing
  "unparented" teardown test (which reads a STABLE ANCESTOR's child count
  instead of touching the destroyed button, see that test's own comment).
  **Fixed** the same way: the post-`disable()` check on the button was
  removed, and the guarantee is instead verified via (1) a PRE-disable
  `g_signal_handler_is_connected()` reading (proves the signal genuinely
  WAS connected on the live object, not a vacuous "never connected"
  pass), (2) the nulled-field check, and (3) the source-level fact that
  `disable()` unconditionally calls `this._button.disconnect(this._
  hoverSignalId)` before `this._button.destroy()` -- the same boundary
  this file already used for `_labelStyleChangedId` (connected to the
  equally-destroyed `this._label`). Proven to genuinely discriminate: the
  disposed-object read is gone from every run (confirmed via a clean
  shell-log scan across all four resolutions), and the pre-disable
  connectedness check still fails loudly if the signal is ever connected
  too late or not at all.

  **Remains manual-only, same boundary as pointer-driven DnD below**: a
  real physical mouse cursor entering the panel button and genuinely
  triggering `track_hover`/`notify::hover` cannot be synthesized
  headlessly in this environment (no working synthetic pointer-motion
  path -- see the AT-SPI investigation above). Every driven test in this
  section instead sets the real `this._button.hover` GObject property
  directly (or calls `_showHoverPopup()`/`_scheduleHoverPopupShow()`
  directly for more targeted checks) to exercise the same real, connected
  signal handler end to end -- real code, real signal emission, real
  timer, real actor, just not triggered by a real cursor movement.
  "Hovering with an actual mouse triggers this popup" is therefore
  unverified by any committed test, exactly like real pointer-driven
  drag-and-drop below.
- The whole run's shell log is scanned for `JS ERROR`/`JS WARNING`/
  `Clutter-WARNING` markup-failure lines anywhere in it (no path-based
  attribution filter -- see finding 3 above for why); any hit fails the
  run.
- The sandbox's whole process tree (dbus-run-session/dbus-daemon/
  gnome-shell and everything it spawns) and its FUSE documents mount are
  confirmed torn down after every run, including the timeout and failure
  paths (see finding 4 above).

Not covered by the shell driver (same boundary as the AT-SPI attempt
below for the reasons given there): real pointer-driven drag-and-drop,
a real synthesized-keyboard rename commit, and pixel-level/exact
Pango-attribute-VALUE rendering verification. Recovered Pango attribute
COUNTS are now verified (see above); the specific per-attribute typed
VALUES (e.g. the exact recovered color/weight/size numbers) are not:
`Pango.AttrList.get_attributes()` was tried from plain `gjs` during this
work and returns generic, un-downcast `Pango.Attribute` boxed wrappers
whose type-specific fields -- color/size/weight -- are not accessible
through this GJS/Pango typelib without a working boxed-union downcast;
this is the same class of gap as the pre-existing Looking Glass `Eval`
unavailability below, not something this driver could additionally
close.

**Covered only by an interactive headless-sandbox smoke test (not
committed, not re-run automatically):**
- The real extension reaching `State: ACTIVE` inside `gnome-shell
  --headless --virtual-monitor` after `gnome-extensions enable`, staying
  `ACTIVE` through a settings-write churn (including a hostile per-zone
  label), and cleanly surviving disable -> re-enable, with zero
  `error`/`critical`/`warning`/`exception` lines in the shell's own log.
- AT-SPI **tree discovery** against prefs.js's real, live window
  (launched as a genuine GTK4/Adw Wayland client inside the nested
  compositor, not via `gnome-extensions prefs` -- see below): the
  window's accessible tree, with correct accessible labels/roles,
  reachable via the real AT-SPI D-Bus protocol -- `Separator` (combo
  box), `Color` (list item), `Bold city`/`Bold time`/`Bold zone` (check
  boxes), and `Formatting for UTC` / `Formatting for America/Los_Angeles`
  (list items, one per configured zone) were all found this way. This is
  stronger evidence than the offscreen suite above for "the accessible
  labels this project's automation convention promises are genuinely
  exported," but it stops at discovery.

**AT-SPI-driven interaction (value changes) -- attempted, not achieved
in this environment; genuinely blocked, not skipped:**

Every widget probed (`Formatting for America/Los_Angeles` ExpanderRow,
`Bold city` check box, `Separator` combo box) reported an **empty AT-SPI
Action interface** (`get_n_actions() == 0`) in this environment's
GTK4/libadwaita build. Three independent drive mechanisms were tried
and all failed to change any widget's state:
1. Invoking AT-SPI `Action` interface entries -- none existed to invoke.
2. `Atspi.Component.grab_focus()` followed by synthetic
   `Atspi.generate_keyboard_event()` (Return, then space) -- focus
   itself failed (`atspi_error: (1)`), and neither key event changed
   anything.
3. `Atspi.generate_mouse_event()` at the target widget's own reported
   screen extents -- no change.

This points to the headless/Wayland sandbox lacking a working synthetic
input path (no XTest under Wayland; no wlr-virtual-pointer/keyboard
protocol wired up for AT-SPI's benefit in this `mutter --headless`
configuration) combined with this GTK4/libadwaita build not populating
the `Action` interface as a headless-friendly fallback for these row
types. Separately observed, and *not yet root-caused*: the global
`Font size` `Adw.SpinRow` did not appear in the AT-SPI tree at all
(under any name), while the `Color`/`Bold *`/`Separator` rows next to it
in the same group did -- worth investigating if AT-SPI automation of
this window is revisited, but out of scope to chase further here since
it may be an artifact of this specific sandbox/libadwaita version rather
than a defect in `prefs.js`.

`gnome-extensions prefs <uuid>` (the standard end-user launch path) was
tried first and could not be used at all: it returns immediately without
ever spawning a visible window process, because the separately-packaged
`gnome-extensions-app` binary is not installed on this machine (`which
gnome-extensions-app` finds nothing, system-wide, not just inside the
sandbox). The live-window AT-SPI attempts above instead launched
`prefs.js`'s real, unmodified `TimezonesPrefs.fillPreferencesWindow()`
directly as a small GJS/GTK4 harness connected to the nested compositor
as a genuine Wayland client -- same production code, different launch
path.

**Closed by the shell driver (`tests/run-shell-tests.sh`), see the
dedicated coverage list above -- no longer manual-only:**
- Drag-and-drop reorder LOGIC (not real pointer-driven dragging) and its
  persistence.
- Inline rename commit (via the real `_setLabel()`) and cancel (via a
  real `key-focus-out` signal emission).
- The popup menu's own separator/formatting-default controls
  specifically, driven via real signal emission on the real rows/switches
  (previously only prefs.js's equivalent `Defaults` group had been
  reached, via AT-SPI discovery, below).
- `disable()`/lock-screen teardown signal-leak behavior specifically, via
  `g_signal_handler_is_connected()` -- a real GObject-level check, not
  just JS-bookkeeping-field-is-null -- across the initial disable and
  three further enable/disable cycles.

**Remain manual-only (not exercised by any committed test):**
- A real physical mouse cursor entering the panel button and genuinely
  triggering the hover popup via `track_hover`/`notify::hover` (as
  opposed to setting the real `this._button.hover` GObject property
  directly, or calling `_showHoverPopup()`/`_scheduleHoverPopupShow()`
  directly, both of which drive the same real, connected production code
  and are committed and machine-verified -- see the "Hover popup" bullet
  above).
- Real pointer-driven drag-and-drop (as opposed to the reorder logic
  above, which is committed and machine-verified).
- A real synthesized-keyboard (`Return` keypress) inline-rename commit
  (as opposed to committing via the real `_setLabel()` method directly,
  which is committed and machine-verified).
- Live, on-screen (pixel-level) confirmation of panel/menu rendering, and
  exact Pango-attribute-level (color/size/weight) verification of applied
  markup -- Looking Glass `Eval` is disabled without unsafe mode in every
  sandbox run so far (`(false, '')`), and `Pango.AttrList
  .get_attributes()` does not expose type-specific attribute fields
  through this GJS/Pango typelib (see the shell-driver coverage list
  above) -- so rendered markup/attribute output has never been visually
  or attribute-level confirmed, only proven correct at the
  string/`Pango.parse_markup()` level (`run-tests.js`) plus "Clutter/Pango
  accepted this real markup without throwing or falling back, in a real
  shell process" (`run-shell-tests.sh`).

## Unreproduced flake: "three further enable/disable cycles" (2026-07-20)

During a full four-resolution matrix sweep of the hover-popup feature,
the shell-driver assertion **"teardown: three further enable/disable
cycles stay clean and reusable, with no accumulating signal leaks"**
(`tests/shell-driver/extension.js`) failed **exactly once**. The failure
was never captured in detail (no shell-log snapshot was retained from
that run), so neither the specific sub-assertion inside the loop nor the
exact error text is recorded here -- only that this was the test that
failed, and that it did not recur.

**Measurement, not a guess:** the same assertion, and the same full
matrix sweep, were re-run 78 further times chasing a reproduction:
- 40 standalone runs at 1024x768: 0 failures.
- 26 standalone runs at 1280x720: 0 failures.
- 3 consecutive full four-resolution matrix sweeps (12 launches total --
  the exact condition it originally failed under): 0 failures.

Total: 78 runs, 0 reproductions. The cause was never identified. This is
recorded as a known unknown, not a fixed bug -- if this exact assertion
ever fails again, that is not necessarily a new regression; check this
note first.

**What was done about it anyway:** the most plausible mechanism --
`disable()` landing at an unlucky moment in the hover-popup lifecycle
(mid-show-schedule, mid-show, mid-hide) and leaving a `GLib` timeout or a
`notify::hover` connection live -- was audited directly against
`extension.js`'s `disable()`. The teardown was found to **already be
safe by construction**: GJS/Clutter run a single-threaded main loop, so
`disable()` (itself always synchronous, no `await` anywhere inside it)
can never truly interleave with a `GLib` timeout callback or a
`notify::hover` handler's own execution -- only ever run strictly before
or after one. `disable()` cancels the pending show-timer
(`GLib.Source.remove()`, only ever reached before the callback's own
dispatch) and disconnects `notify::hover` before destroying anything, so
neither can fire once teardown has begun; and `_showHoverPopup()`/
`_onButtonHoverChanged()` independently null-check every field they
touch, so even a hypothetical future refactor that broke that ordering
would degrade to a safe no-op rather than a crash. No code in
`extension.js` was changed as a result of this audit -- there was no
genuine defect to fix in the teardown ordering itself.

The three awkward interleavings (disable() with a show-timer pending,
disable() while the popup is genuinely showing, disable() shortly after
a hide) are now covered by dedicated shell-driver tests ("hover teardown
interleaving A/B/C", plus a fourth proving the timeout-callback body and
the `notify::hover` handler are harmless if invoked directly right after
`disable()`) -- precautionary hardening of the test suite, not a fix for
a diagnosed cause, since no cause was ever diagnosed.

**One real, unrelated thing this investigation did find and root-cause,
recorded here for anyone who greps this file after seeing a similar
`Gjs-CRITICAL` line:** destroying a real `BoxPointer` in the *exact same*
synchronous JS turn as its own `open()` call -- i.e. zero mainloop turns
elapsed -- can produce a genuine `Gjs-CRITICAL: Object
.Gjs_ui_boxpointer_BoxPointer ..., has been already disposed` from GNOME
Shell's own `Main.layoutManager` machinery (a `Meta.later_add()`-scheduled
callback queued for the next frame). This was root-caused by matching
the disposed object's address, hex-for-hex, against a debug probe logging
`this._hoverPopup`'s own address at creation and destruction, and
confirmed to reproduce identically against a completely **unmodified**
`extension.js` (plain `this._hoverPopup.destroy()`, no changes at all) --
proving it is a GNOME-Shell-internal, same-tick scheduling artifact, not
a defect in this extension's teardown. It is also not reachable by any
real `disable()`: GNOME Shell's `ExtensionManager` only ever invokes
`disable()` in response to an external event (a D-Bus call, a keybinding,
session lock) -- inherently a separate mainloop turn from whatever caused
the popup to be showing, so at least one real turn has always already
elapsed by the time a genuine `disable()` runs. The "interleaving B/C"
tests mentioned above use a short, explicitly-commented settle for
exactly this reason, reproducing the minimum realistic gap rather than an
unreachable same-tick race.
