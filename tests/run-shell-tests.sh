#!/usr/bin/env bash
# tests/run-shell-tests.sh
#
# GJS-level shell driver runner (Phase 5). Closes the "nested-shell
# confirmation" gap the pure-function suite (run-tests.js) and the real
# GTK4/Adw prefs.js suite (run-prefs-tests.js) cannot reach: panel
# rendering, the popup menu's separator/formatting-default controls,
# drag-and-drop reorder LOGIC, inline rename commit/cancel, and
# disable()/lock-screen teardown signal-leak behavior, all driven against
# the REAL, unmodified extension.js running inside a REAL (headless)
# gnome-shell process -- see tests/shell-driver/extension.js for exactly
# how and why, and tests/README.md's "Verification coverage" section for
# what this still cannot reach (pointer-driven DnD, synthesized keyboard
# commit of an inline rename, pixel-level rendering).
#
# Project rule: SKIP=FAIL. This script exits non-zero on ANY of: a real
# assertion failure, the result file never appearing (timeout), the shell
# process dying before producing one, a JS ERROR/JS WARNING/unhandled
# exception anywhere in the shell's own log, or a `Clutter-WARNING
# **: Failed to set the markup` line (the actual observable signal of a
# silently-swallowed Pango markup parse failure -- see the karen-gate
# finding recorded in tests/shell-driver/extension.js's module comment).
# The ONLY condition that can downgrade to exit 0 is "gnome-shell itself is
# not installed in this environment at all" -- and only when
# TZSHELL_ALLOW_SKIP=1 is explicitly set (mirrors TZPREFS_ALLOW_SKIP for
# tests/run-prefs-tests.js). Every other failure mode above is a REAL
# failure and TZSHELL_ALLOW_SKIP=1 does not affect it.
#
# LIVE-SESSION SAFETY: everything below runs inside its own
# `dbus-run-session`, with HOME/XDG_DATA_HOME/XDG_CONFIG_HOME/
# XDG_CACHE_HOME/XDG_RUNTIME_DIR all pointed at a throwaway sandbox
# directory created fresh by this script and deleted on exit. Nothing here
# ever touches the invoking user's real ~/.local/share/gnome-shell/extensions,
# their real dconf database, or the ambient (already-running) session bus.
# The target extension is COPIED into the sandbox verbatim -- the real
# repo tree is never written to.
#
# PROCESS-GROUP SAFETY (karen-gate finding 3): the whole
# dbus-run-session/gnome-shell/dbus-daemon chain is launched under `setsid`
# so it becomes its own process group, and cleanup() kills that ENTIRE
# group by PID number (`kill -- -$SHELL_PID`), not just the single
# backgrounded job. A plain `kill "$SHELL_PID"` only signals the immediate
# child (dbus-run-session's wrapper) -- it does NOT propagate to the
# gnome-shell process dbus-run-session execs into, or to dbus-daemon,
# orphaning a full process tree on every run (confirmed: across ~16 runs
# this exhausted the invoking user's per-UID D-Bus connection limit and
# broke a legitimate unrelated re-run). See the bottom of this file for the
# repeated-run/timeout/failure verification this fix was proven against.

set -u

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
REPO_ROOT="$(pwd)"

TARGET_UUID="inquiries@itwerx.net"
DRIVER_UUID="shell-driver@tests.local"

# --- Environment/skip check: gnome-shell genuinely not installed ---
if ! command -v gnome-shell >/dev/null 2>&1 || ! command -v dbus-run-session >/dev/null 2>&1 || ! command -v setsid >/dev/null 2>&1; then
  echo "=============================================================="
  echo "SKIPPED: tests/run-shell-tests.sh DID NOT RUN"
  echo "gnome-shell, dbus-run-session, and/or setsid is not installed in"
  echo "this environment, so the nested-shell driver cannot be launched at"
  echo "all (or cannot be launched with a killable process group)."
  echo "=============================================================="
  if [ "${TZSHELL_ALLOW_SKIP:-0}" = "1" ]; then
    echo "TZSHELL_ALLOW_SKIP=1 is set: downgrading this skip to exit 0."
    exit 0
  fi
  echo "Per this project's SKIP=FAIL rule, this is a non-zero exit by default."
  echo "Set TZSHELL_ALLOW_SKIP=1 to explicitly downgrade this specific skip to exit 0."
  exit 1
fi

# --- Sandbox setup ---
# XDG_RUNTIME_DIR must be a SHORT path: dbus-run-session/dconf create
# AF_UNIX sockets under it, and the kernel's sun_path field is capped at
# 108 bytes -- a sandbox created under a long TMPDIR (e.g. a deep
# session-scoped scratch directory) can silently exceed that and break the
# session bus. /tmp/tzshell-XXXXXX is deliberately short.
SANDBOX="$(mktemp -d /tmp/tzshell-XXXXXX)" || exit 1

SHELL_PID=""
kill_process_group() {
  # $1 = signal name (TERM or KILL). No-op if we never got a PID (e.g. we
  # failed before backgrounding the launch). `setsid` below guarantees
  # SHELL_PID is both the PID and the process-group ID (PGID) of the whole
  # dbus-run-session/dbus-daemon/gnome-shell chain, so `kill -SIG -- -PID`
  # (negative PID = "the whole process group") reaches every process in
  # it, not just the immediate backgrounded job.
  [ -n "$SHELL_PID" ] || return 0
  kill -"$1" -- "-$SHELL_PID" 2>/dev/null || true
}

cleanup() {
  local rc=$?
  kill_process_group TERM
  for _ in $(seq 1 20); do
    kill -0 "$SHELL_PID" 2>/dev/null || break
    sleep 0.2
  done
  kill_process_group KILL
  # xdg-desktop-portal may have FUSE-mounted a "documents" passthrough
  # under XDG_RUNTIME_DIR/doc for the sandboxed session; a plain `rm -rf`
  # cannot remove a live mountpoint. Best-effort unmount before cleanup so
  # the sandbox directory doesn't leak a mount or a stray directory on
  # every run; failure here is not itself a test failure (rc is preserved
  # from the actual test outcome above, not from this cleanup step).
  #
  # BUG FIX (found while verifying karen-gate finding 3): this used to be
  # guarded by `if [ -d "$SANDBOX/run/doc" ]`. Once the FUSE portal daemon
  # backing that mount has been killed (which just happened above), the
  # mountpoint enters a "Transport endpoint is not connected" state --
  # and bash's `[ -d ... ]` test returns FALSE for a disconnected FUSE
  # mount (verified empirically), silently skipping the unmount attempt
  # every single time and leaving a dead mount plus its whole sandbox
  # directory behind permanently (confirmed: 3 consecutive runs left 3
  # undeleted /tmp/tzshell-* directories despite each reporting a clean
  # exit). The unmount attempt now always runs unconditionally -- it is a
  # harmless no-op (non-zero exit, swallowed by `|| true`) when nothing is
  # mounted there at all.
  fusermount3 -uz "$SANDBOX/run/doc" 2>/dev/null || fusermount -uz "$SANDBOX/run/doc" 2>/dev/null || umount -l "$SANDBOX/run/doc" 2>/dev/null || true
  rm -rf "$SANDBOX" 2>/dev/null
  exit "$rc"
}
trap cleanup EXIT INT TERM

export HOME="$SANDBOX/home"
export XDG_DATA_HOME="$SANDBOX/xdg-data"
export XDG_CONFIG_HOME="$SANDBOX/xdg-config"
export XDG_CACHE_HOME="$SANDBOX/xdg-cache"
export XDG_RUNTIME_DIR="$SANDBOX/run"
mkdir -p "$HOME" "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

EXT_DIR="$XDG_DATA_HOME/gnome-shell/extensions/$TARGET_UUID"
DRV_DIR="$XDG_DATA_HOME/gnome-shell/extensions/$DRIVER_UUID"
mkdir -p "$EXT_DIR" "$DRV_DIR"

# Copy the REAL, unmodified target extension source into the sandbox --
# never a reimplementation, never edited in place. Only files the
# extension actually ships/needs; tests/, README.md, tools/, screenshot.jpg
# etc. are intentionally left out.
for f in extension.js formatting.js formattingPresets.js separators.js timezones.js cityAliases.js metadata.json; do
  cp "$REPO_ROOT/$f" "$EXT_DIR/" || { echo "FATAL: failed to copy $f into sandbox"; exit 1; }
done
cp -r "$REPO_ROOT/schemas" "$EXT_DIR/schemas" || { echo "FATAL: failed to copy schemas/ into sandbox"; exit 1; }
# Recompile schemas from source inside the sandbox copy rather than trusting
# the repo's own committed gschemas.compiled, so a stale compiled blob can
# never mask a real schema error here.
glib-compile-schemas "$EXT_DIR/schemas" || { echo "FATAL: glib-compile-schemas failed for the sandboxed target extension"; exit 1; }

cp -r "$REPO_ROOT/tests/shell-driver/"* "$DRV_DIR/" || { echo "FATAL: failed to copy tests/shell-driver/ into sandbox"; exit 1; }

RESULT_FILE="$SANDBOX/results.json"
SHELL_LOG="$SANDBOX/shell.log"
export TZSHELL_RESULT_PATH="$RESULT_FILE"
export TZSHELL_TARGET_UUID="$TARGET_UUID"

VIRTUAL_MONITOR="${TZSHELL_VIRTUAL_MONITOR:-800x600}"
RESULT_TIMEOUT="${TZSHELL_TIMEOUT_SECONDS:-90}"

echo "==> tests/run-shell-tests.sh: launching isolated headless gnome-shell"
echo "    sandbox:   $SANDBOX"
echo "    target:    $TARGET_UUID (real, copied verbatim into the sandbox)"
echo "    driver:    $DRIVER_UUID (tests/shell-driver/, this project's own test infra)"
echo "    log:       $SHELL_LOG"
echo "    timeout:   ${RESULT_TIMEOUT}s"

# The gsettings pre-seed and the gnome-shell launch itself share the same
# isolated dbus-run-session (a second, separate dbus-run-session invocation
# would get its own bus and never see the first one's writes). The whole
# chain is written to a small launch script rather than inlined, to avoid
# nested-quoting mistakes, and run under `setsid` so it becomes its own
# process group (see the "PROCESS-GROUP SAFETY" header comment above).
LAUNCH_SCRIPT="$SANDBOX/launch.sh"
cat >"$LAUNCH_SCRIPT" <<EOF
#!/usr/bin/env bash
set -eu
exec dbus-run-session -- bash -c '
  gsettings set org.gnome.shell enabled-extensions "[\"$DRIVER_UUID\"]"
  exec gnome-shell --headless --virtual-monitor "$VIRTUAL_MONITOR"
'
EOF
chmod +x "$LAUNCH_SCRIPT"

setsid "$LAUNCH_SCRIPT" >"$SHELL_LOG" 2>&1 &
SHELL_PID=$!

# --- Wait for the result file, the shell dying, or the timeout ---
elapsed=0
step=1
status="timeout"
while [ "$elapsed" -lt "$RESULT_TIMEOUT" ]; do
  if [ -f "$RESULT_FILE" ]; then
    status="ok"
    break
  fi
  if ! kill -0 "$SHELL_PID" 2>/dev/null; then
    status="shell-exited"
    break
  fi
  sleep "$step"
  elapsed=$((elapsed + step))
done

echo ""
echo "==> tests/run-shell-tests.sh: shell run finished (status=$status, elapsed=${elapsed}s)"

overall_status=0

case "$status" in
  timeout)
    echo "FAIL: no result file appeared within ${RESULT_TIMEOUT}s -- treating as a failure (SKIP=FAIL; this is NOT the"
    echo "      'gnome-shell not installed' skip case, so TZSHELL_ALLOW_SKIP has no effect here)."
    overall_status=1
    ;;
  shell-exited)
    echo "FAIL: the sandboxed gnome-shell process exited before producing a result file."
    overall_status=1
    ;;
  ok)
    ;;
esac

# --- Parse and print the result file, if any ---
if [ -f "$RESULT_FILE" ]; then
  echo ""
  echo "==> Results ($RESULT_FILE):"
  if ! gjs -c '
    const path = ARGV[0];
    const [, contents] = imports.gi.GLib.file_get_contents(path);
    const text = imports.byteArray ? imports.byteArray.toString(contents) : contents.toString();
    const data = JSON.parse(text);
    let anyFail = false;
    for (const r of data.results) {
      if (r.pass) {
        print(`PASS: ${r.name}`);
      } else {
        anyFail = true;
        print(`FAIL: ${r.name}`);
        print(`      ${r.error}`);
      }
    }
    print("");
    print(`Summary: ${data.passed} passed, ${data.failed} failed, ${data.total} total`);
    if (anyFail || data.failed > 0 || data.total === 0) {
      throw new Error("shell-driver reported at least one failure or ran zero assertions");
    }
  ' "$RESULT_FILE"; then
    overall_status=1
  fi
else
  echo "(no result file to parse)"
fi

# --- Scan the shell's own log for JS ERROR/JS WARNING/Clutter markup
#     failures. ---
#
# karen-gate finding 2 (fixed here): the previous version of this scan was
# `grep -nE 'JS (ERROR|WARNING)' "$SHELL_LOG" | grep -F "$SANDBOX"` --
# piping through a second grep that only ever sees the FIRST grep's
# matched line. GJS does NOT put the failing file's path on the same line
# as "JS ERROR"/"JS WARNING"; it appears on the FOLLOWING stack-trace
# line(s) (see any FAIL line's own "@file:///..." frames elsewhere in this
# file's output for an example). That made the old `grep -F "$SANDBOX"`
# filter discard every real hit -- verified by the gate injecting a
# genuinely uncaught JS error and observing this script still report
# "none found" and exit 0.
#
# FIX: this sandbox's shell.log is NOT a shared/ambient log -- it belongs
# to a throwaway gnome-shell process this script alone started, running
# nothing but this OS's bundled services plus the two extensions copied in
# above. There is no legitimate reason for ANY "JS ERROR"/"JS WARNING" line
# to appear in it. So the path-based attribution filter is dropped
# entirely (the coordinator's own suggested alternative to patching it into
# a line-window search) in favor of the strictly stronger rule: ANY such
# line anywhere in this log fails the run, full stop. A short window of
# following lines is still printed for diagnosis (best-effort; not a
# gating condition), since GJS's own stack trace is what actually names the
# offending file.
#
# Also treated as a hard failure per karen-gate finding 1: a
# `Clutter-WARNING **: Failed to set the markup` line. This is the actual
# OS-level signal that ClutterText.set_markup() silently swallowed a Pango
# parse failure (it raises no JS-catchable exception -- see the Phase 5
# fix in extension.js's _updateLabel()/_checkMarkupValid(), and the module
# comment in tests/shell-driver/extension.js). extension.js now validates
# markup with Pango.parse_markup() BEFORE ever calling set_markup(), so
# escaped input should never reach set_markup() in a state that could
# produce this warning in the first place -- if this line ever appears, it
# means that pre-validation was bypassed or broken, which is exactly the
# kind of regression this scan exists to catch.
#
# karen-gate finding 1 (2nd round, fixed here): the scan above only ever
# matched `JS (ERROR|WARNING)` and that one specific Clutter-WARNING
# string. It did NOT match any `*-CRITICAL` line -- `GLib-CRITICAL`,
# `Gjs-CRITICAL`, `GNOME Shell-CRITICAL` -- an undisclosed scope hole a
# real regression could slip straight through. Proven by the gate finding
# that finding 2's disposed-GObject bug (see tests/shell-driver/
# extension.js's teardown section) emitted a genuine
# `Gjs-CRITICAL **: Object ... has been already disposed` line on EVERY
# run, containing neither "JS ERROR" nor "JS WARNING", so the old pattern
# missed it every single time despite it being a real defect. FIX: match
# any `<domain>-CRITICAL **:` line (the standard glib structured-logging
# format every one of GLib's/GJS's/gnome-shell's own CRITICAL-level
# messages uses), not just the two hardcoded domains from before.
#
# ALLOWLIST (narrow, by exact signature -- NOT a loosened pattern): this
# suite's own "panel: an invalid-markup case..." and "panel:
# _logMarkupFailureThrottled()..." tests in tests/shell-driver/
# extension.js deliberately force extension.js's real, intentional
# fallback-logging path to fire (proving finding 1b's fix actually
# engages) -- that is a real, EXPECTED `GNOME Shell-CRITICAL` line (GJS
# elevates extension console.error() output to CRITICAL by design), not a
# regression. It is allowlisted below by matching the EXACT, fixed
# message text extension.js's `_logMarkupFailureThrottled()` logs
# ("failed to render panel markup, falling back to plain text") -- a
# string that cannot originate from anywhere else in this codebase -- and
# nothing broader. Every other CRITICAL/ERROR/WARNING line, from any
# domain, for any other reason, still fails the run.
echo ""
echo "==> Scanning shell log for JS ERROR/JS WARNING/*-CRITICAL/Clutter markup failures ($SHELL_LOG):"
LOG_HITS="$SANDBOX/log-hits.txt"
: >"$LOG_HITS"
grep -nE 'JS (ERROR|WARNING)' "$SHELL_LOG" >>"$LOG_HITS" 2>/dev/null || true
grep -nE -- '-CRITICAL \*\*:' "$SHELL_LOG" >>"$LOG_HITS" 2>/dev/null || true
grep -nE 'Clutter-WARNING \*\*:.*Failed to set the markup' "$SHELL_LOG" >>"$LOG_HITS" 2>/dev/null || true

# Narrow, exact-signature allowlist -- see comment above. Applied as a
# separate filtering pass over the collected hits, not folded into the
# match patterns themselves, so it can never accidentally widen what
# counts as a match.
ALLOWLISTED_HITS="$SANDBOX/log-hits-allowlisted.txt"
if [ -s "$LOG_HITS" ]; then
  grep -F 'failed to render panel markup, falling back to plain text' "$LOG_HITS" >"$ALLOWLISTED_HITS" 2>/dev/null || true
  grep -v -F 'failed to render panel markup, falling back to plain text' "$LOG_HITS" >"$LOG_HITS.tmp" 2>/dev/null || true
  mv "$LOG_HITS.tmp" "$LOG_HITS"
fi

if [ -s "$ALLOWLISTED_HITS" ]; then
  echo "(allowlisted -- expected, intentional fallback-logging test output, not a regression):"
  while IFS=: read -r lineno _rest; do
    sed -n "${lineno}p" "$SHELL_LOG" | sed 's/^/  /'
  done <"$ALLOWLISTED_HITS"
fi
rm -f "$ALLOWLISTED_HITS"

if [ -s "$LOG_HITS" ]; then
  echo "FAIL: JS ERROR/JS WARNING/CRITICAL/Clutter markup-failure lines found in the shell log:"
  while IFS=: read -r lineno _rest; do
    echo "  --- context around line $lineno ---"
    sed -n "${lineno},$((lineno + 5))p" "$SHELL_LOG" | sed 's/^/  /'
  done <"$LOG_HITS"
  overall_status=1
else
  echo "none found (besides any allowlisted lines above)."
fi
rm -f "$LOG_HITS"

echo ""
if [ "$overall_status" -eq 0 ]; then
  echo "run-shell-tests.sh: PASSED (exit 0)."
else
  echo "run-shell-tests.sh: FAILED (exit 1). Full shell log retained below for diagnosis:"
  echo "--------------------------------------------------------------"
  cat "$SHELL_LOG"
  echo "--------------------------------------------------------------"
fi

exit "$overall_status"
