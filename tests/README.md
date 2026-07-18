# Tests

Three suites: two plain-GJS assertion suites, plus a shell-level driver
that runs a real gnome-shell process. No test framework, no npm.

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
   (`extension.js`, `formatting.js`, `formattingPresets.js`,
   `separators.js`, `timezones.js`, `cityAliases.js`, `metadata.json`,
   `schemas/`) into the sandbox's extensions directory verbatim -- never
   edited, never reimplemented -- and recompiles its schema there.
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
(separator submenu rows, font-size/color preset rows, the three bold
`PopupSwitchMenuItem`s, the real `_reorderActiveZone`/
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
  value.
- **Popup menu formatting defaults**: emitting `'activate'` on real
  font-size/color preset rows and calling the real `PopupSwitchMenuItem
  .toggle()` on all three bold switches all write the correct
  `formatting-defaults` fields, and the panel re-renders as valid markup
  with non-zero recovered Pango attributes afterward (independent
  oracle).
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
