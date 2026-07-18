'use strict';

// tests/shell-driver/extension.js
//
// Phase 5 shell-level test driver. This is a small, throwaway COMPANION
// extension -- never a real user-facing feature -- whose only job is to run
// INSIDE a real (nested/headless) gnome-shell process and drive the REAL,
// unmodified target extension (gnome-timezones-extension's extension.js,
// copied verbatim into the sandbox by tests/run-shell-tests.sh) through its
// actual public/instance methods, exactly as GNOME Shell itself would call
// them, then write a machine-readable result file and get out of the way.
//
// WHY THIS EXISTS: AT-SPI synthetic input was tried and is unavailable in
// this environment (see tests/README.md's "Verification coverage" section
// for the full investigation) -- no working Action interface, no working
// focus/keyboard/pointer synthesis under headless Wayland. Rather than
// leave "everything that needs a running shell" entirely unverified, this
// driver reaches directly into the real, already-instantiated extension
// object (`Main.extensionManager.lookup(uuid).stateObj`) and calls its real
// methods and emits real GObject signals on its real widget tree. This is
// NOT equivalent to a pointer-driven end-to-end UI test -- it is real code,
// real signals, real GSettings, real Clutter/Pango, but driven directly
// rather than via synthesized input. Every place that distinction matters
// is called out in a comment at the point it applies, and duplicated in
// tests/README.md's "Verification coverage" section.
//
// This file deliberately does not re-implement any of the target
// extension's logic. Every assertion either calls a real method on the real
// instance, reads real GSettings state, or inspects real Clutter/GObject
// actor state.
//
// karen-gate finding 1 (fixed here): every "renders via markup without
// throwing or falling back" assertion in a previous version of this file
// trusted ClutterText.set_markup()'s OWN silent failure mode as its only
// signal -- but set_markup() does NOT raise a JS-catchable exception on a
// Pango parse failure; it fails silently (only a `Clutter-WARNING **:
// Failed to set the markup` on stderr) and leaves the label showing
// whatever it showed before. The gate proved this by reverting
// escapeMarkup() to a no-op in extension.js and observing every assertion
// here still pass. Every such assertion below now uses Pango.parse_markup()
// itself as an INDEPENDENT oracle on the real, reconstructed markup string
// (via panelMarkup() below), the same technique tests/run-tests.js's pure
// suite already uses, rather than trusting extension.js's own internal
// validation state.

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

function assertTrue(value, message) {
  if (value !== true) {
    throw new Error(message || `expected true, got ${JSON.stringify(value)}`);
  }
}

function assertFalse(value, message) {
  if (value !== false) {
    throw new Error(message || `expected false, got ${JSON.stringify(value)}`);
  }
}

function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(message || `expected ${e}, got ${a}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
      resolve();
      return GLib.SOURCE_REMOVE;
    });
  });
}

// Independent Pango oracle (karen-gate finding 1): parses `markup` with
// the REAL Pango parser, the same one ClutterText.set_markup() uses
// internally, but through an API that DOES raise a JS-catchable exception
// on failure (Pango.parse_markup() throws GLib.MarkupError; ClutterText's
// own set_markup() does not -- see the module comment above). Returns
// `{ ok: true, attrCount }` on success (attrCount is the number of
// recovered Pango attributes -- 0 for plain/escaped text, >0 for real
// formatting -- mirroring tests/run-tests.js's own
// `buildEntryMarkup + Pango.parse_markup` tests) or `{ ok: false, error }`
// on failure. Never trusts extension.js's own internal validation state.
function pangoOracle(markup) {
  try {
    const [, attrList, text] = Pango.parse_markup(markup, -1, '\0');
    return { ok: true, attrCount: attrList.get_attributes().length, text };
  } catch (e) {
    return { ok: false, error: e };
  }
}

// Reconstructs the EXACT markup string _updateLabel() itself would build
// for the panel right now, using inst's own real instance methods
// (_resolveSeparatorValue(), _getMarkupForTimezone()) and the real,
// dynamically-imported escapeMarkup() from formatting.js -- not a
// reimplementation of the assembly logic, just calling the same real
// pieces _updateLabel() calls, so this can be validated independently
// BEFORE (or instead of) trusting what ClutterText did with it.
function panelMarkup(inst, targetModules) {
  const zones = inst._activeOrder.map((zone) => inst._stateByZone.get(zone)).filter((item) => item !== undefined);
  const separatorValue = inst._resolveSeparatorValue();
  const escapedSeparator = targetModules.escapeMarkup(separatorValue);
  return zones.map((item) => inst._getMarkupForTimezone(item)).join(escapedSeparator);
}

// Polls `check()` (a function returning truthy/falsy) up to `timeoutMs`,
// sleeping `stepMs` between attempts, resolving with the last (possibly
// falsy) result. Used only where we deliberately choose not to assume
// synchronous delivery of something (documented at each call site) --
// never used to paper over a genuine failure, since every call site still
// asserts on the *result*, not just "it eventually resolved".
async function waitUntil(check, timeoutMs = 2000, stepMs = 25) {
  const deadline = GLib.get_monotonic_time() + timeoutMs * 1000;
  for (;;) {
    const result = check();
    if (result || GLib.get_monotonic_time() >= deadline) {
      return result;
    }
    await sleep(stepMs);
  }
}

export default class ShellTestDriver extends Extension {
  enable() {
    this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      this._idleId = null;
      this._runAll().catch((e) => {
        this._writeResults([
          {
            name: 'driver: _runAll() must not throw uncaught',
            pass: false,
            error: String((e && e.stack) || e),
          },
        ]);
      });
      return GLib.SOURCE_REMOVE;
    });
  }

  disable() {
    if (this._idleId) {
      GLib.source_remove(this._idleId);
      this._idleId = null;
    }
  }

  async _runAll() {
    const results = [];

    const record = (name, fn) => {
      try {
        fn();
        results.push({ name, pass: true });
      } catch (e) {
        results.push({ name, pass: false, error: String((e && e.message) || e) });
      }
    };

    const recordAsync = async (name, fn) => {
      try {
        await fn();
        results.push({ name, pass: true });
      } catch (e) {
        results.push({ name, pass: false, error: String((e && e.message) || e) });
      }
    };

    const extMgr = Main.extensionManager;
    const targetUuid = GLib.getenv('TZSHELL_TARGET_UUID') || 'inquiries@itwerx.net';

    // The target extension's copied-verbatim source lives in the sibling
    // extension directory tests/run-shell-tests.sh creates next to this
    // driver's own install dir. Dynamically importing formatting.js /
    // formattingPresets.js FROM THAT REAL COPY (rather than hardcoding the
    // curated preset ids/values here) means this driver can never silently
    // drift from the real curated lists it is asserting against.
    let targetModules = null;
    await recordAsync('setup: dynamically import the REAL target formatting.js/formattingPresets.js', async () => {
      const targetDir = `${GLib.path_get_dirname(this.path)}/${targetUuid}`;
      const formatting = await import(`file://${targetDir}/formatting.js`);
      const presets = await import(`file://${targetDir}/formattingPresets.js`);
      targetModules = { ...formatting, ...presets };
      assertTrue(typeof targetModules.parseFormatting === 'function', 'parseFormatting not found in imported formatting.js');
      assertTrue(Array.isArray(targetModules.FONT_SIZE_PRESETS), 'FONT_SIZE_PRESETS not found in imported formattingPresets.js');
    });

    // --- Enable the real target extension ---

    let inst = null;

    await recordAsync('enable: extensionManager.enableExtension(target) succeeds', async () => {
      const ok = extMgr.enableExtension(targetUuid);
      assertTrue(ok === true, `enableExtension returned ${ok}`);
      const found = await waitUntil(() => {
        const meta = extMgr.lookup(targetUuid);
        return meta && meta.stateObj ? meta : null;
      });
      assertTrue(!!found, 'extensionManager.lookup(target).stateObj never appeared');
      inst = found.stateObj;
    });

    if (!inst) {
      record('ABORT: remaining shell-driver assertions skipped -- target instance never became available', () => {
        throw new Error('inst is null; see the enable() failure above for the root cause');
      });
      this._writeResults(results);
      return;
    }

    // =====================================================================
    // 1. enable() / panel rendering
    // =====================================================================

    record('panel: button and label actors exist after enable(), parented and registered (baseline for the teardown checks below)', () => {
      assertTrue(!!inst._button, 'no _button');
      assertTrue(!!inst._label, 'no _label');
      assertTrue(!!inst._label.clutter_text, 'label has no clutter_text');
      // Baseline for the teardown section's "unparented"/"status area
      // entry removed" checks below: without asserting the POSITIVE state
      // here first, those later checks could pass vacuously if the button
      // were, for any reason, never actually parented/registered in the
      // first place (karen-gate audit finding).
      assertTrue(inst._button.get_parent() !== null, 'panel button has no parent actor right after enable()');
      const statusAreaKey = `${inst.metadata.name} Indicator`;
      assertTrue(!!Main.panel.statusArea[statusAreaKey], 'status area does not reference the button right after enable()');
    });

    record('panel: default single-zone (UTC) label matches the expected 24h "UTC HH:MM" shape', () => {
      inst._updateLabel();
      const text = inst._label.clutter_text.get_text();
      assertTrue(/^UTC \d{2}:\d{2}$/.test(text), `unexpected panel text: ${JSON.stringify(text)}`);
    });

    record('panel: default (unconfigured) rendering is valid Pango markup with zero recovered attributes (independent Pango.parse_markup() oracle)', () => {
      inst._updateLabel();
      const markup = panelMarkup(inst, targetModules);
      const oracle = pangoOracle(markup);
      assertTrue(oracle.ok, `Pango.parse_markup() rejected the assembled markup: ${oracle.error} (markup=${JSON.stringify(markup)})`);
      // No bold/size/color configured yet -> buildEntryMarkup() emits no
      // <span>/<b> at all, so a REAL Pango parse should recover zero
      // attributes -- mirrors tests/run-tests.js's own zero-attribute
      // assertions for unconfigured/escaped-only markup.
      assertEqual(oracle.attrCount, 0, `expected zero Pango attributes for unconfigured markup, got ${oracle.attrCount}: ${markup}`);
      // Corroborating (not sole) signal from the real ClutterText: since
      // the oracle above already proved the assembled markup is valid,
      // extension.js's own pre-validation (_checkMarkupValid()) should
      // have let set_markup() run, not the plain-text fallback.
      assertTrue(inst._label.clutter_text.get_use_markup() === true, 'use_markup is false despite valid markup -- fell back to plain text');
      assertTrue(inst._lastMarkupFailureLogTime === undefined, 'a markup parse failure was logged for valid, unconfigured markup');
    });

    record('panel: a per-zone formatting override (real gsettings write + real _loadSettings/_updateLabel) produces valid markup with the expected non-zero Pango attributes (independent oracle)', () => {
      // Real write path: the 'formatting' GSettings key, exactly as
      // prefs.js/extension.js would write it. _loadSettings() is called
      // directly afterwards (the same method the real 'changed' signal
      // handler calls) rather than waiting on dconf's own change
      // notification round-trip, so this assertion is deterministic
      // instead of racing an external D-Bus signal delivery.
      const blob = JSON.stringify({ size: 20, color: '#00ff00', boldCity: true, boldTime: false, boldZone: false });
      inst._settings.set_value('formatting', new GLib.Variant('a{ss}', { UTC: blob }));
      inst._loadSettings();
      inst._updateLabel();

      const markup = panelMarkup(inst, targetModules);
      const oracle = pangoOracle(markup);
      assertTrue(oracle.ok, `Pango.parse_markup() rejected the assembled markup: ${oracle.error} (markup=${JSON.stringify(markup)})`);
      // size!=0 + color!='' -> one outer <span size=".." foreground="..">
      // (2 attributes: size, foreground) wrapping the whole entry;
      // boldCity=true -> one more <b> weight attribute over just the city
      // segment. Verified empirically against the real buildEntryMarkup()
      // output for these exact inputs before hardcoding this count (same
      // discipline as tests/run-tests.js's own exact-attribute-count
      // assertions).
      assertEqual(oracle.attrCount, 3, `expected exactly 3 Pango attributes (size + foreground + bold weight), got ${oracle.attrCount}: ${markup}`);
      assertTrue(oracle.text.includes('UTC'), `city segment missing from the recovered plain text: ${JSON.stringify(oracle.text)}`);

      assertTrue(inst._label.clutter_text.get_use_markup() === true, 'use_markup is false despite valid markup -- fell back to plain text');
      assertTrue(inst._lastMarkupFailureLogTime === undefined, 'a markup parse failure was logged for a valid per-zone override');

      // Clean up so later tests start from a known, override-free state.
      inst._settings.set_value('formatting', new GLib.Variant('a{ss}', {}));
      inst._loadSettings();
    });

    record('config: toggling the real "Hide system clock" switch actually hides the real dateMenu clock display (establishes a genuine baseline for the teardown-restore check below)', () => {
      // karen-gate audit finding: the original "system clock visibility is
      // restored after disable()" teardown assertion used
      // `!clockDisplay || clockDisplay.visible === true`, which passes
      // VACUOUSLY if clockDisplay is falsy (never proven false here) OR if
      // the clock was simply never hidden in the first place -- and
      // nothing earlier in this file ever drove _config.hideSystemClock to
      // true, so disable()'s restore branch
      // (`if (this._hidSystemClock) { clockDisplay.visible = true; }`)
      // was NEVER actually exercised; the check passed only because the
      // clock was already visible the whole time. Verified empirically in
      // this environment that `Main.panel.statusArea.dateMenu._clockDisplay`
      // genuinely exists (a real actor, not undefined) via a standalone
      // probe extension before relying on it here.
      const clockDisplay = Main.panel.statusArea.dateMenu?._clockDisplay;
      assertTrue(!!clockDisplay, 'no real dateMenu._clockDisplay in this environment -- cannot exercise this path at all');
      const entry = inst._configSwitches.hideSystemClock;
      assertTrue(!!entry, 'no "hideSystemClock" config switch tracked');
      assertTrue(entry.getValue() === false, 'hideSystemClock is unexpectedly already true before this test');
      entry.item.toggle(); // real PopupSwitchMenuItem method -> real 'toggled' handler -> real _applySystemClockVisibility()
      assertTrue(entry.getValue() === true, 'toggling "Hide system clock" did not flip its stored value');
      assertTrue(clockDisplay.visible === false, 'the real system clock was not actually hidden after enabling "Hide system clock"');
      assertTrue(inst._hidSystemClock === true, '_hidSystemClock was not set to true by the real hide path');
    });

    record('panel: an invalid-markup case (constructed directly, since real escaping makes this unreachable via normal input) genuinely engages the real plain-text fallback in _updateLabel()', () => {
      // karen-gate finding 1b (product bug, not just a test bug): before
      // this Phase 5 fix, ClutterText.set_markup() swallowed Pango parse
      // failures silently and never threw, so extension.js's try/catch
      // plain-text fallback in _updateLabel() was DEAD CODE -- a markup
      // failure would never trigger it, leaving the panel showing
      // whatever set_markup() left behind (empty/stale) with only a
      // Clutter-WARNING on stderr. The fix: _updateLabel() now validates
      // the assembled markup with Pango.parse_markup() itself (via the
      // real _checkMarkupValid() method) BEFORE ever calling
      // set_markup(), and takes the plain-text fallback path when
      // validation fails.
      //
      // Escaping makes genuinely invalid markup unreachable through any
      // real user-facing input path (every dynamic segment is routed
      // through escapeMarkup()/sanitizeColor()/sanitizeFontSize() first),
      // so this is defense-in-depth for a case that "shouldn't" happen --
      // proving it here means temporarily forcing _getMarkupForTimezone()
      // (a real instance method) to return a hand-crafted invalid string,
      // calling the real _updateLabel(), and then restoring the original
      // method. This does not modify _updateLabel() or _checkMarkupValid()
      // themselves -- only one of their real inputs, for this one call.
      const originalGetMarkup = inst._getMarkupForTimezone.bind(inst);
      inst._getMarkupForTimezone = () => '<b>unterminated MUTATION-STYLE invalid markup';

      // Root-caused during verification of this test: St.Label/ClutterText's
      // `.text = X` setter (what _setPanelText() uses) is a NO-OP regarding
      // the `use-markup` flag specifically when X already equals the
      // currently-cached text -- confirmed with a standalone probe extension
      // (set_markup() to text T, then `.text = T` again: use-markup stays
      // TRUE, even though a genuinely DIFFERENT value correctly resets it to
      // FALSE). Left unhandled, this test would be flaky/order-dependent: if
      // a real WallClock tick's last valid render happened to strip down to
      // the exact same string _getLabelForTimezone() would independently
      // compute for the fallback (both are "UTC HH:MM" for the same
      // real-world minute -- not a rare coincidence at all), the
      // use-markup-false assertion below would fail for a reason that has
      // NOTHING to do with whether the real fallback logic works. Forcing
      // the label to a sentinel value first, guaranteed to differ from
      // whatever _getLabelForTimezone() will independently compute,
      // eliminates that coincidence and makes this test deterministic.
      inst._label.clutter_text.set_markup('<b>SENTINEL-BEFORE-FALLBACK-TEST-' + GLib.get_monotonic_time() + '</b>');

      let validation;
      try {
        validation = inst._checkMarkupValid(inst._getMarkupForTimezone());
        assertTrue(validation.ok === false, 'test setup problem: the hand-crafted string was not actually invalid Pango markup');

        inst._updateLabel();

        assertTrue(inst._label.clutter_text.get_use_markup() === false, 'use_markup is still true -- the plain-text fallback was not taken for invalid markup');
        assertTrue(inst._lastMarkupFailureLogTime !== undefined, '_lastMarkupFailureLogTime was never set -- the throttled failure log was not engaged');
        const fallbackText = inst._label.text;
        assertTrue(typeof fallbackText === 'string' && /\S/.test(fallbackText), `panel fell back to empty/unreadable text, not readable plain text: ${JSON.stringify(fallbackText)}`);
        assertTrue(!fallbackText.includes('<b>'), `fallback text still contains raw markup syntax instead of plain text: ${JSON.stringify(fallbackText)}`);
        assertTrue(!fallbackText.includes('SENTINEL-BEFORE-FALLBACK-TEST'), `fallback text is still the pre-test sentinel, not real fallback content: ${JSON.stringify(fallbackText)}`);
      } finally {
        inst._getMarkupForTimezone = originalGetMarkup;
        inst._lastMarkupFailureLogTime = undefined;
        // Same no-op-on-equal-value consideration applies to restoring
        // valid rendering: force a differing sentinel into use_markup=false
        // state first, so the final assertion below (use_markup back to
        // true) cannot itself be masked by the same coincidence.
        inst._label.text = 'SENTINEL-BEFORE-RESTORE-' + GLib.get_monotonic_time();
        inst._updateLabel(); // restore real, valid rendering before later tests run
      }

      assertTrue(inst._label.clutter_text.get_use_markup() === true, 'restoring the real _getMarkupForTimezone did not bring markup rendering back');
    });

    record('panel: _logMarkupFailureThrottled() suppresses a second failure inside its 300s window, then re-arms once the window has elapsed', () => {
      // karen-gate finding 3: the earlier "invalid-markup fallback" test
      // above exercises the throttle's FIRST branch once (it sets the
      // timestamp) but nothing proved a SECOND failure inside the same
      // window is actually suppressed, or that the throttle correctly
      // re-arms afterward rather than suppressing forever. `console.error`
      // itself could not be intercepted to count real log calls directly
      // -- confirmed empirically via a standalone probe extension that
      // GJS's `console.error` property is neither writable NOR
      // configurable (`Object.defineProperty` throws "can't redefine
      // non-configurable property"), so there is no way to spy on it from
      // outside extension.js. Instead, this drives `_lastMarkupFailureLogTime`
      // itself -- the SAME state `_logMarkupFailureThrottled()` both reads
      // to decide whether to suppress AND writes only on the un-suppressed
      // branch (see extension.js: the early `return` happens strictly
      // BEFORE the `this._lastMarkupFailureLogTime = now;` assignment, so
      // the two are inseparable in the real code, not just correlated in
      // this test) -- through three real failures: unthrottled (sets a
      // fresh timestamp), immediately throttled (timestamp must NOT
      // change), and throttled-window-artificially-elapsed (timestamp
      // MUST change again, proving the suppression is not permanent).
      const originalGetMarkup = inst._getMarkupForTimezone.bind(inst);
      inst._getMarkupForTimezone = () => '<b>unterminated THROTTLE-TEST invalid markup';
      // Distinct sentinel first -- same .text=/set_markup() no-op-on-equal-
      // value consideration documented on the test above.
      inst._label.clutter_text.set_markup('<b>SENTINEL-BEFORE-THROTTLE-TEST-' + GLib.get_monotonic_time() + '</b>');

      try {
        inst._lastMarkupFailureLogTime = undefined;
        inst._updateLabel(); // failure #1: not throttled (no prior timestamp) -> must set one
        const t1 = inst._lastMarkupFailureLogTime;
        assertTrue(t1 !== undefined, 'failure #1 did not set _lastMarkupFailureLogTime at all');

        // karen-gate finding (2nd round): comparing the post-call value to
        // `t1` here is exactly the same whole-second-granularity coincidence
        // the "re-arm" assertion further below already had to work around
        // (both `t1` and a freshly-reassigned "now" come from
        // GLib.DateTime...to_unix() and this whole test runs well inside
        // one real second, so they can be numerically EQUAL whether or not
        // the throttle guard actually ran) -- proven by the gate: deleting
        // the ENTIRE throttle guard from _logMarkupFailureThrottled() still
        // passed this assertion every time, because the reassigned "now"
        // coincided with `t1` by chance, not because suppression happened.
        // FIX: overwrite `_lastMarkupFailureLogTime` with a SENTINEL value
        // that (a) still keeps failure #2 inside the throttle window
        // relative to any real "now" a few seconds later, but (b) can never
        // coincide with a freshly-reassigned real "now" (which only ever
        // moves forward from the real wall clock, never backward to a
        // value tens of seconds in the past). If the throttle guard is
        // intact, failure #2 must leave this sentinel untouched; if the
        // guard is missing, failure #2 overwrites it with a real "now" that
        // cannot equal the sentinel.
        const sentinel2 = t1 - 60;
        inst._lastMarkupFailureLogTime = sentinel2;
        inst._updateLabel(); // failure #2, immediately after: inside the window -> must be suppressed
        assertEqual(
          inst._lastMarkupFailureLogTime,
          sentinel2,
          '_lastMarkupFailureLogTime changed on a second failure inside the 300s throttle window -- the second failure was not suppressed'
        );

        // Roll the tracked timestamp back past the known 300s window
        // (MARKUP_FAILURE_LOG_INTERVAL_SECONDS in extension.js) rather
        // than waiting 300 real seconds -- this backdates the SAME
        // GLib.DateTime-based value _logMarkupFailureThrottled() itself
        // reads; it does not reimplement or bypass its comparison logic.
        const backdated = t1 - 301;
        inst._lastMarkupFailureLogTime = backdated;
        inst._updateLabel(); // failure #3, now outside the window -> must NOT be suppressed
        // NOT `> t1`: GLib.DateTime...to_unix() has whole-SECOND
        // granularity, and this whole test runs well within one real
        // second, so a correctly-reassigned "fresh" timestamp can be
        // numerically EQUAL to t1 by coincidence, not just greater --
        // asserting `> t1` here intermittently failed for exactly that
        // reason even though the throttle logic was working correctly
        // (verified: `_logMarkupFailureThrottled()`'s un-suppressed branch
        // ran, evidenced by the assignment happening at all). What
        // genuinely distinguishes "re-armed" from "still stuck throttled"
        // is whether the value CHANGED AT ALL from the artificial backdated
        // one we just set -- if the throttle incorrectly stayed suppressed,
        // `_lastMarkupFailureLogTime` would still be exactly `backdated`.
        assertTrue(
          inst._lastMarkupFailureLogTime !== backdated,
          `expected _lastMarkupFailureLogTime to be reassigned once the throttle window had elapsed, but it is still the artificially backdated value (${backdated}) -- the throttle did not re-arm`
        );
      } finally {
        inst._getMarkupForTimezone = originalGetMarkup;
        inst._lastMarkupFailureLogTime = undefined;
        inst._label.text = 'SENTINEL-AFTER-THROTTLE-TEST-' + GLib.get_monotonic_time();
        inst._updateLabel(); // restore real, valid rendering before later tests run
      }

      assertTrue(inst._label.clutter_text.get_use_markup() === true, 'restoring real rendering after the throttle test failed');
    });

    // =====================================================================
    // 2. Popup menu: separator picker (real menu row -> real 'activate' signal)
    // =====================================================================

    record('setup: activate a second zone (America/New_York) so a separator is actually visible between two entries', () => {
      const nyItem = inst._stateByZone.get('America/New_York');
      assertTrue(!!nyItem, 'America/New_York not found in _stateByZone');
      inst._toggleTimezone(nyItem);
      assertEqual(inst._activeOrder, ['UTC', 'America/New_York']);
    });

    record('popup menu: separator submenu was built with a row for every curated id', () => {
      assertTrue(!!inst._separatorMenuItems.pipe, 'no "pipe" separator row');
    });

    record('popup menu: emitting "activate" on the real "pipe" separator row writes the gsetting and re-joins the panel with it', () => {
      // emit('activate') drives the REAL connected handler
      // (row.connect('activate', () => this._selectSeparator(entry.id)))
      // exactly as a real click would, proving the signal wiring itself,
      // not just _selectSeparator() in isolation.
      inst._separatorMenuItems.pipe.emit('activate', null);
      assertEqual(inst._settings.get_string('separator'), 'pipe');
      inst._updateLabel();
      const text = inst._label.clutter_text.get_text();
      assertTrue(text.includes(' | '), `panel text does not contain the pipe separator: ${JSON.stringify(text)}`);
    });

    // =====================================================================
    // 3. Popup menu: formatting defaults (font size, color, 3 bold switches)
    // =====================================================================

    record('popup menu: emitting "activate" on a real font-size preset row writes formatting-defaults.size', () => {
      const preset = targetModules.FONT_SIZE_PRESETS.find((p) => p.value !== 0) || targetModules.FONT_SIZE_PRESETS[0];
      assertTrue(!!inst._fontSizeMenuItems[preset.id], `no font-size row for preset "${preset.id}"`);
      inst._fontSizeMenuItems[preset.id].emit('activate', null);
      const defaults = targetModules.parseFormatting(inst._settings.get_string('formatting-defaults'));
      assertEqual(defaults.size, preset.value);
    });

    record('popup menu: emitting "activate" on a real color preset row writes formatting-defaults.color', () => {
      const preset = targetModules.COLOR_PALETTE.find((p) => p.value !== '') || targetModules.COLOR_PALETTE[0];
      assertTrue(!!inst._colorMenuItems[preset.id], `no color row for preset "${preset.id}"`);
      inst._colorMenuItems[preset.id].emit('activate', null);
      const defaults = targetModules.parseFormatting(inst._settings.get_string('formatting-defaults'));
      assertEqual(defaults.color, preset.value);
    });

    record('popup menu: toggling the real bold-city/bold-time/bold-zone switches writes all three formatting-defaults flags', () => {
      ['formattingBoldCity', 'formattingBoldTime', 'formattingBoldZone'].forEach((name) => {
        const entry = inst._configSwitches[name];
        assertTrue(!!entry, `no config switch tracked for "${name}"`);
        const before = Boolean(entry.getValue());
        entry.item.toggle(); // real PopupSwitchMenuItem method; emits 'toggled', which the real handler writes from
        const after = Boolean(entry.getValue());
        assertTrue(after === !before, `toggling "${name}" did not flip its value (before=${before}, after=${after})`);
      });

      const defaults = targetModules.parseFormatting(inst._settings.get_string('formatting-defaults'));
      assertTrue(defaults.boldCity === true, 'boldCity not persisted');
      assertTrue(defaults.boldTime === true, 'boldTime not persisted');
      assertTrue(defaults.boldZone === true, 'boldZone not persisted');
    });

    record('popup menu: rendering reflects the formatting-defaults changes as valid markup with non-zero recovered Pango attributes (independent oracle)', () => {
      inst._updateLabel();
      const markup = panelMarkup(inst, targetModules);
      const oracle = pangoOracle(markup);
      assertTrue(oracle.ok, `Pango.parse_markup() rejected the assembled markup: ${oracle.error} (markup=${JSON.stringify(markup)})`);
      // Both active zones (UTC, America/New_York) now fall back to
      // formatting-defaults with a non-zero size, a non-empty color, and
      // boldCity/boldTime true, so a real Pango parse must recover at
      // least one attribute per entry -- unlike the exact-count assertions
      // above, the precise total here also depends on the two-zone join,
      // so this only asserts "non-zero" (a real, still-discriminating
      // signal: a broken/no-op formatting-defaults application would
      // recover exactly 0).
      assertTrue(oracle.attrCount > 0, `expected non-zero Pango attributes after applying formatting defaults, got ${oracle.attrCount}: ${markup}`);
      assertTrue(inst._label.clutter_text.get_use_markup() === true, 'use_markup is false despite valid markup -- fell back to plain text');
      assertTrue(inst._lastMarkupFailureLogTime === undefined, 'a markup parse failure was logged after applying formatting defaults');
    });

    // =====================================================================
    // 4. Drag-and-drop: driving the reorder LOGIC directly (pointer DnD
    //    cannot be synthesized headless -- see the module doc comment and
    //    tests/README.md's "Verification coverage" section).
    // =====================================================================

    record('DnD: _computeInsertionIndex boundary math against a live-shaped row-geometry array', () => {
      const rows = [
        { y: 0, height: 20 },
        { y: 20, height: 20 },
        { y: 40, height: 20 },
      ];
      assertEqual(inst._computeInsertionIndex(5, rows), 0);
      assertEqual(inst._computeInsertionIndex(25, rows), 1);
      assertEqual(inst._computeInsertionIndex(100, rows), 3);
    });

    record('DnD: _reorderActiveZone moves a zone in _activeOrder and persists the new order to the "timezones" gsetting', () => {
      // Order going in is ['UTC', 'America/New_York'] (see the separator
      // setup test above). Move America/New_York to index 0.
      inst._reorderActiveZone('America/New_York', 0);
      assertEqual(inst._activeOrder, ['America/New_York', 'UTC']);
      const stored = inst._settings.get_value('timezones').deep_unpack();
      assertEqual(stored, ['America/New_York', 'UTC']);
    });

    record('DnD: the panel order follows the reordered _activeOrder', () => {
      inst._updateLabel();
      const text = inst._label.clutter_text.get_text();
      const nyIndex = text.indexOf('New York');
      const utcIndex = text.indexOf('UTC');
      assertTrue(nyIndex !== -1 && utcIndex !== -1, `expected both cities in panel text: ${JSON.stringify(text)}`);
      assertTrue(nyIndex < utcIndex, `New York did not render before UTC after reorder: ${JSON.stringify(text)}`);
    });

    record('DnD: _getDragSourceZone resolves both the direct-tag and the _delegate-hop source shapes dnd.js may pass', () => {
      assertEqual(inst._getDragSourceZone({ dragZoneId: 'UTC', _delegate: null }), 'UTC');
      assertEqual(inst._getDragSourceZone({ _delegate: { dragZoneId: 'America/New_York' } }), 'America/New_York');
      assertEqual(inst._getDragSourceZone(null), null);
    });

    record('DnD: _handleActiveDragOver returns MOVE_DROP AND positions the real drop-indicator actor in the active-menu box (a real, mutable side effect, not just a return-value check)', () => {
      // karen-gate audit finding: "returns MOVE_DROP" alone is a weak
      // oracle -- per extension.js's OWN comment on this method, it
      // "Always returns MOVE_DROP", so almost any implementation (even a
      // near-total no-op) would still pass a return-value-only check.
      // Verifying the real side effect (_showDropIndicatorAt() actually
      // inserting this._dropIndicator into this._activeMenu.box) is what
      // makes this assertion able to fail on a real regression.
      const result = inst._handleActiveDragOver(null, null, 0, 0);
      assertEqual(result, DND.DragMotionResult.MOVE_DROP);
      assertTrue(!!inst._dropIndicator, 'no drop-indicator actor was created');
      assertTrue(inst._dropIndicator.get_parent() === inst._activeMenu.box, 'drop-indicator actor was not inserted into the active menu box');
      assertTrue(inst._dropIndicator.isDropIndicator === true, 'drop-indicator actor is missing its isDropIndicator tag');
      inst._clearDropIndicator(); // real cleanup method -- leaves state as a genuinely cancelled drag would
    });

    record('DnD: _acceptActiveDrop resolves the correct drag-source zone id and invokes the real _reorderActiveZone() with it (spy wraps the REAL method, still executes it)', () => {
      // karen-gate audit finding: the previous version of this test only
      // checked `accepted === true` and `_activeOrder.length` unchanged.
      // _reorderActiveZone() removes-then-reinserts a single element, so
      // the array LENGTH is unchanged whether or not a reorder actually
      // happened -- a completely no-op'd _acceptActiveDrop that did
      // nothing but `return true` would have passed the old test too. This
      // version wraps the REAL _reorderActiveZone with a spy that records
      // its call arguments and then calls straight through to the
      // original (never replacing its logic), proving _acceptActiveDrop
      // genuinely resolved the correct dragged zone id AND genuinely
      // invoked the real reorder method with it -- exact ORDER-math
      // correctness is already covered, with mutation-proof, by the
      // dedicated "_reorderActiveZone moves a zone..." test above.
      const before = inst._activeOrder.slice();
      assertTrue(before.length === 2, `expected 2 active zones going in, got ${before.length}`);
      const draggedZone = before[1];

      let capturedArgs = null;
      const realReorder = inst._reorderActiveZone.bind(inst);
      inst._reorderActiveZone = (zoneId, targetIndex) => {
        capturedArgs = [zoneId, targetIndex];
        return realReorder(zoneId, targetIndex);
      };

      let accepted;
      try {
        // Shaped exactly like the real dragHandle _getDragSourceZone()
        // reads from (dragZoneId set directly on the source, see
        // _addActiveMenuRow).
        const source = { dragZoneId: draggedZone, _delegate: null };
        accepted = inst._acceptActiveDrop(source, null, 0, 0);
      } finally {
        inst._reorderActiveZone = realReorder;
      }

      assertTrue(accepted === true, `acceptDrop returned ${accepted}`);
      assertTrue(!!capturedArgs, '_reorderActiveZone was never called by _acceptActiveDrop -- a no-op acceptDrop would not be caught otherwise');
      assertEqual(capturedArgs[0], draggedZone, `_acceptActiveDrop resolved the wrong drag-source zone id: called _reorderActiveZone(${JSON.stringify(capturedArgs)})`);
      assertTrue(inst._activeOrder.length === before.length, 'zone count changed during a reorder drop');
      assertTrue(inst._activeOrder.includes(draggedZone), 'dragged zone disappeared from _activeOrder after the drop');
    });

    record('DnD invariant: every zone id appears at most once in _activeOrder after repeated drags', () => {
      const seen = new Set();
      inst._activeOrder.forEach((zone) => {
        assertTrue(!seen.has(zone), `duplicate zone id "${zone}" in _activeOrder`);
        seen.add(zone);
      });
    });

    // =====================================================================
    // 5. Inline rename: commit via the real _setLabel(), cancel via a real,
    //    argument-free GObject signal emission on the real row's entry.
    // =====================================================================

    record('rename: _setLabel() commits a sanitized label into the "labels" gsetting and the row\'s recomputed full label', () => {
      inst._setLabel('UTC', 'Home Base');
      assertEqual(inst._labels.UTC, 'Home Base');
      const stored = inst._settings.get_value('labels').deep_unpack();
      assertEqual(stored.UTC, 'Home Base');
      const utcItem = inst._stateByZone.get('UTC');
      assertTrue(utcItem.label.includes('Home Base'), `row label missing committed alias: ${utcItem.label}`);
    });

    record('rename: a label containing markup metacharacters commits, then renders escaped/inert -- proven by recovering it as LITERAL text from a real Pango parse, not by trusting set_markup()', () => {
      const hostile = '<b>evil</b>&"';
      inst._setLabel('UTC', hostile);
      inst._updateLabel();

      const markup = panelMarkup(inst, targetModules);
      const oracle = pangoOracle(markup);
      assertTrue(oracle.ok, `Pango.parse_markup() rejected the assembled markup: ${oracle.error} (markup=${JSON.stringify(markup)})`);
      // The sharpest available proof that the hostile label never broke
      // out of escaping: Pango's OWN recovered plain text (the 3rd
      // parse_markup() return value) contains the hostile string BACK OUT
      // VERBATIM, byte-for-byte -- meaning Pango decoded escaped entities
      // (&lt;/&gt;/&amp;/&quot;) back into these exact literal characters
      // as inert TEXT CONTENT, never interpreted them as real tags. This
      // does not depend on the current formatting-defaults state (which by
      // this point in the run has non-neutral bold/size/color applied from
      // section 3 above, so a plain "zero attributes" check would not be
      // meaningful here) -- mirrors tests/run-tests.js's own
      // "recovers as literal inert text" pattern.
      assertTrue(
        oracle.text.includes(hostile),
        `hostile label was not recovered verbatim as inert text (Pango may have interpreted part of it as real markup): recovered=${JSON.stringify(oracle.text)}`
      );

      assertTrue(inst._label.clutter_text.get_use_markup() === true, 'markup fallback triggered by a hostile label');
      assertTrue(inst._lastMarkupFailureLogTime === undefined, 'a markup parse failure was logged for a hostile label');
    });

    record('rename: a real, argument-free "key-focus-out" signal emission on the live row\'s entry drives the real cancelEdit() closure and writes nothing', () => {
      // Committing via a synthesized Return keypress would require
      // constructing a real Clutter.Event outside the shell's own input
      // pipeline, which carries a real crash/hang risk in this headless
      // Clutter/Mutter build -- the same class of limitation this
      // project's DnD section already establishes as an acceptable,
      // explicitly-labeled gap (see the module doc comment). Cancel,
      // however, needs NO synthesized event at all: extension.js wires
      // 'key-focus-out' with a handler that ignores every parameter
      // (`entry.clutter_text.connectObject('key-focus-out', () =>
      // cancelEdit(), entry)`), so this is a genuine, argument-free
      // GObject signal emission on the real live entry actor -- it drives
      // the real cancelEdit() closure exactly as losing keyboard focus
      // would, with no synthetic input required.
      inst._updateActiveMenu();
      const beforeLabels = { ...inst._labels };

      const row = inst._activeMenu.box.get_children().find((c) => typeof c.acceptDrop === 'function');
      assertTrue(!!row, 'no active-clock row found in the active menu box');

      const entry = row.get_children().find((c) => c instanceof St.Entry);
      assertTrue(!!entry, 'no inline-rename St.Entry found on the row');

      const buttons = row.get_children().filter((c) => c instanceof St.Button);
      // Build order in _addActiveMenuRow() is dragHandle, then editButton;
      // both are St.Button, so the edit button is always the LAST one.
      const editButton = buttons[buttons.length - 1];
      assertTrue(!!editButton, 'no edit button found on the row');

      editButton.emit('clicked', 1); // real enterEditMode() (StButton::clicked passes the mouse button number)
      assertTrue(entry.visible === true, 'entering edit mode did not make the entry visible');

      entry.set_text('should never be saved');
      entry.clutter_text.emit('key-focus-out'); // real cancelEdit()

      assertTrue(entry.visible === false, 'cancelEdit() did not hide the entry again');
      assertEqual(inst._labels, beforeLabels, 'labels changed despite the edit being cancelled');
    });

    // =====================================================================
    // 6. disable() / lock-screen teardown: signal-leak and actor-leak
    //    detection, across several enable/disable cycles.
    // =====================================================================

    let snapshot = null;

    record('teardown setup: tracked draggable count matches the number of active rows before the first disable()', () => {
      assertTrue(Array.isArray(inst._rowDraggables), '_rowDraggables is not an array');
      assertEqual(inst._rowDraggables.length, inst._activeOrder.length);
    });

    record('teardown setup: capture a snapshot of every tracked GObject/signal id before disabling', () => {
      // karen-gate finding 2: capture a STABLE ancestor of the button and
      // its current child count HERE, while everything is still live --
      // never the button itself for post-disable comparison (see the
      // "unparented" test below for why).
      //
      // NOT the button's immediate parent: verified empirically (a
      // standalone probe extension) that `button.get_parent()` is a
      // per-indicator `St.Bin` wrapper `Main.panel.addToStatusArea()`
      // creates, and it is NOT reliably alive after disable() -- it gets
      // destroyed too, just not synchronously with the button (a first
      // fix using it passed in isolated runs but then hit a real
      // `Gjs-CRITICAL: Object St.Bin ... has been already disposed` once
      // this test ran later in a full sequence, i.e. the exact same class
      // of bug finding 2 already flagged once, just one ancestor level
      // up). The GRANDPARENT (two `get_parent()` hops from the button --
      // confirmed via the same probe to be GNOME Shell's own persistent
      // panel box, e.g. `Main.panel._centerBox`, which is never destroyed
      // during normal enable/disable) reliably drops its own child count
      // by exactly one once the button (and its wrapper) are destroyed --
      // confirmed empirically (centerBox child count 2 -> 1 immediately
      // after `button.destroy()`).
      const buttonParent = inst._button.get_parent();
      assertTrue(!!buttonParent, 'panel button has no parent actor before disable() (test setup problem)');
      const buttonAncestor = buttonParent.get_parent();
      assertTrue(!!buttonAncestor, 'panel button\'s parent has no parent of its own before disable() (test setup problem)');

      snapshot = {
        clockObj: inst._systemClock,
        clockSignalId: inst._signalId,
        settingsObj: inst._settings,
        settingsChangedId: inst._settingsChangedId,
        statusAreaKey: `${inst.metadata.name} Indicator`,
        buttonAncestor,
        buttonAncestorChildCountBefore: buttonAncestor.get_n_children(),
      };
      // NOTE: this._menu (a PopupMenu.PopupMenu instance) is NOT a
      // GObject.signal_handler_is_connected()-compatible object in this
      // GNOME Shell version -- popupMenu.js's menu classes use the
      // plain-JS Signals mixin (the same reason extension.js itself uses
      // explicit connect-id/disconnect() rather than connectObject() for
      // dnd.js's _Draggable, per its own comment on _clearRowDraggables()).
      // Verified empirically: passing it here raised "is not a subclass of
      // GObject_Object". The 'open-state-changed' handler's teardown is
      // instead verified at the JS-bookkeeping level below (this._menu and
      // this._menuOpenStateId both null after disable()) plus the source
      // fact that disable() calls `this._menu.disconnect(this._menuOpenStateId)`
      // unconditionally before nulling it -- see extension.js.
      assertTrue(
        GObject.signal_handler_is_connected(snapshot.clockObj, snapshot.clockSignalId),
        'WallClock signal was not connected before disable() (test setup problem, not a real failure)'
      );
      assertTrue(
        GObject.signal_handler_is_connected(snapshot.settingsObj, snapshot.settingsChangedId),
        'GSettings "changed" signal was not connected before disable() (test setup problem, not a real failure)'
      );
    });

    record('teardown: extensionManager.disableExtension(target) runs the real disable() on the real instance', () => {
      const ok = extMgr.disableExtension(targetUuid);
      assertTrue(ok === true, `disableExtension returned ${ok}`);
    });

    record('teardown: no leaked GObject signal handlers after disable() -- WallClock and GSettings', () => {
      // g_signal_handler_is_connected() is the real, GObject-level proof
      // that the handler id extension.js tracked was actually disconnected
      // (not merely that the JS-side bookkeeping field was set to null).
      assertFalse(
        GObject.signal_handler_is_connected(snapshot.clockObj, snapshot.clockSignalId),
        'WallClock notify::clock handler is still connected after disable()'
      );
      assertFalse(
        GObject.signal_handler_is_connected(snapshot.settingsObj, snapshot.settingsChangedId),
        'GSettings "changed" handler is still connected after disable()'
      );
    });

    record('teardown: every enable()-assigned instance field is nulled after disable()', () => {
      [
        '_button', '_label', '_menu', '_activeMenu', '_inactiveMenu', '_configMenu',
        '_state', '_settings', '_config', '_hint', '_labels', '_aliases',
        '_activeOrder', '_stateByZone', '_configSwitches', '_dropIndicator',
        '_rowDraggables', '_separatorId', '_formatting', '_formattingDefaults',
        '_separatorMenuItems', '_fontSizeMenuItems', '_colorMenuItems',
        '_signalId', '_settingsChangedId', '_menuOpenStateId',
      ].forEach((field) => {
        assertTrue(inst[field] === null, `${field} is not null after disable(): ${JSON.stringify(inst[field])}`);
      });
    });

    record('teardown: the panel status-area entry no longer references the destroyed indicator', () => {
      assertTrue(!Main.panel.statusArea[snapshot.statusAreaKey], 'status area still references the destroyed button');
    });

    record('teardown: the panel button was actually removed from its parent -- verified via the PARENT\'s own child count, never by touching the destroyed button itself', () => {
      // karen-gate finding 2: the previous version of this test called
      // `snapshot.button.get_parent()` AFTER disable() had already
      // destroyed the button -- undefined-behavior access to a disposed
      // GObject. This emitted a real
      // `Gjs-CRITICAL **: Object ... has been already disposed --
      // impossible to access it` line on EVERY run, and the assertion
      // only "passed" because that disposed-object read happened to
      // return null -- exactly the "signal is an absence, and the absence
      // came from touching something already gone" pattern this phase
      // keeps finding. Fixed to never reference the destroyed button
      // object again at all: `snapshot.buttonParent` (captured while
      // still alive, above) is a real, still-valid actor throughout this
      // extension's lifetime (it's shell-managed panel chrome, not
      // anything this extension owns or destroys), and its own
      // `get_n_children()` going down by exactly one is a positive,
      // observable fact about a LIVE object -- proof the button was
      // really removed, not an absence read off a disposed one. Uses the
      // GRANDPARENT (see the snapshot-setup comment above for why not the
      // immediate parent): a per-indicator wrapper actor one level closer
      // to the button is not reliably alive this long after disable(),
      // which is exactly the same disposed-object risk this fix exists to
      // eliminate -- one level further up is GNOME Shell's own persistent
      // panel box, never destroyed during normal enable/disable.
      const countAfter = snapshot.buttonAncestor.get_n_children();
      assertEqual(
        countAfter,
        snapshot.buttonAncestorChildCountBefore - 1,
        `expected the panel's child count to decrease by exactly 1 after disable() (before=${snapshot.buttonAncestorChildCountBefore}, after=${countAfter})`
      );
    });

    record('teardown: system clock visibility is restored after disable() (this run genuinely hid it first -- see the "config:" test above)', () => {
      // No `!clockDisplay ||` shortcut here (karen-gate audit finding):
      // that would pass vacuously if clockDisplay were ever falsy, without
      // having proven anything. Its existence is already established as a
      // hard requirement by the "config: toggling ... Hide system clock"
      // test above, which also genuinely drove _hidSystemClock to true
      // before this disable() ran -- so this assertion now exercises the
      // real restore branch in disable(), not a code path that was simply
      // never triggered.
      const clockDisplay = Main.panel.statusArea.dateMenu?._clockDisplay;
      assertTrue(!!clockDisplay, 'no real dateMenu._clockDisplay in this environment');
      assertTrue(clockDisplay.visible === true, 'system clock is still hidden after disable()');
    });

    await recordAsync('teardown: three further enable/disable cycles stay clean and reusable, with no accumulating signal leaks', async () => {
      for (let i = 0; i < 3; i++) {
        const ok1 = extMgr.enableExtension(targetUuid);
        assertTrue(ok1 === true, `cycle ${i}: enableExtension returned ${ok1}`);

        const meta2 = await waitUntil(() => {
          const m = extMgr.lookup(targetUuid);
          return m && m.stateObj ? m : null;
        });
        assertTrue(!!meta2, `cycle ${i}: stateObj never reappeared after re-enable`);
        const inst2 = meta2.stateObj;

        inst2._updateLabel();
        assertTrue(/\S/.test(inst2._label.clutter_text.get_text()), `cycle ${i}: panel text is empty after re-enable`);

        const clockObj2 = inst2._systemClock;
        const clockId2 = inst2._signalId;
        const settingsObj2 = inst2._settings;
        const settingsId2 = inst2._settingsChangedId;

        const ok2 = extMgr.disableExtension(targetUuid);
        assertTrue(ok2 === true, `cycle ${i}: disableExtension returned ${ok2}`);

        assertFalse(GObject.signal_handler_is_connected(clockObj2, clockId2), `cycle ${i}: WallClock handler leaked`);
        assertFalse(GObject.signal_handler_is_connected(settingsObj2, settingsId2), `cycle ${i}: GSettings handler leaked`);
        assertTrue(inst2._button === null, `cycle ${i}: _button not nulled after disable()`);
      }
    });

    this._writeResults(results);
  }

  _writeResults(results) {
    const path = GLib.getenv('TZSHELL_RESULT_PATH');
    if (!path) {
      console.error('shell-driver@tests.local: TZSHELL_RESULT_PATH is not set -- cannot write results');
      return;
    }

    const failed = results.filter((r) => !r.pass).length;
    const payload = {
      total: results.length,
      passed: results.length - failed,
      failed,
      results,
    };

    try {
      GLib.file_set_contents(path, JSON.stringify(payload, null, 2));
    } catch (e) {
      console.error(`shell-driver@tests.local: failed to write results to ${path}: ${e}`);
    }
  }
}
