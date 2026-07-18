#!/usr/bin/env bash
# tests/run-all.sh
#
# Runs both test suites from the extension root and fails if either
# suite fails. GSETTINGS_BACKEND=memory is set here as defense-in-depth
# (run-prefs-tests.js also forces it internally via GLib.setenv() before
# constructing any Gio.Settings) so nothing either suite does can ever
# reach dconf or the session bus.
#
# Project rule: SKIP=FAIL. If tests/run-prefs-tests.js cannot construct
# the GTK4/Adw widgets (e.g. no display-independent GTK4/Adw typelibs, or
# no glib-compile-resources), it prints a loud SKIPPED banner AND exits
# non-zero by default -- which this script simply propagates as a normal
# failure below, exactly like any other test failure. There is no
# separate "skip is fine" branch here on purpose: a skip that quietly
# turns into a passing `run-all.sh` exit is the exact failure mode this
# is meant to prevent.
#
# The only way to make a skip exit 0 (for a genuinely GTK-less CI
# environment where failing this suite would be a false alarm about
# prefs.js itself) is to explicitly set TZPREFS_ALLOW_SKIP=1 before
# invoking this script -- it is a normal environment variable, so it is
# inherited by the gjs child process below with no extra plumbing
# needed. Not set here by default.
#
# A third suite, tests/run-shell-tests.sh, runs after both of the above: a
# GJS-level driver (tests/shell-driver/) that launches a real, isolated
# headless gnome-shell and drives the REAL extension.js's panel rendering,
# popup menu separator/formatting-default controls, drag-and-drop reorder
# logic, inline rename commit/cancel, and disable()/teardown signal-leak
# behavior directly -- see tests/shell-driver/extension.js and this
# project's tests/README.md for exactly what it covers and why. Same
# SKIP=FAIL discipline, with its own opt-out: TZSHELL_ALLOW_SKIP=1 (only
# for "gnome-shell is not installed in this environment at all" -- every
# other failure mode, including a timeout waiting for results, is a real
# failure regardless of that variable).
set -u

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

status=0

echo "==> tests/run-tests.js (pure-function suite)"
gjs -m tests/run-tests.js
pure_status=$?
if [ "$pure_status" -ne 0 ]; then
  status=1
fi

echo ""
echo "==> tests/run-prefs-tests.js (real GTK4/Adw prefs.js suite)"
if [ "${TZPREFS_ALLOW_SKIP:-0}" = "1" ]; then
  echo "    (TZPREFS_ALLOW_SKIP=1 is set: a skip here will exit 0, not fail this run)"
fi
GSETTINGS_BACKEND=memory gjs -m tests/run-prefs-tests.js
prefs_status=$?
if [ "$prefs_status" -ne 0 ]; then
  status=1
fi

echo ""
echo "==> tests/run-shell-tests.sh (real gnome-shell driver, isolated sandbox)"
if [ "${TZSHELL_ALLOW_SKIP:-0}" = "1" ]; then
  echo "    (TZSHELL_ALLOW_SKIP=1 is set: a 'gnome-shell not installed' skip here will exit 0)"
fi
bash tests/run-shell-tests.sh
shell_status=$?
if [ "$shell_status" -ne 0 ]; then
  status=1
fi

echo ""
if [ "$status" -eq 0 ]; then
  echo "run-all.sh: all three suites passed (exit 0)."
else
  echo "run-all.sh: FAILED (pure exit=$pure_status, prefs exit=$prefs_status, shell exit=$shell_status)."
  echo "A non-zero prefs/shell exit includes the case where it was SKIPPED -- see its banner above."
  echo "If that skip is expected in this environment, re-run with TZPREFS_ALLOW_SKIP=1 and/or TZSHELL_ALLOW_SKIP=1."
fi

exit "$status"
