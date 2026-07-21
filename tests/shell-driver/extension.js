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
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';

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
    // driver's own install dir. Dynamically importing formatting.js FROM
    // THAT REAL COPY means this driver can never silently drift from the
    // real sanitizer/serializer behavior it is asserting against.
    //
    // KAREN-GATE FIX (round 4): formattingPresets.js used to be imported
    // here too (its FONT_SIZE_PRESETS/COLOR_PALETTE backed the popup
    // menu's "Font size"/"Color" preset submenus). Those submenus are
    // permanently gone (see extension.js's comment on the
    // this._separatorMenuItems field in the constructor) and
    // formattingPresets.js was removed as a module nothing imports any
    // more -- see tests/run-shell-tests.sh's copy list, which no longer
    // includes it either.
    let targetModules = null;
    await recordAsync('setup: dynamically import the REAL target formatting.js', async () => {
      const targetDir = `${GLib.path_get_dirname(this.path)}/${targetUuid}`;
      const formatting = await import(`file://${targetDir}/formatting.js`);
      targetModules = { ...formatting };
      assertTrue(typeof targetModules.parseFormatting === 'function', 'parseFormatting not found in imported formatting.js');
    });

    // Date feature: same dynamic-import-from-the-real-copy convention as
    // formatting.js above, merged into the same targetModules object so
    // every date-feature test below can cross-check against the REAL
    // resolveDateFormat()/formatDateForDisplay() (dateFormats.js) rather
    // than reimplementing that logic.
    await recordAsync('setup: dynamically import the REAL target dateFormats.js', async () => {
      const targetDir = `${GLib.path_get_dirname(this.path)}/${targetUuid}`;
      const dateFormats = await import(`file://${targetDir}/dateFormats.js`);
      targetModules = { ...targetModules, ...dateFormats };
      assertTrue(typeof targetModules.resolveDateFormat === 'function', 'resolveDateFormat not found in imported dateFormats.js');
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

    // ROOT CAUSE of a Clutter-CRITICAL NaN allocation once wrongly blamed
    // on this extension's own menu structure (karen-gate finding 2, then
    // its justification found false by a SECOND karen-gate pass -- see
    // below): the crash
    // (`clutter_actor_set_allocation_internal: assertion '!isnan(...)'
    // failed`, an internal BoxPointer arrow/shadow actor tried to
    // allocate `-2147483648.00 x -2147483648.00`) reproduces on whichever
    // `PopupMenu.open()` call is the very FIRST one executed in a
    // freshly-started headless gnome-shell process, REGARDLESS of which
    // menu it is or what that menu contains.
    //
    // REPRODUCTION METHOD AND COUNTS (re-measured again in round 4, after
    // restoring the three bold switches to the popup -- do not restate
    // old counts without re-running this exact comparison first, this has
    // already been wrong twice in this project's history): starting from
    // the CURRENT round-4 extension.js (three bold switches back in the
    // popup, this file's own per-submenu rendering + bold-switch
    // assertions further below all pass), run tests/run-shell-tests.sh
    // six consecutive times with this warm-up block PRESENT, then six
    // consecutive times with it REMOVED, counting how many of each batch
    // of six show a `Clutter-CRITICAL` hit in the shell log scan:
    //   - warm-up REMOVED (this extension's own `inst._menu.open()` is
    //     then the first BoxPointer open in the process): 6 of 6 runs
    //     reproduced the CRITICAL (4 distinct occurrences per run --
    //     round 4 opens the real top-level menu 4 separate times across
    //     its assertions, one more menu-open site than round 3 had).
    //   - warm-up PRESENT (this block runs first): 0 of 6 runs
    //     reproduced it (3 of those six runs measured immediately after
    //     the 6/6-without-warm-up batch above; the round-3 measurement
    //     this replaces was 5/6 without, 0/6 with -- round 4's is, if
    //     anything, a STRONGER reproduction rate without the warm-up,
    //     making it even less safe to remove than previously measured).
    // This is a test-harness ordering artifact (this shell-driver is the
    // first code in the whole process to ever open a real,
    // BoxPointer-positioned popup at all), not a defect in extension.js's
    // menu construction -- so the fix belongs here, in the driver, not as
    // a log-scanner allowlist and not as a change to extension.js. If
    // this warm-up block is ever removed as "apparently redundant",
    // re-run this exact comparison before assuming it is safe to delete
    // -- it is not redundant based on every measurement taken so far,
    // across two separate rounds of re-verification.
    await recordAsync('setup: warm up GNOME Shell\'s BoxPointer positioning via the native dateMenu BEFORE any of our own menu opens below (see the root-cause comment above)', async () => {
      const dateMenu = Main.panel.statusArea.dateMenu;
      assertTrue(!!dateMenu, 'no real dateMenu status area indicator in this environment');
      dateMenu.menu.open(BoxPointer.PopupAnimation.NONE);
      await waitUntil(() => dateMenu.menu.isOpen === true);
      await sleep(300);
      assertTrue(dateMenu.menu.isOpen === true, 'native dateMenu did not open during BoxPointer warm-up');
      dateMenu.menu.close(BoxPointer.PopupAnimation.NONE);
      await sleep(200);
    });

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

    record(
      "panel: this._button, this._label, AND every OTHER child actor under this._button (whatever it is, tracked on `inst` or not) has a REAL, non-NaN allocation -- regression guard for an unpositioned-child Clutter-WARNING (karen-gate finding: an earlier colour-probe actor added as a child of this._button, which uses Clutter.FixedLayout, without an explicit position/size, never received a real allocation at all -- measured directly as x1=NaN x2=NaN y1=NaN y2=NaN -- and spammed 'Can't update stage views ... needs an allocation' into the journal on every run, unnoticed because the log scanner at the time only matched one specific Clutter-WARNING message text). Walking get_children() rather than only checking known fields means this catches ANY future unpositioned child, not just a reintroduction of this exact one.",
      () => {
        const assertValidAllocation = (actor, name) => {
          assertTrue(!!actor, `${name} does not exist`);
          const box = actor.get_allocation_box();
          const finite = Number.isFinite(box.x1) && Number.isFinite(box.y1) && Number.isFinite(box.x2) && Number.isFinite(box.y2);
          assertTrue(finite, `${name}'s allocation box is not finite -- x1=${box.x1} y1=${box.y1} x2=${box.x2} y2=${box.y2}`);
        };
        assertValidAllocation(inst._button, 'this._button');
        assertValidAllocation(inst._label, 'this._label');
        const children = inst._button.get_children();
        assertTrue(children.length > 0, 'this._button has no children at all -- unexpected, cannot walk its child allocations');
        children.forEach((child, i) => assertValidAllocation(child, `this._button's child #${i} (${child.constructor?.name ?? '?'})`));
      }
    );

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

    const hexOfThemeNode = (actor) => {
      const c = actor.get_theme_node().get_foreground_color();
      const toHex = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
      return `#${toHex(c.red)}${toHex(c.green)}${toHex(c.blue)}`;
    };

    await recordAsync(
      "panel: _refreshAmbientForegroundColorHex()'s clear/read/reapply sequence on this._label ITSELF (not this._button) correctly tracks a TYPE-TARGETED theme rule (karen-gate finding: this._button's theme node does NOT track a rule that selects `StLabel` specifically, only this._label's own does)",
      async () => {
        const ctx = St.ThemeContext.get_for_stage(global.stage);
        const theme = ctx.get_theme();
        const cssPath = GLib.build_filenamev([GLib.get_tmp_dir(), `tzshell-typed-${GLib.DateTime.new_now_local().to_unix()}.css`]);
        const file = imports.gi.Gio.File.new_for_path(cssPath);
        let stylesheetLoaded = false;

        try {
          const buttonBefore = hexOfThemeNode(inst._button);
          const labelBefore = hexOfThemeNode(inst._label);
          const ambientBefore = inst._ambientForegroundColorHex;
          assertEqual(buttonBefore, labelBefore, 'baseline: button and label do not already agree before the theme change -- cannot assert this test at all');
          assertEqual(ambientBefore, labelBefore, "baseline: inst._ambientForegroundColorHex does not match this._label's own resolved colour before the theme change");

          // A real, plausible theme rule that targets label text
          // SPECIFICALLY by type, the ordinary way a real GNOME theme
          // would give a top-bar indicator's text its own colour
          // distinct from the button chrome around it -- NOT the `*`
          // selector used by the separate test below, which colours
          // everything uniformly and structurally cannot expose this
          // class of divergence.
          GLib.file_set_contents(cssPath, 'StLabel { color: #abcdef !important; }');
          stylesheetLoaded = theme.load_stylesheet(file);
          assertTrue(stylesheetLoaded === true, 'theme.load_stylesheet() returned false -- could not drive a real theme change in this sandbox');

          // inst's own real this._label 'style-changed' handler (wired
          // in enable()) is what should pick this up -- no manual poke
          // of inst's internals here, just waiting for the real pipeline.
          await waitUntil(() => inst._ambientForegroundColorHex !== ambientBefore, 500, 25);

          const buttonAfter = hexOfThemeNode(inst._button);
          const labelAfter = hexOfThemeNode(inst._label);

          // The control that proves this test actually discriminates:
          // this._button must NOT have tracked the type-targeted rule
          // (it only matches `StLabel`) -- if it did, this test's own
          // premise would be wrong and it would be testing nothing.
          assertEqual(buttonAfter, buttonBefore, "control failed: this._button's theme node tracked a `StLabel`-targeted rule -- this test's premise (button and label CAN diverge) does not hold in this environment");

          assertEqual(labelAfter, '#abcdef', "this._label's own theme node did not track the real theme change");
          assertEqual(
            inst._ambientForegroundColorHex,
            '#abcdef',
            'inst._ambientForegroundColorHex did not pick up the type-targeted theme change -- it is still tracking a stale/wrong source'
          );

          // The actual clear/read/reapply sequencing, exercised through
          // the REAL internal methods (not a reimplementation): simulate
          // an active first-entry override, force a refresh, and confirm
          // (a) the refreshed ambient value is the correct uncontaminated
          // one, not the override, and (b) the override itself is left
          // genuinely restored afterwards (the panel's visible state is
          // unaffected by this call).
          inst._setLabelStyle('color: #112233;');
          inst._refreshAmbientForegroundColorHex();
          assertEqual(
            inst._ambientForegroundColorHex,
            '#abcdef',
            '_refreshAmbientForegroundColorHex() picked up the simulated inline override (#112233) instead of the real ambient theme colour -- the clear-before-read sequencing is broken'
          );
          assertEqual(inst._label.get_style(), 'color: #112233;', '_refreshAmbientForegroundColorHex() did not correctly reapply the saved inline style afterwards');
          inst._setLabelStyle(null);
        } finally {
          if (stylesheetLoaded) {
            try {
              theme.unload_stylesheet(file);
            } catch (e) {
              // best-effort
            }
          }
          GLib.unlink(cssPath);
          inst._setLabelStyle(null);
          await waitUntil(() => hexOfThemeNode(inst._label) !== '#abcdef', 500, 25);
          inst._refreshAmbientForegroundColorHex();
          inst._updateLabel();
        }
      }
    );

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

    // =====================================================================
    // 1b. First-entry colour bug (live-testing report): the FIRST panel
    // entry's colour -- both a global default and a per-zone override --
    // never actually rendered, while every other entry was fine.
    //
    // Root cause (confirmed against a real GNOME Shell/Clutter/Pango
    // render, not inferred): gnome-shell's own src/st/st-private.c
    // (_st_set_text_from_style()) installs a whole-text (start=0,
    // end=G_MAXUINT) base FOREGROUND Pango attribute on every style pass,
    // via ClutterText's own priv->attrs (clutter_text_set_attributes()).
    // mutter's clutter/clutter/clutter-text.c
    // (clutter_text_ensure_effective_attributes()) merges that base
    // attribute on TOP of the markup-parsed attribute list, and -- since
    // Pango resolves overlapping same-type attributes by "last attribute
    // in the list wins" -- St's own base FOREGROUND always ends up
    // sorting AFTER any markup <span foreground> that ALSO starts at
    // byte offset 0 (i.e. specifically the FIRST rendered entry). Every
    // later entry is naturally immune since its span's start_index is
    // never 0.
    //
    // The karen-gate blind spot this closes: every PRE-EXISTING
    // "Pango.parse_markup() oracle" assertion in this file (e.g. the
    // "per-zone formatting override" test above) validates the MARKUP
    // STRING in isolation, independent of ClutterText -- and the string
    // itself IS perfectly valid, with a correctly-scoped foreground span
    // for every entry (this bug is invisible to that oracle). None of
    // them ever inspected what ClutterText/Pango actually resolve to use
    // at PAINT time (via the real PangoLayout + Pango.AttrIterator,
    // exactly like pango-renderer.c itself does), which is the only place
    // this bug is observable. The assertions below close that gap.
    //
    // winningForegroundHexAt()/winningWeightAt()/winningSizeAt() below
    // replicate pango_attr_iterator_get() at a specific byte offset --
    // the exact API Pango's own renderer uses to resolve "which attribute
    // of this type is actually in effect here" -- against the REAL
    // ClutterText layout obtained via a real _updateLabel() call, so
    // these assertions can only pass if the real render, not just the
    // assembled string, is correct.

    function winningAttrAt(item_, byteOffset, attrType) {
      const layout = item_._label.clutter_text.get_layout();
      const iter = layout.get_attributes().get_iterator();
      do {
        const [s, e] = iter.range();
        if (s <= byteOffset && byteOffset < e) {
          return iter.get(attrType);
        }
      } while (iter.next());
      return null;
    }

    function winningForegroundHexAt(item_, byteOffset) {
      const attr = winningAttrAt(item_, byteOffset, Pango.AttrType.FOREGROUND);
      if (!attr) return null;
      const c = attr.as_color().color;
      const hex = (v) => Math.round((v / 65535) * 255)
        .toString(16)
        .padStart(2, '0');
      return `#${hex(c.red)}${hex(c.green)}${hex(c.blue)}`;
    }

    function winningWeightAt(item_, byteOffset) {
      const attr = winningAttrAt(item_, byteOffset, Pango.AttrType.WEIGHT);
      return attr ? attr.as_int().value : null;
    }

    function winningSizeAt(item_, byteOffset) {
      const attr = winningAttrAt(item_, byteOffset, Pango.AttrType.SIZE);
      return attr ? attr.as_size().size : null;
    }

    // The fix's first-entry workaround routes entry 1's colour through
    // the WIDGET's own 'color' CSS style (see extension.js's
    // _updateLabel() comment) rather than a markup <span> -- the same
    // path gnome-shell itself uses for every themed St.Label everywhere.
    // gnome-shell's own src/st/st-private.c
    // (_st_set_text_from_style()) converts the theme's 0-255 colour
    // components to Pango's 16-bit scale via "* 255" instead of the
    // colour-accurate "* 257" (255*255=65025, not 65535), a harmless,
    // universal, ~0.8%-per-channel rounding quirk that is NOT specific
    // to this extension and not something extension.js can control --
    // it affects every St widget's CSS-driven text colour identically.
    // Entries other than the first go through Pango's own markup parser
    // instead (exact, no such rounding), so this tolerance is ONLY
    // needed for entry-1 assertions, never for the "no leak" control
    // (which reads back via the same theme-node accessor as the fix
    // itself, so it stays exact).
    function assertColorCloseTo(actualHex, expectedHex, message) {
      assertTrue(!!actualHex && !!expectedHex, `${message} (actual=${JSON.stringify(actualHex)} expected=${JSON.stringify(expectedHex)})`);
      const toRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      const [ar, ag, ab] = toRgb(actualHex);
      const [er, eg, eb] = toRgb(expectedHex);
      const TOLERANCE = 4;
      const close = Math.abs(ar - er) <= TOLERANCE && Math.abs(ag - eg) <= TOLERANCE && Math.abs(ab - eb) <= TOLERANCE;
      assertTrue(close, `${message}: got ${actualHex}, expected ~${expectedHex} (within ${TOLERANCE}/channel)`);
    }

    record(
      'panel: a GLOBAL DEFAULT colour genuinely renders on the FIRST entry (not just in the assembled markup string) -- the real ClutterText/Pango render, via Pango.AttrIterator, the same resolution mechanism pango-renderer.c itself uses',
      () => {
        const nyItem = inst._stateByZone.get('America/New_York');
        const beforeDefaults = targetModules.parseFormatting(inst._settings.get_string('formatting-defaults'));
        try {
          inst._toggleTimezone(nyItem);
          assertEqual(inst._activeOrder, ['UTC', 'America/New_York']);

          inst._settings.set_string(
            'formatting-defaults',
            targetModules.serializeFormatting({ ...beforeDefaults, color: '#ff0000', size: 0, boldCity: false, boldTime: false, boldZone: false })
          );
          inst._loadSettings();
          inst._updateLabel();

          // Position 0 is always inside the first entry's own text (its
          // markup span, if the bug is fixed, or lost to the theme's
          // base colour if it is not).
          assertColorCloseTo(
            winningForegroundHexAt(inst, 0),
            '#ff0000',
            'the FIRST entry does not actually render its configured global-default colour (the exact live-testing report)'
          );

          // Control: the LAST entry, which was never affected by this
          // bug, must still work -- proves this assertion technique
          // itself is discriminating (not just "always passes"/vacuous),
          // and proves the fix did not regress the entries that already
          // worked.
          const fullText = inst._label.clutter_text.get_text();
          const lastEntryStart = fullText.lastIndexOf('New York');
          assertTrue(lastEntryStart > 0, `could not locate the second entry inside the rendered text: ${JSON.stringify(fullText)}`);
          assertEqual(
            winningForegroundHexAt(inst, lastEntryStart),
            '#ff0000',
            'control failed: the LAST entry (never affected by this bug) does not render its configured colour either -- the assertion technique itself is broken'
          );
        } finally {
          // Always restore state, even on assertion failure, so later
          // tests are not cascade-broken by this one.
          if (inst._activeOrder.includes('America/New_York')) {
            inst._toggleTimezone(nyItem);
          }
          inst._settings.set_string('formatting-defaults', targetModules.serializeFormatting(beforeDefaults));
          inst._loadSettings();
          inst._updateLabel();
        }
      }
    );

    record(
      'panel: a PER-ZONE colour override on ONLY the first zone genuinely renders on that entry, and does NOT leak into a second zone that has no colour of its own',
      () => {
        const nyItem = inst._stateByZone.get('America/New_York');
        try {
          inst._toggleTimezone(nyItem);
          assertEqual(inst._activeOrder, ['UTC', 'America/New_York']);

          // A real per-zone override, on the FIRST zone only -- exactly
          // the live-testing report's other reproduction case.
          // America/New_York deliberately gets NO override of its own,
          // so it must keep showing the theme's own default colour, not
          // UTC's override -- this is the specific regression risk of
          // any fix that works by repurposing the widget's ambient/base
          // colour to match the first entry.
          const blob = JSON.stringify({ size: 0, color: '#00ff00', boldCity: false, boldTime: false, boldZone: false });
          inst._settings.set_value('formatting', new GLib.Variant('a{ss}', { UTC: blob }));
          inst._loadSettings();
          inst._updateLabel();

          assertColorCloseTo(
            winningForegroundHexAt(inst, 0),
            '#00ff00',
            'the FIRST entry does not actually render its configured PER-ZONE override colour'
          );

          const fullText = inst._label.clutter_text.get_text();
          const secondEntryStart = fullText.lastIndexOf('New York');
          assertTrue(secondEntryStart > 0, `could not locate the second entry inside the rendered text: ${JSON.stringify(fullText)}`);

          const themeColorHex = inst._ambientForegroundColorHex;
          assertTrue(!!themeColorHex, 'inst._ambientForegroundColorHex is empty -- cannot assert the no-leak control');
          assertEqual(
            winningForegroundHexAt(inst, secondEntryStart),
            themeColorHex,
            "the SECOND entry (no colour override of its own) rendered the FIRST entry's colour instead of the theme default -- the fix leaked the override into an unrelated entry"
          );
        } finally {
          if (inst._activeOrder.includes('America/New_York')) {
            inst._toggleTimezone(nyItem);
          }
          inst._settings.set_value('formatting', new GLib.Variant('a{ss}', {}));
          inst._loadSettings();
          inst._updateLabel();
        }
      }
    );

    record(
      'panel: bold AND font-size on the FIRST entry still resolve correctly at real render time (regression guard: this collision mechanism is FOREGROUND-specific -- proven not to affect WEIGHT/SIZE -- but this asserts it stays that way rather than assuming it)',
      () => {
        const nyItem = inst._stateByZone.get('America/New_York');
        const beforeDefaults = targetModules.parseFormatting(inst._settings.get_string('formatting-defaults'));
        try {
          inst._toggleTimezone(nyItem);
          assertEqual(inst._activeOrder, ['UTC', 'America/New_York']);

          inst._settings.set_string(
            'formatting-defaults',
            targetModules.serializeFormatting({ ...beforeDefaults, color: '', size: 20, boldCity: true, boldTime: false, boldZone: false })
          );
          inst._loadSettings();
          inst._updateLabel();

          // Position 0 (start of "UTC") -- the first entry's own city
          // segment, which is bold: WEIGHT must resolve to
          // PANGO_WEIGHT_BOLD (700), and SIZE must resolve to 20 points
          // (20 * 1024).
          assertEqual(winningWeightAt(inst, 0), 700, 'the FIRST entry does not render its configured bold weight');
          assertEqual(winningSizeAt(inst, 0), 20 * 1024, 'the FIRST entry does not render its configured font size');
        } finally {
          if (inst._activeOrder.includes('America/New_York')) {
            inst._toggleTimezone(nyItem);
          }
          inst._settings.set_string('formatting-defaults', targetModules.serializeFormatting(beforeDefaults));
          inst._loadSettings();
          inst._updateLabel();
        }
      }
    );

    await recordAsync(
      'panel: repeated ticks with a first-entry colour active do NOT progressively leak that colour into a colourless second entry (karen-gate finding: the fix used to poison itself on the very next _updateLabel() call)',
      async () => {
        const nyItem = inst._stateByZone.get('America/New_York');
        try {
          inst._toggleTimezone(nyItem);
          assertEqual(inst._activeOrder, ['UTC', 'America/New_York']);

          const blob = JSON.stringify({ size: 0, color: '#00ff00', boldCity: false, boldTime: false, boldZone: false });
          inst._settings.set_value('formatting', new GLib.Variant('a{ss}', { UTC: blob }));
          inst._loadSettings();

          const themeColorHex = inst._ambientForegroundColorHex;
          assertTrue(!!themeColorHex, 'inst._ambientForegroundColorHex is empty -- cannot assert this test at all');

          const fullText0 = inst._label.clutter_text.get_text();
          const secondEntryStart0 = fullText0.lastIndexOf('New York');
          assertTrue(secondEntryStart0 > 0, `could not locate the second entry: ${JSON.stringify(fullText0)}`);

          // Call _updateLabel() repeatedly with NOTHING else changing in
          // between -- exactly what an ordinary WallClock tick does
          // (only the time text differs) -- and re-assert BOTH entries
          // after every single call. The karen-gate bug reproduced on
          // call #2 specifically (baseline call #1 was always correct);
          // a third call is included in case the leak takes more than
          // one extra tick to fully manifest.
          for (let tick = 1; tick <= 3; tick++) {
            inst._updateLabel();

            assertColorCloseTo(
              winningForegroundHexAt(inst, 0),
              '#00ff00',
              `tick ${tick}: the FIRST entry lost its own configured colour`
            );

            const fullText = inst._label.clutter_text.get_text();
            const secondEntryStart = fullText.lastIndexOf('New York');
            assertTrue(secondEntryStart > 0, `tick ${tick}: could not locate the second entry: ${JSON.stringify(fullText)}`);
            assertEqual(
              winningForegroundHexAt(inst, secondEntryStart),
              themeColorHex,
              `tick ${tick}: the SECOND entry (no colour override of its own) rendered the FIRST entry's colour instead of the theme default -- the fix leaked across repeated ticks`
            );
          }
        } finally {
          if (inst._activeOrder.includes('America/New_York')) {
            inst._toggleTimezone(nyItem);
          }
          inst._settings.set_value('formatting', new GLib.Variant('a{ss}', {}));
          inst._loadSettings();
          inst._updateLabel();
        }
      }
    );

    await recordAsync(
      'panel: a real theme/stylesheet change (not a settings change) updates a colourless entry\'s rendered colour on the next render, rather than staying baked to the value resolved at an earlier tick',
      async () => {
        const nyItem = inst._stateByZone.get('America/New_York');
        const ctx = St.ThemeContext.get_for_stage(global.stage);
        const theme = ctx.get_theme();
        const cssPath = GLib.build_filenamev([GLib.get_tmp_dir(), `tzshell-theme-change-${GLib.DateTime.new_now_local().to_unix()}.css`]);
        const file = imports.gi.Gio.File.new_for_path(cssPath);
        let stylesheetLoaded = false;

        try {
          inst._toggleTimezone(nyItem);
          assertEqual(inst._activeOrder, ['UTC', 'America/New_York']);

          const blob = JSON.stringify({ size: 0, color: '#00ff00', boldCity: false, boldTime: false, boldZone: false });
          inst._settings.set_value('formatting', new GLib.Variant('a{ss}', { UTC: blob }));
          inst._loadSettings();
          inst._updateLabel();

          const ambientBefore = inst._ambientForegroundColorHex;
          assertTrue(!!ambientBefore, 'inst._ambientForegroundColorHex is empty -- cannot assert this test at all');

          const fullTextBefore = inst._label.clutter_text.get_text();
          const secondEntryStartBefore = fullTextBefore.lastIndexOf('New York');
          assertTrue(secondEntryStartBefore > 0, `could not locate the second entry: ${JSON.stringify(fullTextBefore)}`);
          assertEqual(
            winningForegroundHexAt(inst, secondEntryStartBefore),
            ambientBefore,
            'baseline: the second entry does not render the theme default before the theme change'
          );

          // A real, headless-drivable stylesheet reload -- '*' + !important
          // guarantees this beats whatever specificity the real panel
          // stylesheet uses for StLabel's colour, so this is a genuine
          // theme-level change, not a settings change on this extension.
          GLib.file_set_contents(cssPath, '* { color: #123456 !important; }');
          stylesheetLoaded = theme.load_stylesheet(file);
          assertTrue(stylesheetLoaded === true, 'theme.load_stylesheet() returned false -- could not drive a real theme change in this sandbox');

          // this._ambientForegroundColorHex is refreshed by the colour
          // probe's own 'style-changed' handler (see enable()), which
          // ALSO calls _updateLabel() itself -- but re-render explicitly
          // too, exactly like the next real WallClock tick would.
          await waitUntil(() => inst._ambientForegroundColorHex !== ambientBefore, 500, 25);
          inst._updateLabel();

          assertEqual(inst._ambientForegroundColorHex, '#123456', 'the ambient colour cache did not pick up the real theme change');

          const fullTextAfter = inst._label.clutter_text.get_text();
          const secondEntryStartAfter = fullTextAfter.lastIndexOf('New York');
          assertTrue(secondEntryStartAfter > 0, `could not locate the second entry after the theme change: ${JSON.stringify(fullTextAfter)}`);
          assertEqual(
            winningForegroundHexAt(inst, secondEntryStartAfter),
            '#123456',
            'the second entry (no colour override of its own) kept the STALE pre-theme-change colour instead of following the real theme change'
          );

          // The first entry's OWN explicit override must be unaffected by
          // the theme change -- it is a user setting, not ambient.
          assertColorCloseTo(winningForegroundHexAt(inst, 0), '#00ff00', "the first entry's own override changed when the theme changed");
        } finally {
          if (stylesheetLoaded) {
            try {
              theme.unload_stylesheet(file);
            } catch (e) {
              // best-effort
            }
          }
          GLib.unlink(cssPath);
          if (inst._activeOrder.includes('America/New_York')) {
            inst._toggleTimezone(nyItem);
          }
          inst._settings.set_value('formatting', new GLib.Variant('a{ss}', {}));
          inst._loadSettings();
          inst._updateLabel();
        }
      }
    );

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
    // 3. Formatting defaults (font size, color, 3 bold switches)
    //
    // KAREN-GATE FIX (round 3, then partially reverted by a round-4
    // product decision -- see extension.js's comment on the
    // this._separatorMenuItems field in the constructor for the full
    // round-1..4 history): "Font size" and "Color" preset submenus were
    // permanently removed from the popup menu (they remain fully
    // available via prefs.js's "Defaults" group, covered by
    // tests/run-prefs-tests.js's own real-GTK4/Adw widget suite -- a
    // DIFFERENT test file, testing the ACTUAL UI those controls now live
    // in exclusively, not duplicated here). The three bold switches,
    // however, were RESTORED to the popup in round 4 (they are plain
    // `PopupSwitchMenuItem` rows with no ScrollView of their own, so they
    // never had the nested-submenu defect that motivated removing "Font
    // size"/"Color") -- covered below via the REAL row's real 'toggled'
    // signal, exactly as they were before round 3.
    //
    // What this shell-driver still needs to cover for font size/color
    // specifically: that extension.js's READ side (_loadSettings() +
    // rendering) still correctly picks up and applies a
    // 'formatting-defaults' write made through the gsettings key
    // directly -- exactly the write shape prefs.js's real widgets
    // produce (serializeFormatting() into a single string key), not a
    // re-implementation of prefs.js's own widget-level tests. Sample
    // literal values are used directly (formattingPresets.js, which used
    // to supply curated preset values here, was removed as dead code
    // once its only caller -- the popup's own preset submenus -- was
    // gone; see extension.js's and this file's own module comments).

    record('formatting-defaults: a real gsettings write (shaped exactly like prefs.js\'s own serializeFormatting() write) for font size is picked up by _loadSettings()', () => {
      const before = targetModules.parseFormatting(inst._settings.get_string('formatting-defaults'));
      inst._settings.set_string('formatting-defaults', targetModules.serializeFormatting({ ...before, size: 20 }));
      inst._loadSettings();
      assertEqual(inst._formattingDefaults.size, 20, '_loadSettings() did not pick up the new font size default');
    });

    record('formatting-defaults: a real gsettings write for color is picked up by _loadSettings()', () => {
      const before = targetModules.parseFormatting(inst._settings.get_string('formatting-defaults'));
      inst._settings.set_string('formatting-defaults', targetModules.serializeFormatting({ ...before, color: '#3584e4' }));
      inst._loadSettings();
      assertEqual(inst._formattingDefaults.color, '#3584e4', '_loadSettings() did not pick up the new color default');
    });

    record('popup menu: toggling the real bold-city/bold-time/bold-zone switches writes all three formatting-defaults flags (restored round-4 popup wiring, not a config-key write)', () => {
      ['formattingBoldCity', 'formattingBoldTime', 'formattingBoldZone'].forEach((name) => {
        const entry = inst._configSwitches[name];
        assertTrue(!!entry, `no config switch tracked for "${name}" -- the bold switch was not added to the popup menu`);
        const before = Boolean(entry.getValue());
        entry.item.toggle(); // real PopupSwitchMenuItem method; emits 'toggled', which the real handler writes from
        const after = Boolean(entry.getValue());
        assertTrue(after === !before, `toggling "${name}" did not flip its value (before=${before}, after=${after})`);
      });

      const defaults = targetModules.parseFormatting(inst._settings.get_string('formatting-defaults'));
      assertTrue(defaults.boldCity === true, 'boldCity not persisted to the formatting-defaults gsetting');
      assertTrue(defaults.boldTime === true, 'boldTime not persisted to the formatting-defaults gsetting');
      assertTrue(defaults.boldZone === true, 'boldZone not persisted to the formatting-defaults gsetting');

      // KAREN-GATE requirement (task 1): must write 'formatting-defaults',
      // NOT the 'config' a{sb} key -- proven directly, not just inferred
      // from the value above, by checking the real 'config' gsetting's
      // own keys never gained any of these three names.
      const configKeys = Object.keys(inst._settings.get_value('config').deep_unpack());
      assertTrue(!configKeys.includes('formattingBoldCity'), '"formattingBoldCity" leaked into the "config" a{sb} key');
      assertTrue(!configKeys.includes('formattingBoldTime'), '"formattingBoldTime" leaked into the "config" a{sb} key');
      assertTrue(!configKeys.includes('formattingBoldZone'), '"formattingBoldZone" leaked into the "config" a{sb} key');
    });

    await recordAsync(
      'popup menu: the "Bold city" switch re-syncs its real visual state via the real _syncConfigSwitches()/reentrancy-guard path when formatting-defaults changes externally (e.g. a real prefs.js write from a separate process)',
      async () => {
        // Simulates exactly what happens when prefs.js (a separate
        // process) writes 'formatting-defaults': the real 'changed'
        // GSettings signal fires, which -- per enable()'s real handler --
        // sets this._applyingExternalSettings, calls the real
        // _loadSettings(), _syncConfigSwitches(), and _syncMenuControls(),
        // then clears the guard. Driven here by writing the gsetting
        // directly (the same real signal path a real prefs.js write would
        // trigger) rather than calling any of those methods directly, so
        // this proves the whole wired-together path, not just one method
        // in isolation.
        const entry = inst._configSwitches.formattingBoldCity;
        assertTrue(!!entry, 'no "formattingBoldCity" config switch tracked');

        const before = targetModules.parseFormatting(inst._settings.get_string('formatting-defaults'));
        assertTrue(before.boldCity === true, 'test setup problem: expected boldCity already true from the toggle test above');
        assertTrue(entry.item.state === true, 'test setup problem: the real switch\'s visual state does not already match boldCity=true');

        try {
          inst._settings.set_string('formatting-defaults', targetModules.serializeFormatting({ ...before, boldCity: false }));
          // The 'changed' signal is delivered asynchronously by
          // GSettings/dconf (even with the memory backend); poll for the
          // REAL switch's own visual state (`.item.state`, not just the
          // stored value) to actually flip, rather than assuming
          // synchronous delivery or trusting the stored value alone --
          // this is the switch's own setToggleState()-driven state, proof
          // the sync actually reached the widget, not just gsettings.
          const flipped = await waitUntil(() => entry.item.state === false, 2000);
          assertTrue(flipped === true, 'the real "Bold city" switch never visually flipped to OFF after an external formatting-defaults write -- external resync is broken');
          assertTrue(inst._formattingDefaults.boldCity === false, '_loadSettings() did not pick up the external boldCity=false write');
        } finally {
          // Restore boldCity=true (its state going into this test) so
          // later tests -- including the "rendering reflects..." markup
          // test immediately below, which assumes boldCity/boldTime are
          // both true -- see the same state they would have without this
          // test ever running.
          const current = targetModules.parseFormatting(inst._settings.get_string('formatting-defaults'));
          inst._settings.set_string('formatting-defaults', targetModules.serializeFormatting({ ...current, boldCity: true }));
          await waitUntil(() => entry.item.state === true, 2000);
        }
      }
    );

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
    // 3b. Popup menu: the "Separator" submenu actually RENDERS (not just
    //     exists in the object graph) when the real popup menu is opened
    //     for real -- at THIS run's virtual-monitor resolution, both with
    //     the default (2-zone) active list and with ~10 active zones.
    //
    // BUG (live-testing report, GNOME Shell 47/x11 -- 3 rounds; see
    // extension.js's comment on the this._separatorMenuItems field in the
    // constructor for the full history of all three):
    //   Round 1: nested-ScrollView (submenu inside `_configMenu`'s own
    //     ScrollView) collapsed it to ~2px. Fixed by moving it to
    //     `this._menu` directly.
    //   Round 2: a SECOND nested-ScrollView, one level deeper ("Font
    //     size"/"Color" inside a "Formatting" wrapper submenu). Fixed by
    //     flattening -- no PopupSubMenuMenuItem nested inside another.
    //   Round 3 (karen-gate finding): flattening made total popup content
    //     tall enough that on real small-but-common screens (1280x720,
    //     1024x768) it no longer fit GNOME Shell's own top-level
    //     available-height budget, squeezing EVERY scrollable section
    //     (not just submenus) to near-zero. Fixed by removing "Font
    //     size"/"Color"/the 3 bold switches from the popup entirely (they
    //     remain in prefs.js) -- "Separator" is the only submenu left.
    //
    // Every pre-existing assertion earlier in this file (e.g. "separator
    // submenu was built with a row for every curated id", "emitting
    // 'activate' on the real 'pipe' separator row...") only proves a row
    // EXISTS and can receive a synthetic 'activate' signal -- neither
    // requires the row (or its parent submenu) to ever have been
    // allocated any actual on-screen space. That is exactly why this bug
    // shipped three times. This test also runs across a real resolution
    // MATRIX (see tests/run-shell-tests.sh's VIRTUAL_MONITOR default and
    // tests/README.md's "Minimum supported screen height" section) --
    // this file itself only asserts against whatever resolution the
    // CURRENT sandboxed gnome-shell process was launched with; the matrix
    // sweep across resolutions happens one full sandboxed run per
    // resolution, driven by run-shell-tests.sh.
    //
    // The available on-screen height for an opened submenu genuinely
    // varies with screen size and with how many other real rows (active
    // zones, etc) are above it at open time -- observed anywhere from
    // ~46px to ~480px across repeated runs/resolutions of an
    // already-fixed build, all genuinely correct. So this deliberately
    // does NOT assert an exact height. What is NEVER supposed to vary,
    // fixed or not, is whether at least the FIRST row is actually
    // allocated enough of that space to be seen: a real, working (however
    // cropped) scrollable list always shows at least one full row; the
    // reported bug showed none at all. ROW_MIN_HEIGHT_PX (30) is
    // comfortably below every real row's actual height (36-41px,
    // measured during investigation) and comfortably above the ~2-6px
    // this bug collapsed to when reproduced against unfixed code (proven
    // below by reverting and re-running -- see the task report), so it
    // cleanly separates "genuinely collapsed" from "a real, if cropped,
    // scrollable list".
    const ROW_MIN_HEIGHT_PX = 30;

    const geom = (actor) => {
      if (!actor) {
        return { present: false, mapped: false, allocHeight: 0 };
      }
      const box = actor.get_allocation_box();
      return {
        present: true,
        visible: actor.visible,
        mapped: actor.mapped,
        hasStage: actor.get_stage() !== null,
        allocHeight: box.y2 - box.y1,
      };
    };

    // Shared by every submenu check below: opens the REAL top-level popup
    // (real BoxPointer positioning), finds `accessibleName` as a DIRECT
    // child of `inst._menu.box` (proving it is a flat, top-level sibling,
    // not nested inside some other submenu -- the exact structural
    // property round 2's bug violated), opens the real submenu, and
    // asserts the submenu's own actor/box AND `firstRowActor` are all
    // mapped with a real, non-collapsed on-screen height.
    const assertSubmenuRenders = async (label, accessibleName, firstRowActor) => {
      inst._menu.open(BoxPointer.PopupAnimation.NONE);
      await waitUntil(() => inst._menu.isOpen === true);
      await sleep(300);
      assertTrue(inst._menu.isOpen === true, 'top-level popup menu did not open');

      try {
        const item = inst._menu.box.get_children().find((c) => c.accessible_name === accessibleName);
        assertTrue(!!item, `"${label}" submenu item not found as a direct (flat, top-level) child of the top-level menu box`);
        assertTrue(typeof item.menu === 'object' && item.menu !== null, `"${label}" is not a PopupSubMenuMenuItem (no .menu)`);

        item.menu.open(false);
        await sleep(300);

        const submenuActor = geom(item.menu.actor);
        const submenuBox = geom(item.menu.box);
        const firstRow = geom(firstRowActor);

        assertTrue(submenuActor.mapped === true, `"${label}" submenu actor is not mapped (isOpen=${item.menu.isOpen}) -- it is not actually on screen`);
        assertTrue(
          submenuActor.allocHeight >= ROW_MIN_HEIGHT_PX,
          `"${label}" submenu actor collapsed to ${submenuActor.allocHeight}px -- this is the exact "empty submenu" bug signature (rows exist but the viewport is too small to show any of them)`
        );
        assertTrue(submenuBox.allocHeight >= ROW_MIN_HEIGHT_PX, `"${label}" submenu content box collapsed to ${submenuBox.allocHeight}px`);
        assertTrue(firstRow.mapped === true, `"${label}"'s first row is not mapped -- not actually on screen`);
        assertTrue(
          submenuActor.allocHeight >= firstRow.allocHeight - 1,
          `"${label}" submenu viewport (${submenuActor.allocHeight}px) is too short to show even its own first row (${firstRow.allocHeight}px) -- the row exists but nothing is visible`
        );

        item.menu.close(false);
      } finally {
        inst._menu.close(BoxPointer.PopupAnimation.NONE);
        await sleep(100);
      }
    };

    const assertControlRenders = () => {
      // Runs with the menu already closed -- re-open just long enough to
      // measure the control row, proving the geom()/mapped-based
      // technique itself produces a real positive reading for a row that
      // was never affected by the nested-ScrollView/total-height bugs (it
      // lives directly in _configMenu, which is not itself nested inside
      // anything and does not grow with the active-zone count).
      inst._menu.open(BoxPointer.PopupAnimation.NONE);
      try {
        const control = geom(inst._configSwitches.format24.item);
        assertTrue(control.mapped === true, 'control switch ("24 hours format") is not mapped -- the measurement technique itself is not working in this environment');
        assertTrue(control.allocHeight >= ROW_MIN_HEIGHT_PX, `control switch collapsed to ${control.allocHeight}px -- the measurement technique itself is unreliable here`);
      } finally {
        inst._menu.close(BoxPointer.PopupAnimation.NONE);
      }
    };

    await recordAsync(
      'popup menu: opening the real popup + real "Separator" submenu actually renders it with the DEFAULT (2-zone) active list -- the submenu\'s own actor is mapped with real, non-collapsed on-screen height, and its first row is genuinely visible within that allocated space (not just present in the object graph)',
      () => assertSubmenuRenders('Separator', 'Separator picker', inst._separatorMenuItems.spaces)
    );

    record(
      'popup menu CONTROL (default 2-zone list): a pre-existing, known-good config switch ("24 hours format") is mapped with real on-screen height right after opening the real popup',
      assertControlRenders
    );

    // =====================================================================
    // 3c. Live-toggle staleness fix: a config switch's 'toggled' handler
    // must refresh an already-open menu's REAL row actors immediately,
    // not just this._label (the panel) -- see _refreshVisibleTimeLabels()'s
    // own comment in extension.js for the full history (originally
    // surfaced via a now-removed menu-row date switch, but the fix is
    // general: format24/showCity/showTimezone all still change a row's
    // rendered TEXT). Verified below against REAL menu rows (this._activeMenu's
    // actual St.Label children, built by the real
    // _addActiveMenuRow()/_updateActiveMenu() -- not just
    // inst._getLabelForTimezone() called in isolation).
    // =====================================================================

    // Real menu-row text reader: mirrors how a genuine row is built in
    // _addActiveMenuRow() -- `${activeMark} ${item.label}` on an St.Label
    // child of the row (see that method's own `let label = new St.Label({
    // text: ... })` -- there is no other stable public accessor for a raw
    // row's rendered text). Reads the CURRENT St.Label actor's `.text`
    // directly (not `item.label` on the state object), so this proves what
    // was actually built into the popup, not just what extension.js
    // computed internally.
    const findActiveRowLabelText = (zone) => {
      const rows = inst._activeMenu.box.get_children().filter((c) => typeof c.acceptDrop === 'function');
      for (const row of rows) {
        const label = row.get_children().find((c) => c instanceof St.Label);
        if (label && label.text.includes(zone)) {
          return label.text;
        }
      }
      return null;
    };

    // These tests deliberately open the REAL menu once and keep it open
    // throughout, calling ONLY the real switch's `.toggle()` method and
    // then reading the REAL row actor's text straight away -- no
    // `inst._updateMenu()`/`inst._updateTimeLabels()` helper call
    // anywhere in between, exactly mirroring a real user click on an
    // already-open menu (see _refreshVisibleTimeLabels()'s own comment in
    // extension.js for why this matters: an earlier version of this fix
    // was only proven via a helper call that a real click never makes).
    record(
      'live-toggle staleness: opens the real menu before the live-toggle test below (kept open so it can prove no close/reopen is ever needed)',
      () => {
        assertTrue(
          inst._config.showHoverPopup === false,
          'test setup problem: showHoverPopup must be OFF for this whole section, so the row-refresh assertions below cannot be explained by the (unrelated, always-fresh) hover popup'
        );
        inst._menu.open(BoxPointer.PopupAnimation.NONE);
      }
    );

    record(
      'format24 feature (live user click, menu still open, NO explicit refresh call): toggling the real "24 hours format" switch OFF changes the real visible row\'s TIME shape IMMEDIATELY (12-hour AM/PM), proving a config-switch toggle refreshes an already-open menu\'s real row actors, not just the panel label',
      () => {
        const entry = inst._configSwitches.format24;
        assertTrue(!!entry, 'no "format24" config switch tracked -- the popup menu switch was not added');
        assertTrue(entry.getValue() === true, 'test setup problem: format24 should still be the schema default (true) entering this test');

        const before = findActiveRowLabelText('UTC');
        assertTrue(!!before, 'could not find the real UTC row to read its text from before toggling');
        assertFalse(/\b(AM|PM)\b/.test(before), `test setup problem: row already shows a 12-hour AM/PM time before toggling: ${JSON.stringify(before)}`);

        entry.item.toggle(); // real switch click; nothing else called before reading the row below

        assertTrue(entry.getValue() === false, 'toggling "24 hours format" did not flip its stored value');
        const configKeys = inst._settings.get_value('config').deep_unpack();
        assertTrue(configKeys.format24 === false, 'the real "config" gsetting does not have format24=false after toggling');

        const after = findActiveRowLabelText('UTC'); // no explicit inst._updateMenu()/inst._updateTimeLabels() call
        assertTrue(!!after, 'could not find the real UTC row to read its text from after toggling');
        assertTrue(
          /\b(AM|PM)\b/.test(after),
          `expected a 12-hour AM/PM time in the row text IMMEDIATELY after toggling "24 hours format" off, menu already open, no explicit refresh call: ${JSON.stringify(after)}`
        );

        // Round-trip back to the schema default so later sections (which
        // assume format24's default) are unaffected.
        entry.item.toggle();
        assertTrue(entry.getValue() === true, 'round-trip toggle back to format24=true did not flip its stored value');
        const restored = findActiveRowLabelText('UTC');
        assertFalse(/\b(AM|PM)\b/.test(restored), `expected the 24-hour time shape to be restored after toggling "24 hours format" back on: ${JSON.stringify(restored)}`);
      }
    );

    record('live-toggle staleness: closes the real menu opened above -- the format24 live-toggle test above ran with it open and no reopen', () => {
      inst._menu.close(BoxPointer.PopupAnimation.NONE);
    });

    // LAZY HOVER POPUP baseline (karen-gate finding): captured HERE,
    // right before section 3d's own tests -- NOT immediately after
    // enable() (measured directly: capturing it that early is
    // contaminated by GNOME Shell's own dateMenu warm-up a few tests
    // above, which lazily adds ITS OWN chrome to uiGroup the first time
    // any BoxPointer opens in this process, entirely unrelated to this
    // extension -- an earlier version of this baseline capture false-
    // failed for exactly that reason). By this point every earlier
    // section's one-time uiGroup-affecting setup has already happened,
    // and showHoverPopup is still false (schema default, never touched
    // yet), so this count reflects EXACTLY what a toggle-off state adds
    // to the real Main.layoutManager.uiGroup -- the same uiGroup state
    // HEAD (no hover-popup feature at all) would produce from this point
    // on. The "off by default" test below compares against this real
    // captured number rather than only asserting `inst._hoverPopup` is
    // falsy -- a leaked OTHER actor would not be caught by a falsy check
    // on our own field, but would move this count.
    const uiGroupChildCountAtEnable = Main.layoutManager.uiGroup.get_children().length;

    // =====================================================================
    // 3d. Hover popup ("Show dates on hover"): the harness cannot
    // synthesize real pointer-enter input (see the module doc comment and
    // tests/README.md's "Verification coverage" section -- the same
    // established limitation as pointer-driven DnD/AT-SPI input below),
    // so "hovering the mouse actually triggers this" is manual-only. Every
    // other real code path IS driven directly here: the real
    // this._button.hover GObject property (which real driver a physical
    // pointer enter would flip, via track_hover -- see panelMenu.js's
    // Button._init()) is set directly to fire the real, connected
    // 'notify::hover' handler end-to-end; _showHoverPopup()/
    // _hideHoverPopup()/_scheduleHoverPopupShow()/
    // _cancelHoverPopupShowTimeout() are called directly where a more
    // targeted assertion needs to bypass the real show-delay.
    //
    // Coming into this section: inst._activeOrder === ['UTC',
    // 'America/New_York'] (see the "setup: activate a second zone" test
    // above) and inst._config.showHoverPopup === false (schema default,
    // never touched by any earlier section). Every test below that
    // reorders inst._activeOrder restores it to EXACTLY
    // ['UTC', 'America/New_York'] before this section ends, since the DnD
    // section immediately below hard-codes that starting order.
    // =====================================================================

    record('hover popup: "Show dates on hover" is off by default (in-memory), and its popup-menu switch is tracked', () => {
      assertTrue(inst._config.showHoverPopup === false, 'showHoverPopup should default to false');
      assertTrue(!!inst._configSwitches.showHoverPopup, 'no "showHoverPopup" config switch tracked -- the popup menu switch was not added');

      // LAZY HOVER POPUP (karen-gate finding): with the toggle off, this
      // extension must be inert -- no hover-popup actor, no 'notify::hover'
      // connection, no pending timer -- exactly what HEAD (no hover-popup
      // feature at all) produces. Field-level checks first (cheap, precise
      // about WHICH thing is missing if this ever regresses)...
      assertTrue(inst._hoverPopup === null, 'a hover-popup actor exists with the toggle off -- the popup must be created lazily, only when toggled on');
      assertTrue(inst._hoverPopupBox === null, 'a hover-popup row container exists with the toggle off');
      assertTrue(inst._hoverSignalId === null, 'a "notify::hover" connection exists with the toggle off -- must only connect when the popup is created');
      assertTrue(inst._hoverShowTimeoutId === null, 'a hover-show timer is scheduled with the toggle off');
      // ...then the REAL, GObject/Clutter-level proof that would catch a
      // leak even if some OTHER field pointed at the actor (the exact gap
      // the coordinator's finding identified: nothing previously asserted
      // uiGroup child count or signal absence with the toggle off). Two
      // independent checks: the uiGroup child COUNT must be back to
      // exactly what it was right after enable() (before this test, or
      // any other, ever touched the toggle) -- proving no actor was added
      // AT ALL, not just that our own field doesn't reference one -- and
      // no actor anywhere in uiGroup carries this feature's own
      // accessible_name, a second, independent way of proving the same
      // "nothing was added" fact.
      assertEqual(
        Main.layoutManager.uiGroup.get_children().length,
        uiGroupChildCountAtEnable,
        'Main.layoutManager.uiGroup has a different child count than right after enable() -- something was added to the real actor tree with the hover-popup toggle off'
      );
      assertFalse(
        Main.layoutManager.uiGroup.get_children().some((child) => child.accessible_name === 'Timezones hover popup'),
        'a real actor with the hover-popup\'s own accessible_name is a child of uiGroup with the toggle off'
      );
      // A real, id-based g_signal_handler_is_connected() proof of
      // "notify::hover" absence needs an id to check against -- there
      // isn't one right now (inst._hoverSignalId is null, precisely the
      // point). The "toggling ON"/"toggling OFF" tests below supply that
      // proof at the moment a real id DOES exist to check: connected
      // right after toggling on, confirmed disconnected (same id) right
      // after toggling back off.
      // Deliberately does NOT assert that 'showHoverPopup' is absent
      // (undefined) from the persisted 'config' gsetting at this point.
      // DIAGNOSIS (an earlier version of this test asserted exactly that,
      // and failed): _saveSettings() writes `this._config` VERBATIM --
      // every key in CONFIG_KEYS, including showHoverPopup -- on every
      // single save (see extension.js's own _saveSettings():
      // `this._settings.set_value('config', new GLib.Variant('a{sb}',
      // this._config))`, no per-key diffing). By the time this section
      // runs, the "live-toggle staleness" section above has already
      // toggled the real "24 hours format" switch multiple times, and
      // EVERY one of those toggles triggers a real _saveSettings() call
      // that writes the
      // WHOLE config object -- including showHoverPopup: false -- to
      // gsettings. That is correct, pre-existing, intentional product
      // behavior (not something this feature changed or should change),
      // so asserting "not yet persisted" was a false premise created by
      // test ORDERING, not a real product guarantee -- this is a shared
      // 'config' a{sb} key, not a per-feature key, so no switch's
      // "freshness" can be assumed once ANY switch anywhere has ever been
      // toggled in this same run. The genuinely meaningful, ORDER-
      // independent guarantee -- "if this key HAS been persisted by now,
      // it must still be false, never true, since this test never
      // toggled it itself" -- is what's actually asserted below.
      const configVariant = inst._settings.get_value('config').deep_unpack();
      if (Object.prototype.hasOwnProperty.call(configVariant, 'showHoverPopup')) {
        assertTrue(configVariant.showHoverPopup === false, 'if showHoverPopup has already been persisted by an earlier save in this run, it must still be false (never true) before this section\'s own toggle test below');
      }
    });

    record('hover popup: with the toggle OFF, invoking the real show path (_showHoverPopup()) is a harmless no-op -- with the lazy design there is no popup actor to build rows into or show at all', () => {
      assertTrue(inst._hoverPopup === null, 'popup should not exist before this test (setup problem)');
      let threw = null;
      try {
        inst._showHoverPopup();
      } catch (e) {
        threw = e;
      }
      assertTrue(threw === null, `_showHoverPopup() with the toggle off (no popup actor) threw: ${threw}`);
      assertTrue(inst._hoverPopup === null, '_showHoverPopup() with the toggle off must not create a popup actor as a side effect');
    });

    record('hover popup: toggling the real "Show dates on hover" switch writes config.showHoverPopup, NOT date-format/formatting-defaults/separator, and lazily CREATES the popup actor + notify::hover connection', () => {
      const entry = inst._configSwitches.showHoverPopup;
      const beforeDateFormat = inst._settings.get_string('date-format');
      const beforeSeparator = inst._settings.get_string('separator');
      const beforeFormattingDefaults = inst._settings.get_string('formatting-defaults');
      assertTrue(inst._hoverPopup === null, 'popup should not exist before toggling on (test setup problem)');

      entry.item.toggle(); // real PopupSwitchMenuItem method -> real 'toggled' handler -> real setValue -> real _syncHoverPopupLifecycle()

      assertTrue(entry.getValue() === true, 'toggling did not flip its stored value');
      assertTrue(inst._settings.get_value('config').deep_unpack().showHoverPopup === true, 'the real "config" gsetting does not have showHoverPopup=true after toggling');
      assertEqual(inst._settings.get_string('date-format'), beforeDateFormat, 'date-format must be untouched by the hover-popup switch');
      assertEqual(inst._settings.get_string('separator'), beforeSeparator, 'separator must be untouched by the hover-popup switch');
      assertEqual(inst._settings.get_string('formatting-defaults'), beforeFormattingDefaults, 'formatting-defaults must be untouched by the hover-popup switch');

      // LAZY CREATE (karen-gate finding): toggling ON must actually build
      // the popup actor and connect notify::hover -- not just flip the
      // stored boolean. Real, GObject/Clutter-level proof, not just a
      // JS-field-is-truthy check: the actor is a genuine child of
      // Main.layoutManager.uiGroup, and g_signal_handler_is_connected()
      // confirms the REAL signal connection (same rigour the teardown
      // section already uses for WallClock/GSettings/button signals).
      assertTrue(!!inst._hoverPopup, 'toggling on did not create the popup actor');
      assertTrue(!!inst._hoverPopupBox, 'toggling on did not create the popup row container');
      assertTrue(!!inst._hoverSignalId, 'toggling on did not connect notify::hover');
      assertTrue(
        Main.layoutManager.uiGroup.get_children().includes(inst._hoverPopup),
        'the newly-created popup actor is not a real child of Main.layoutManager.uiGroup'
      );
      assertTrue(
        GObject.signal_handler_is_connected(inst._button, inst._hoverSignalId),
        'the real "notify::hover" signal is not connected after toggling on (JS field is set, but the GObject-level connection is missing)'
      );
    });

    // Independent expected-label computation: deliberately does NOT call
    // inst._getHoverPopupLabelText()/inst._computeEntrySegments() (the
    // very functions under test) -- it re-derives the city/zone segments
    // from inst._config/inst._labels directly, the same way extension.js's
    // OWN _computeEntrySegments() panel-form branch does, so a genuine
    // mismatch between the popup's label and the panel's own decision
    // would be caught here rather than the test merely echoing back
    // whatever the production code already computed.
    const independentExpectedLabel = (zone) => {
      const alias = inst._labels ? inst._labels[zone] : undefined;
      const cityPart = inst._config.showCity ? alias || zone.split('/').pop().replace('_', ' ') : '';
      const zonePart = inst._config.showTimezone ? GLib.DateTime.new_now(GLib.TimeZone.new(zone)).format('%Z') : '';
      return [cityPart, zonePart].filter((part) => part !== '').join(' ');
    };
    const expectedHoverCellText = (zone, dateText) => {
      const label = independentExpectedLabel(zone);
      return label ? `${label} ${dateText}` : dateText;
    };

    record('hover popup: with the toggle ON, the real show path builds one LABEL+DATE cell per active zone plus an interleaved separator label, in EXACT _activeOrder order, with each label matching the panel\'s own city/zone segments (independently recomputed) and NO time text anywhere in the popup', () => {
      assertEqual(inst._activeOrder, ['UTC', 'America/New_York'], 'test setup problem: unexpected _activeOrder going into this test');
      inst._settings.set_string('date-format', 'iso');
      inst._loadSettings();
      assertTrue(inst._config.showCity === true && inst._config.showTimezone === false, 'test setup problem: expected the schema defaults (showCity=true, showTimezone=false) entering this test');

      inst._showHoverPopup();

      const labels = inst._hoverPopupBox.get_children();
      assertEqual(labels.length, 3, `expected exactly 3 labels (cell, separator, cell) for 2 active zones, got ${labels.length}`);

      const [utcText, sepText, nyText] = labels.map((label) => label.text);

      // Real date-format machinery reused, not a second implementation --
      // ISO-shape check ("YYYY-MM-DD") on the DATE portion, and
      // independently cross-checked against the real
      // formatDateForDisplay()/resolveDateFormat() for "right now" in
      // each zone.
      const glibTzUtc = GLib.TimeZone.new('UTC');
      const glibTzNy = GLib.TimeZone.new('America/New_York');
      const expectedFormat = targetModules.resolveDateFormat(inst._settings.get_string('date-format'));
      const expectedUtcDate = targetModules.formatDateForDisplay(GLib.DateTime.new_now(glibTzUtc), expectedFormat);
      const expectedNyDate = targetModules.formatDateForDisplay(GLib.DateTime.new_now(glibTzNy), expectedFormat);
      assertTrue(/\d{4}-\d{2}-\d{2}/.test(expectedUtcDate), 'test setup problem: expected an ISO-shaped date');

      // Full cell text: label (schema default = city only, "UTC"/"New York")
      // + ' ' + date, matching the panel's own city/zone decision.
      assertEqual(utcText, expectedHoverCellText('UTC', expectedUtcDate), `UTC cell text does not match label+date: ${JSON.stringify(utcText)}`);
      assertEqual(nyText, expectedHoverCellText('America/New_York', expectedNyDate), `America/New_York cell text does not match label+date: ${JSON.stringify(nyText)}`);

      // Separator label: the same literal the panel itself joins its own
      // entries with (_resolveSeparatorValue()) -- unaffected by the label
      // addition.
      const expectedSeparator = inst._resolveSeparatorValue();
      assertEqual(sepText, expectedSeparator, `separator label text does not match the real resolved separator: ${JSON.stringify(sepText)}`);

      // Design-critical assertion: still NO time text anywhere in the
      // popup -- the panel's own rendered TIME for either active zone
      // must never appear, even though the label (city/zone) now does.
      const utcTimeText = inst._computeEntrySegments({ item: inst._stateByZone.get('UTC'), full: false }).time;
      const nyTimeText = inst._computeEntrySegments({ item: inst._stateByZone.get('America/New_York'), full: false }).time;
      const allText = labels.map((label) => label.text).join(' ');
      assertFalse(allText.includes(utcTimeText), `expected no TIME text anywhere in the popup, but found UTC's time text: ${JSON.stringify(allText)}`);
      assertFalse(allText.includes(nyTimeText), `expected no TIME text anywhere in the popup, but found America/New_York's time text: ${JSON.stringify(allText)}`);

      inst._hideHoverPopup();
    });

    record(
      'hover popup: cell labels track "Show city name"/"Show timezone" LIVE -- toggling either switch and re-showing changes the label accordingly (city-only, both -- in the correct city-THEN-zone order, zone-only, neither), never cached from an earlier show',
      () => {
        const cityEntry = inst._configSwitches.showCity;
        const zoneEntry = inst._configSwitches.showTimezone;
        assertTrue(!!cityEntry && !!zoneEntry, 'test setup problem: "showCity"/"showTimezone" config switches not tracked');
        assertTrue(cityEntry.getValue() === true && zoneEntry.getValue() === false, 'test setup problem: expected the schema defaults (showCity=true, showTimezone=false) entering this test');
        assertEqual(inst._activeOrder, ['UTC', 'America/New_York'], 'test setup problem: unexpected _activeOrder going into this test');

        // Deliberately uses America/New_York, not UTC: UTC's city fallback
        // ("UTC") and its %Z zone abbreviation ("UTC") are the IDENTICAL
        // string, so a genuine city<->zone segment swap in production code
        // would read back identically either way and this section would
        // never catch it (karen-gate finding). America/New_York's city
        // fallback ("New York") and %Z abbreviation (EST/EDT, DST-dependent)
        // are different strings, so an order/segment mistake actually
        // produces a different, wrong string here.
        const expectedFormat = targetModules.resolveDateFormat(inst._settings.get_string('date-format'));
        const expectedNyDate = targetModules.formatDateForDisplay(GLib.DateTime.new_now(GLib.TimeZone.new('America/New_York')), expectedFormat);
        // The %Z abbreviation is derived independently here via a real
        // GLib.DateTime call for "right now" (the same technique the date
        // oracle above uses) rather than hardcoded "EST" -- it is
        // DST/locale/tzdata-dependent (EST vs EDT), so hardcoding it would
        // make this assertion wrong for roughly half the year.
        const nyCityPart = 'New York';
        const nyZonePart = GLib.DateTime.new_now(GLib.TimeZone.new('America/New_York')).format('%Z');
        assertTrue(
          nyCityPart !== nyZonePart,
          `test setup problem: America/New_York's city fallback and %Z abbreviation must be DIFFERENT strings for this test to discriminate segment order, got "${nyCityPart}" and "${nyZonePart}"`
        );

        const showAndReadNyCell = () => {
          inst._showHoverPopup();
          const text = inst._hoverPopupBox.get_children()[2].text; // America/New_York is always _activeOrder[1] -> cell index 2 in this section
          inst._hideHoverPopup();
          return text;
        };

        // Baseline (schema default): city-only -- must be "New York <date>",
        // and must NOT contain the zone abbreviation anywhere (catches a
        // city-only state that accidentally rendered the zone segment
        // instead of the city segment).
        const cityOnlyText = showAndReadNyCell();
        assertEqual(cityOnlyText, expectedHoverCellText('America/New_York', expectedNyDate), 'expected city-only label "New York <date>" with showCity=true/showTimezone=false');
        assertEqual(cityOnlyText, `${nyCityPart} ${expectedNyDate}`, `expected city-only label to be exactly "New York <date>": ${JSON.stringify(cityOnlyText)}`);
        assertFalse(cityOnlyText.includes(nyZonePart), `expected no zone abbreviation anywhere in the city-only label: ${JSON.stringify(cityOnlyText)}`);

        // Both on -- the CORE discriminating assertion: city segment FIRST,
        // then zone segment, then date, in that EXACT order. A genuine
        // city<->zone segment swap in production code produces a visibly
        // DIFFERENT, wrong string here ("EST New York <date>" instead of
        // "New York EST <date>"), unlike the UTC case above where both
        // orders read identically.
        zoneEntry.item.toggle();
        assertTrue(zoneEntry.getValue() === true, 'toggling "Show timezone" did not flip its stored value');
        const bothOnText = showAndReadNyCell();
        assertEqual(bothOnText, expectedHoverCellText('America/New_York', expectedNyDate), 'expected "New York <zone> <date>" with both showCity and showTimezone on (independent oracle)');
        assertEqual(
          bothOnText,
          `${nyCityPart} ${nyZonePart} ${expectedNyDate}`,
          `expected the cell text to be exactly "New York <zone> <date>" IN THAT ORDER (city first, then zone, then date): ${JSON.stringify(bothOnText)}`
        );

        // Zone-only -- must be "<zone> <date>", and must NOT contain the
        // city name anywhere (catches a zone-only state that accidentally
        // rendered the city segment instead of the zone segment).
        cityEntry.item.toggle();
        assertTrue(cityEntry.getValue() === false, 'toggling "Show city name" did not flip its stored value');
        const zoneOnlyText = showAndReadNyCell();
        assertEqual(zoneOnlyText, expectedHoverCellText('America/New_York', expectedNyDate), 'expected zone-only label with showCity off/showTimezone on (independent oracle)');
        assertEqual(zoneOnlyText, `${nyZonePart} ${expectedNyDate}`, `expected zone-only label to be exactly "<zone> <date>": ${JSON.stringify(zoneOnlyText)}`);
        assertFalse(zoneOnlyText.includes(nyCityPart), `expected no city name anywhere in the zone-only label: ${JSON.stringify(zoneOnlyText)}`);

        // Neither -- bare date-only cell (no label, no leading space).
        zoneEntry.item.toggle();
        assertTrue(zoneEntry.getValue() === false, 'toggling "Show timezone" back off did not flip its stored value');
        const dateOnlyText = showAndReadNyCell();
        assertEqual(dateOnlyText, expectedNyDate, 'expected a bare date-only cell (no label, no leading space) with both toggles off');
        assertEqual(dateOnlyText, expectedHoverCellText('America/New_York', expectedNyDate), 'independent expected-label helper disagrees with the bare-date expectation when both toggles are off');

        // Restore the schema defaults for every section below.
        cityEntry.item.toggle();
        assertTrue(cityEntry.getValue() === true, 'failed to restore "Show city name" to true');
        assertTrue(zoneEntry.getValue() === false, 'test setup problem: "Show timezone" should already be false going into the restore step');
      }
    );

    record('hover popup: cell text includes a hostile custom label verbatim (plain St.Label text, never markup) -- the label is the same city segment the panel itself would show, so it is no longer suppressed, but it is never interpreted as markup', () => {
      inst._labels['America/New_York'] = '<b>evil</b> & "quotes"';
      inst._showHoverPopup();
      const labels = inst._hoverPopupBox.get_children();
      const nyLabel = labels.find((label) => label.text.includes('evil'));
      assertTrue(!!nyLabel, 'expected the hostile custom label to appear verbatim in the popup\'s America/New_York cell');
      assertTrue(
        nyLabel.text.startsWith('<b>evil</b> & "quotes" '),
        `expected the hostile label to prefix the date verbatim, unescaped, with a single space before the date: ${JSON.stringify(nyLabel.text)}`
      );
      labels.forEach((label, index) => {
        assertTrue(label.clutter_text.get_use_markup() === false, `hover popup label ${index} must never have use-markup enabled`);
      });
      inst._hideHoverPopup();
      delete inst._labels['America/New_York'];
    });

    record('hover popup: reordering _activeOrder (via the real _reorderActiveZone) is reflected in the next show, labels included -- restores the original order afterward for the DnD section below', () => {
      inst._reorderActiveZone('America/New_York', 0);
      assertEqual(inst._activeOrder, ['America/New_York', 'UTC'], 'test setup problem: reorder did not produce the expected order');

      inst._showHoverPopup();
      const labels = inst._hoverPopupBox.get_children();
      assertEqual(labels.length, 3, `expected exactly 3 labels after reorder, got ${labels.length}`);

      const glibTzNy = GLib.TimeZone.new('America/New_York');
      const glibTzUtc = GLib.TimeZone.new('UTC');
      const expectedFormat = targetModules.resolveDateFormat(inst._settings.get_string('date-format'));
      const expectedNyDate = targetModules.formatDateForDisplay(GLib.DateTime.new_now(glibTzNy), expectedFormat);
      const expectedUtcDate = targetModules.formatDateForDisplay(GLib.DateTime.new_now(glibTzUtc), expectedFormat);

      assertEqual(labels[0].text, expectedHoverCellText('America/New_York', expectedNyDate), `expected label 0 to be America/New_York's label+date after reorder: ${JSON.stringify(labels[0].text)}`);
      assertEqual(labels[2].text, expectedHoverCellText('UTC', expectedUtcDate), `expected label 2 to be UTC's label+date after reorder: ${JSON.stringify(labels[2].text)}`);
      inst._hideHoverPopup();

      // Restore the exact starting order the DnD section below hard-codes.
      inst._reorderActiveZone('America/New_York', 2);
      assertEqual(inst._activeOrder, ['UTC', 'America/New_York'], 'failed to restore the original _activeOrder for the DnD section below');
    });

    await recordAsync('hover popup: rendering -- the popup and every one of its date/separator labels are genuinely mapped with finite, non-collapsed allocation (not just present in the object graph), laid out left-to-right with no overlap', async () => {
      inst._showHoverPopup();
      await sleep(300);
      try {
        assertTrue(inst._hoverPopup.visible === true, 'popup did not become visible');
        assertTrue(inst._hoverPopup.mapped === true, 'popup actor is not mapped');
        const popupBox = inst._hoverPopup.get_allocation_box();
        const popupHeight = popupBox.y2 - popupBox.y1;
        const popupWidth = popupBox.x2 - popupBox.x1;
        assertTrue(Number.isFinite(popupHeight) && popupHeight > 0, `popup allocation height is not finite/positive: ${popupHeight}`);
        assertTrue(Number.isFinite(popupWidth) && popupWidth > 0, `popup allocation width is not finite/positive: ${popupWidth}`);

        const labels = inst._hoverPopupBox.get_children();
        assertEqual(labels.length, 3, `expected exactly 3 labels, got ${labels.length}`);

        labels.forEach((label, index) => {
          assertTrue(label.mapped === true, `label ${index} is not mapped`);
          const box = label.get_allocation_box();
          [box.x1, box.x2, box.y1, box.y2].forEach((coord, coordIndex) => {
            assertTrue(Number.isFinite(coord), `label ${index}: allocation coordinate #${coordIndex} is not finite`);
          });
          assertTrue(box.x2 - box.x1 > 0, `label ${index}: allocation width is not positive`);
          assertTrue(box.y2 - box.y1 > 0, `label ${index}: allocation height is not positive`);
        });

        // Cross-label sanity: successive labels must not overlap
        // horizontally (a real left-to-right single row, not everything
        // collapsed onto the same x).
        for (let i = 1; i < labels.length; i++) {
          const prevBox = labels[i - 1].get_allocation_box();
          const curBox = labels[i].get_allocation_box();
          assertTrue(curBox.x1 >= prevBox.x2, `label ${i} (x1=${curBox.x1}) overlaps the previous label (x2=${prevBox.x2})`);
        }
      } finally {
        inst._hideHoverPopup();
        await sleep(100);
      }
    });

    record('hover popup: suppression -- with the real main menu open, the show path does not display the popup', () => {
      inst._menu.open(BoxPointer.PopupAnimation.NONE);
      try {
        assertTrue(inst._menu.isOpen === true, 'main menu did not open (test setup problem)');
        inst._showHoverPopup();
        assertTrue(inst._hoverPopup.visible === false, 'hover popup must not show while the main menu is open');
      } finally {
        inst._menu.close(BoxPointer.PopupAnimation.NONE);
      }
    });

    record('hover popup: opening the real main menu WHILE the hover popup is showing hides it (real open-state-changed handler)', () => {
      inst._showHoverPopup();
      assertTrue(inst._hoverPopup.visible === true, 'popup did not show (test setup problem)');

      inst._menu.open(BoxPointer.PopupAnimation.NONE);
      try {
        assertTrue(inst._menu.isOpen === true, 'main menu did not open (test setup problem)');
        assertTrue(inst._hoverPopup.visible === false, 'hover popup was not hidden by the real menu-open handler');
      } finally {
        inst._menu.close(BoxPointer.PopupAnimation.NONE);
      }
    });

    record('hover popup timer: scheduling then cancelling removes the pending GLib timeout (real GLib.MainContext proof, not just the JS field)', () => {
      inst._scheduleHoverPopupShow();
      const id = inst._hoverShowTimeoutId;
      assertTrue(!!id, 'no timeout was scheduled');
      assertTrue(!!GLib.MainContext.default().find_source_by_id(id), 'scheduled timeout source does not actually exist in the real GLib main context');

      inst._cancelHoverPopupShowTimeout();
      assertTrue(inst._hoverShowTimeoutId === null, '_hoverShowTimeoutId was not nulled by cancel');
      assertTrue(!GLib.MainContext.default().find_source_by_id(id), 'cancelled timeout source is still registered in the real GLib main context -- a real leak, not just a stale JS field');
    });

    await recordAsync('hover popup timer: scheduling then it never shows the popup once cancelled, even after the real delay elapses', async () => {
      inst._scheduleHoverPopupShow();
      inst._cancelHoverPopupShowTimeout();
      await sleep(500); // real HOVER_POPUP_SHOW_DELAY_MS (400) plus margin
      assertTrue(inst._hoverPopup.visible === false, 'popup opened even though its show-timer was cancelled before the delay elapsed');
    });

    await recordAsync('hover popup: end-to-end via the REAL "notify::hover" GObject signal -- setting this._button.hover = true schedules and (after the real delay) shows the popup; setting it back to false hides it and cancels any pending timer', async () => {
      assertTrue(inst._config.showHoverPopup === true, 'test setup problem: showHoverPopup should still be on from the toggle test above');
      inst._button.hover = true; // real GObject property write -> real 'notify::hover' emission -> real _onButtonHoverChanged()
      assertTrue(!!inst._hoverShowTimeoutId, 'hover-in did not schedule the real show timer');

      const shown = await waitUntil(() => inst._hoverPopup.visible === true, 2000, 25);
      assertTrue(shown, 'popup never became visible after the real show-delay elapsed');

      inst._button.hover = false; // real GObject property write -> real hover-out handling
      assertTrue(inst._hoverShowTimeoutId === null, 'hover-out did not cancel/null the timer field');
      const hidden = await waitUntil(() => inst._hoverPopup.visible === false, 2000, 25);
      assertTrue(hidden, 'popup never became hidden after hover-out');
    });

    record('hover popup: cleanup -- turning the switch back off lazily DESTROYS the popup actor, DISCONNECTS notify::hover, and cancels any pending timer, leaving no popup/timer/signal pending for the sections below', () => {
      inst._cancelHoverPopupShowTimeout();
      inst._hideHoverPopup();

      // Snapshot the LIVE actor/signal id before toggling off, so the
      // post-toggle checks below are real, GObject/Clutter-level proof
      // that THIS SPECIFIC actor/connection is gone -- not just that
      // inst's own fields were reassigned to null (which would pass even
      // if the old objects leaked somewhere else, e.g. still parented
      // under uiGroup, or the signal still connected on the button).
      const entry = inst._configSwitches.showHoverPopup;
      assertTrue(entry.getValue() === true, 'test setup problem: showHoverPopup should still be on going into this cleanup step');
      const hoverPopupObj = inst._hoverPopup;
      const hoverSignalId = inst._hoverSignalId;
      assertTrue(!!hoverPopupObj, 'test setup problem: no live popup actor to prove teardown against');
      assertTrue(!!hoverSignalId, 'test setup problem: no live notify::hover connection to prove teardown against');
      assertTrue(
        GObject.signal_handler_is_connected(inst._button, hoverSignalId),
        'test setup problem: notify::hover is not actually connected before toggling off'
      );

      if (entry.getValue()) {
        entry.item.toggle(); // real 'toggled' handler -> real setValue -> real _syncHoverPopupLifecycle() -> real _teardownHoverPopup()
      }
      assertTrue(entry.getValue() === false, 'failed to turn the hover-popup switch back off');

      // Real GObject-level proof the notify::hover connection is
      // genuinely gone (this._button is still alive here -- unlike
      // disable(), this is a runtime toggle, not teardown -- so this
      // check is safe, unlike the equivalent post-disable() check this
      // file deliberately avoids elsewhere for a destroyed button).
      assertFalse(
        GObject.signal_handler_is_connected(inst._button, hoverSignalId),
        'notify::hover is still connected (same real signal id) after toggling the hover-popup switch off'
      );
      // Real Clutter-level proof the actor is genuinely gone from the
      // real actor tree, not just dereferenced by this._hoverPopup.
      assertFalse(
        Main.layoutManager.uiGroup.get_children().includes(hoverPopupObj),
        'the old popup actor is still a child of Main.layoutManager.uiGroup after toggling the hover-popup switch off'
      );
      // JS-bookkeeping-level checks (all four fields _teardownHoverPopup()
      // is responsible for nulling).
      assertTrue(inst._hoverPopup === null, '_hoverPopup was not nulled after toggling the hover-popup switch off');
      assertTrue(inst._hoverPopupBox === null, '_hoverPopupBox was not nulled after toggling the hover-popup switch off');
      assertTrue(inst._hoverSignalId === null, '_hoverSignalId was not nulled after toggling the hover-popup switch off');
      assertTrue(inst._hoverShowTimeoutId === null, 'a timer is still pending at the end of the hover-popup section');
    });

    record('hover popup: toggling ON then OFF then ON then OFF then ON repeatedly (via the real switch) leaks nothing -- each ON creates a genuinely NEW actor/signal (never reuses a destroyed one), each OFF genuinely destroys/disconnects it, and uiGroup\'s child count never creeps up across the cycle', () => {
      const entry = inst._configSwitches.showHoverPopup;
      assertTrue(entry.getValue() === false, 'test setup problem: showHoverPopup should be off going into this cycle (previous cleanup test)');
      const uiGroupCountBeforeCycle = Main.layoutManager.uiGroup.get_children().length;

      const seenPopupObjs = new Set();
      const seenSignalIds = new Set();

      for (let i = 0; i < 3; i++) {
        entry.item.toggle(); // OFF -> ON
        assertTrue(entry.getValue() === true, `cycle ${i}: toggle-on did not flip the stored value`);
        assertTrue(!!inst._hoverPopup, `cycle ${i}: toggle-on did not create the popup actor`);
        assertTrue(!!inst._hoverSignalId, `cycle ${i}: toggle-on did not connect notify::hover`);
        assertTrue(
          Main.layoutManager.uiGroup.get_children().includes(inst._hoverPopup),
          `cycle ${i}: the newly-created popup actor is not a real child of uiGroup`
        );
        assertTrue(
          GObject.signal_handler_is_connected(inst._button, inst._hoverSignalId),
          `cycle ${i}: notify::hover is not really connected after toggle-on`
        );
        // Every ON must be a genuinely FRESH actor/signal id, never a
        // reused/resurrected one from a previous cycle -- reusing a
        // destroyed actor would itself be a real bug (a disposed-object
        // touch waiting to happen), so this is checked explicitly rather
        // than assumed.
        assertFalse(seenPopupObjs.has(inst._hoverPopup), `cycle ${i}: the popup actor was reused from an earlier cycle instead of being freshly created`);
        assertFalse(seenSignalIds.has(inst._hoverSignalId), `cycle ${i}: the notify::hover signal id was reused from an earlier cycle instead of being freshly connected`);
        seenPopupObjs.add(inst._hoverPopup);
        seenSignalIds.add(inst._hoverSignalId);

        const hoverPopupObj = inst._hoverPopup;
        const hoverSignalId = inst._hoverSignalId;

        entry.item.toggle(); // ON -> OFF
        assertTrue(entry.getValue() === false, `cycle ${i}: toggle-off did not flip the stored value`);
        assertTrue(inst._hoverPopup === null, `cycle ${i}: toggle-off did not null _hoverPopup`);
        assertTrue(inst._hoverPopupBox === null, `cycle ${i}: toggle-off did not null _hoverPopupBox`);
        assertTrue(inst._hoverSignalId === null, `cycle ${i}: toggle-off did not null _hoverSignalId`);
        assertFalse(
          GObject.signal_handler_is_connected(inst._button, hoverSignalId),
          `cycle ${i}: notify::hover (same real signal id) is still connected after toggle-off`
        );
        assertFalse(
          Main.layoutManager.uiGroup.get_children().includes(hoverPopupObj),
          `cycle ${i}: the old popup actor is still a child of uiGroup after toggle-off`
        );
        assertEqual(
          Main.layoutManager.uiGroup.get_children().length,
          uiGroupCountBeforeCycle,
          `cycle ${i}: uiGroup child count did not return to its pre-cycle value after toggle-off -- a leak accumulating across cycles`
        );
      }

      assertEqual(seenPopupObjs.size, 3, 'expected exactly 3 distinct popup actors across 3 ON/OFF cycles');
      assertEqual(seenSignalIds.size, 3, 'expected exactly 3 distinct notify::hover signal ids across 3 ON/OFF cycles');
    });

    record('hover popup: an EXTERNAL settings change (simulating dconf/another instance, not the menu switch) also lazily creates and destroys the popup', () => {
      // Writes the real 'config' gsetting directly, bypassing
      // inst._configSwitches entirely -- the same real GSettings 'changed'
      // signal a genuine dconf-editor/gsettings-CLI/another-instance write
      // would emit. inst._settings.connect('changed', ...) in enable()
      // is the real, production code path this drives (see its own
      // comment on _syncHoverPopupLifecycle() for why it needs to handle
      // this case, not just the menu switch).
      assertTrue(inst._config.showHoverPopup === false, 'test setup problem: showHoverPopup should be off going into this test');
      assertTrue(inst._hoverPopup === null, 'test setup problem: no popup should exist going into this test');

      const currentConfig = inst._settings.get_value('config').deep_unpack();
      inst._settings.set_value('config', new GLib.Variant('a{sb}', { ...currentConfig, showHoverPopup: true }));

      assertTrue(inst._config.showHoverPopup === true, 'external config write did not refresh this._config (the "changed" handler did not run _loadSettings())');
      assertTrue(!!inst._hoverPopup, 'external config write with showHoverPopup=true did not lazily create the popup actor');
      assertTrue(!!inst._hoverSignalId, 'external config write with showHoverPopup=true did not lazily connect notify::hover');
      assertTrue(
        GObject.signal_handler_is_connected(inst._button, inst._hoverSignalId),
        'notify::hover is not really connected after an external config write turned the toggle on'
      );
      const hoverPopupObj = inst._hoverPopup;
      const hoverSignalId = inst._hoverSignalId;

      const configAfterExternalOn = inst._settings.get_value('config').deep_unpack();
      inst._settings.set_value('config', new GLib.Variant('a{sb}', { ...configAfterExternalOn, showHoverPopup: false }));

      assertTrue(inst._config.showHoverPopup === false, 'external config write did not refresh this._config back to false');
      assertTrue(inst._hoverPopup === null, 'external config write with showHoverPopup=false did not lazily destroy the popup actor');
      assertTrue(inst._hoverSignalId === null, 'external config write with showHoverPopup=false did not lazily disconnect notify::hover');
      assertFalse(
        GObject.signal_handler_is_connected(inst._button, hoverSignalId),
        'notify::hover (same real signal id) is still connected after an external config write turned the toggle back off'
      );
      assertFalse(
        Main.layoutManager.uiGroup.get_children().includes(hoverPopupObj),
        'the popup actor is still a child of uiGroup after an external config write turned the toggle back off'
      );

      // Leave the real "Show dates on hover" menu switch's own
      // tracked visual state consistent with the now-off gsetting, for
      // whatever runs after this (mirrors what _syncConfigSwitches()
      // itself already does on the next real menu open/settings change --
      // asserted here directly since no menu open happens between this
      // test and the sections below).
      assertTrue(inst._configSwitches.showHoverPopup.getValue() === false, 'showHoverPopup switch entry\'s own getValue() does not reflect the external change');
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

    // Closes a gap left by _refreshVisibleTimeLabels()'s own comment
    // (extension.js): that comment REASONS (from a static read of
    // _addActiveMenuRow()) that a config-switch refresh happening while an
    // inline rename is open is safe, because both `label` and `entry` are
    // permanent children and rename mode only ever toggles `.visible`. That
    // reasoning has been wrong before in this project ("I traced it and
    // it's safe" -- see CLAUDE.md's standing note on exactly this class of
    // claim), so this drives the real collision instead of trusting the
    // comment: a real, uncommitted inline rename (via the real edit button
    // and a real St.Entry) is left open, then a real config-switch toggle
    // -- the same 'toggled' handler that calls _refreshVisibleTimeLabels()
    // -- fires underneath it, exactly as it would if a user toggled "Show
    // date" in one already-open menu while mid-rename on a row in that same
    // menu.
    record(
      'rename: a real, in-progress, UNCOMMITTED inline rename survives a real config-switch refresh happening underneath it -- entry text/visibility/focus untouched, the row\'s HIDDEN St.Label DOES update',
      () => {
        inst._updateActiveMenu();
        const beforeLabels = { ...inst._labels };

        const row = inst._activeMenu.box.get_children().find((c) => typeof c.acceptDrop === 'function');
        assertTrue(!!row, 'no active-clock row found in the active menu box');

        const entry = row.get_children().find((c) => c instanceof St.Entry);
        assertTrue(!!entry, 'no inline-rename St.Entry found on the row');
        const label = row.get_children().find((c) => c instanceof St.Label);
        assertTrue(!!label, 'no St.Label found on the row');

        const buttons = row.get_children().filter((c) => c instanceof St.Button);
        // Same discriminator as the cancel test above: dragHandle then
        // editButton, both St.Button, so the edit button is always last.
        const editButton = buttons[buttons.length - 1];
        assertTrue(!!editButton, 'no edit button found on the row');

        editButton.emit('clicked', 1); // real enterEditMode() (StButton::clicked passes the mouse button number)
        assertTrue(entry.visible === true, 'entering edit mode did not make the entry visible');
        assertTrue(label.visible === false, 'entering edit mode did not hide the label');
        assertTrue(
          global.stage.get_key_focus() === entry.clutter_text,
          'test setup problem: the real entry does not have real stage-level key focus right after entering edit mode -- the "focus not stolen" check below would be meaningless without this baseline'
        );

        const typed = 'typing but not committing yet';
        entry.set_text(typed);
        const labelTextBefore = label.text;

        // The real collision: toggle a real config switch -- the exact
        // 'toggled' handler that calls _refreshVisibleTimeLabels() -- WHILE
        // the rename above is still open and uncommitted. format24 is used
        // here (schema default true entering this test, restored below) --
        // the menu-row date switch this test originally used has since
        // been removed (dates now live only in the hover popup), but
        // format24 still changes a row's rendered TEXT (see
        // _computeEntrySegments()), so it drives the exact same class of
        // collision.
        const formatEntry = inst._configSwitches.format24;
        assertTrue(!!formatEntry, 'no "format24" config switch tracked -- the popup menu switch was not added');
        assertTrue(formatEntry.getValue() === true, 'test setup problem: format24 is unexpectedly already false entering this test');
        formatEntry.item.toggle();
        assertTrue(formatEntry.getValue() === false, 'toggling "24 hours format" mid-rename did not flip its stored value');

        // The rename itself must be completely undisturbed.
        assertEqual(entry.get_text(), typed, 'the typed-but-uncommitted rename text was clobbered by a config-switch refresh happening mid-edit');
        assertTrue(entry.visible === true, 'the entry was hidden by a config-switch refresh happening mid-edit');
        assertTrue(label.visible === false, 'the label was revealed (rename mode was exited) by a config-switch refresh happening mid-edit');
        assertTrue(
          global.stage.get_key_focus() === entry.clutter_text,
          'keyboard focus was stolen away from the entry by a config-switch refresh happening mid-edit'
        );
        assertEqual(inst._labels, beforeLabels, 'the "labels" gsetting was written despite no commit happening');

        // ...but the refresh must still have done its real job underneath:
        // the row's HIDDEN St.Label text changed (a real 12-hour AM/PM
        // time now present), proving _refreshVisibleTimeLabels() genuinely
        // found and updated this row's label rather than silently skipping
        // it just because it is hidden right now.
        assertTrue(label.text !== labelTextBefore, `the row's hidden St.Label was not refreshed underneath the in-progress rename: still ${JSON.stringify(label.text)}`);
        assertTrue(
          /\b(AM|PM)\b/.test(label.text),
          `expected a 12-hour AM/PM time in the row's hidden St.Label text after toggling "24 hours format" off mid-rename: ${JSON.stringify(label.text)}`
        );

        // Round-trip format24 back on (leaves later sections' assumption
        // of the schema default intact), then cancel the still-open rename
        // via the same real, argument-free key-focus-out mechanism the
        // test above uses, so this test leaves no open rename and no
        // written label behind.
        formatEntry.item.toggle();
        assertTrue(formatEntry.getValue() === true, 'round-trip toggle back to format24=true did not flip its stored value');

        entry.clutter_text.emit('key-focus-out'); // real cancelEdit()
        assertTrue(entry.visible === false, 'cancelEdit() did not hide the entry again after the mid-edit refresh test');
        assertEqual(inst._labels, beforeLabels, 'labels changed despite the edit ultimately being cancelled');
      }
    );

    // Cheap companion check for the same guard, from the other direction:
    // _refreshVisibleTimeLabels() skips any box child whose acceptDrop is
    // not a function (see its own comment in extension.js) specifically so
    // it never mistakes the drop-indicator actor _handleActiveDragOver()
    // inserts into the same box for a real row. Reuses the exact same
    // indicator-creation call the DnD section above already proved inserts
    // a real actor into inst._activeMenu.box.
    record(
      'refresh vs. drop indicator: a real drop-indicator actor inserted by _handleActiveDragOver survives a config-switch refresh untouched -- it has no acceptDrop, so the guard in _refreshVisibleTimeLabels() must skip it rather than treating it as a row',
      () => {
        const result = inst._handleActiveDragOver(null, null, 0, 0);
        assertEqual(result, DND.DragMotionResult.MOVE_DROP);
        assertTrue(!!inst._dropIndicator, 'no drop-indicator actor was created');
        assertTrue(inst._dropIndicator.get_parent() === inst._activeMenu.box, 'drop-indicator actor was not inserted into the active menu box');
        assertTrue(
          typeof inst._dropIndicator.acceptDrop !== 'function',
          'test setup problem: the drop indicator unexpectedly has an acceptDrop method -- it would no longer discriminate against the guard this test exists to check'
        );

        const indicatorChildCountBefore = inst._dropIndicator.get_children().length;

        // format24 drives this collision (the menu-row date switch this
        // test originally used has since been removed -- see the
        // mid-rename test above's own comment for why format24 is an
        // equally valid, still-present stand-in).
        const formatEntry = inst._configSwitches.format24;
        assertTrue(!!formatEntry, 'no "format24" config switch tracked');
        assertTrue(formatEntry.getValue() === true, 'test setup problem: format24 is unexpectedly already false entering this test');

        let threw = null;
        try {
          formatEntry.item.toggle();
        } catch (e) {
          threw = e;
        }
        assertTrue(threw === null, `a config-switch refresh with a real drop indicator present threw: ${threw && threw.message}`);

        assertTrue(inst._dropIndicator.get_parent() === inst._activeMenu.box, 'the drop indicator was removed/reparented by the refresh');
        assertEqual(inst._dropIndicator.get_children().length, indicatorChildCountBefore, 'the drop indicator gained/lost children -- it was mutated as if it were a row');

        formatEntry.item.toggle(); // round-trip back to the schema default
        assertTrue(formatEntry.getValue() === true, 'round-trip toggle back to format24=true did not flip its stored value');

        inst._clearDropIndicator(); // real cleanup method -- leaves state as a genuinely cancelled drag would
      }
    );

    // =====================================================================
    // 5b. Popup menu: the "Separator" submenu still renders correctly with
    //     a POPULATED (~10-zone) active list, not just the near-empty
    //     default used in section 3b above.
    //
    // karen-gate round-3 REQUIREMENT: assert rendering with a POPULATED
    // zone list too -- more active zones means _activeMenu needs more of
    // the shared, finite top-level vertical budget, which is exactly the
    // resource round 3's bug starved the Separator submenu of. ~10 zones
    // matches the gate's own reproduction ("once with the default 2-zone
    // menu, once with 10 active zones"). Deliberately placed AFTER the
    // DnD (section 4) and rename (section 5) tests above, which assert
    // exact, fixed shapes for `_activeOrder` (e.g. "expected 2 active
    // zones going in") -- adding 8 more zones here would break those
    // fixed-shape assertions if done earlier. Placed BEFORE the teardown
    // section below, whose own assertions are already length-relative
    // (`_rowDraggables.length === _activeOrder.length`), not
    // count-specific, so they remain valid regardless of how many zones
    // are active by this point.
    // =====================================================================

    await recordAsync('setup: activate ~10 zones total so the active-zone list is genuinely populated for the rendering checks below', () => {
      const targets = ['Europe/London', 'Europe/Paris', 'Asia/Tokyo', 'Asia/Shanghai', 'Australia/Sydney', 'America/Los_Angeles', 'America/Chicago', 'Asia/Kolkata'];
      targets.forEach((zone) => {
        const item = inst._stateByZone.get(zone);
        assertTrue(!!item, `${zone} not found in _stateByZone`);
        if (!inst._activeOrder.includes(zone)) {
          inst._toggleTimezone(item);
        }
      });
      assertTrue(inst._activeOrder.length >= 10, `expected >=10 active zones, got ${inst._activeOrder.length}: ${JSON.stringify(inst._activeOrder)}`);
    });

    await recordAsync(
      'popup menu: opening the real popup + real "Separator" submenu actually renders it with a POPULATED (~10-zone) active list -- same discriminating checks as the default-list check in section 3b, but with the active-zone list genuinely competing for vertical space',
      () => assertSubmenuRenders('Separator', 'Separator picker', inst._separatorMenuItems.spaces)
    );

    record(
      'popup menu CONTROL (~10-zone list): the same known-good config switch is still mapped with real on-screen height',
      assertControlRenders
    );

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

      // LAZY HOVER POPUP (karen-gate finding): the "hover popup: cleanup"
      // test in section 3d left the toggle OFF, and with the lazy
      // create/destroy design that means inst._hoverPopup/_hoverSignalId
      // are genuinely null right now -- there is nothing live to
      // snapshot. Turn the switch back ON here (via the real 'toggled'
      // handler, same as every other real-switch-driven test in this
      // file) so this teardown section snapshots a REAL, freshly-created
      // popup/signal, exactly what section 6 needs to prove disable()
      // cleans up. Section 3f's dedicated lazy-toggle tests already cover
      // the OFF-at-enable()/toggle-off-destroys-it behavior on their own;
      // this section is specifically about disable() teardown, not
      // lazy-lifecycle correctness, so it needs a live popup as its
      // starting point.
      const hoverEntry = inst._configSwitches.showHoverPopup;
      if (!hoverEntry.getValue()) {
        hoverEntry.item.toggle(); // real 'toggled' handler -> real _syncHoverPopupLifecycle() -> real _initHoverPopup()
      }
      assertTrue(!!inst._hoverPopup, 'toggling "Show dates on hover" back on did not (re)create the popup actor (test setup problem)');
      assertTrue(!!inst._hoverSignalId, 'toggling "Show dates on hover" back on did not (re)connect notify::hover (test setup problem)');

      snapshot = {
        clockObj: inst._systemClock,
        clockSignalId: inst._signalId,
        settingsObj: inst._settings,
        settingsChangedId: inst._settingsChangedId,
        statusAreaKey: `${inst.metadata.name} Indicator`,
        buttonAncestor,
        buttonAncestorChildCountBefore: buttonAncestor.get_n_children(),
        // Hover-popup feature: this._button is still alive at this point
        // (destroyed later, inside disable() itself), so its
        // 'notify::hover' handler's connectedness CAN be checked directly
        // both before AND after disable() -- unlike this._menu (see the
        // NOTE below), this._button is a real St.Widget/GObject.
        buttonObj: inst._button,
        hoverSignalId: inst._hoverSignalId,
        hoverPopupObj: inst._hoverPopup,
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
      assertTrue(
        GObject.signal_handler_is_connected(snapshot.buttonObj, snapshot.hoverSignalId),
        'panel button "notify::hover" signal was not connected before disable() (test setup problem, not a real failure)'
      );
    });

    let pendingHoverTimerId = null;

    record('teardown setup: schedule a real pending hover-show timer right before disable(), to prove it does not survive teardown', () => {
      // The toggle is already back on (the "capture a snapshot" test just
      // above turned it on again to have something real to snapshot) --
      // this guard is just idempotent belt-and-suspenders, not load-
      // bearing here. Config state itself is irrelevant to what's being
      // proven below (that ANY pending timeout this file scheduled is
      // removed by disable(), mid-pending, real GLib-level proof), it's
      // just what _scheduleHoverPopupShow() needs to actually be
      // reachable via the same real code path a genuine hover-in would
      // use.
      const entry = inst._configSwitches.showHoverPopup;
      if (!entry.getValue()) {
        entry.item.toggle();
      }
      assertTrue(inst._menu.isOpen === false, 'main menu must be closed for this setup step (test setup problem)');
      inst._button.hover = true; // real property write -> real 'notify::hover' handler -> real _scheduleHoverPopupShow()
      pendingHoverTimerId = inst._hoverShowTimeoutId;
      assertTrue(!!pendingHoverTimerId, 'no hover-show timer was scheduled (test setup problem)');
      assertTrue(
        !!GLib.MainContext.default().find_source_by_id(pendingHoverTimerId),
        'scheduled timer source does not actually exist before disable() (test setup problem)'
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
      // Deliberately NOT a post-disable GObject.signal_handler_is_connected()
      // check on snapshot.buttonObj here, unlike WallClock/GSettings above.
      // KAREN-GATE FIX: an earlier version of this test did exactly that
      // and produced a real `Gjs-CRITICAL **: Object
      // .Gjs_ui_panelMenu_PanelMenuButton ... has been already disposed --
      // impossible to access it` on every run (caught by the generalized
      // shell-log scanner -- see the module comment's finding 3). ROOT
      // CAUSE: unlike this._systemClock/this._settings (never destroyed,
      // only disconnected-from), this._button IS genuinely destroyed by
      // disable() itself (`this._button.destroy()`), so touching the
      // SAME snapshot reference again afterwards -- even just to read
      // whether a signal is connected -- is undefined-behavior access to
      // a disposed GObject, exactly the class of bug a previous karen
      // gate already found and fixed once in this same file (see the
      // "unparented" test's own comment on why it reads the STABLE
      // ANCESTOR's child count instead of the destroyed button). A
      // disposed-object read "passing" by returning a falsy value proves
      // nothing -- it is not a valid assertion, it is a crash that
      // happened not to throw JS-catchably.
      // FIX: verified instead via (1) the PRE-disable check above, which
      // proves the signal genuinely WAS connected on the live object
      // (not a vacuous "never connected" pass), (2) the "every
      // enable()-assigned instance field is nulled" test below, which
      // confirms `_hoverSignalId` is nulled, and (3) the source-level
      // fact that disable() unconditionally calls
      // `this._button.disconnect(this._hoverSignalId)` BEFORE
      // `this._button.destroy()` -- see extension.js's own disable().
      // This is the exact same verification boundary this file already
      // uses for `_labelStyleChangedId` (connected to the equally-
      // destroyed this._label) and `_menuOpenStateId` (Signals-mixin,
      // not a real GObject signal at all) -- see this test's own
      // pre-existing NOTE comment above for that precedent.
    });

    record('teardown: the pending hover-show GLib timeout scheduled just before disable() does not survive it -- a real GLib.MainContext proof, not just a nulled JS field', () => {
      assertTrue(
        !GLib.MainContext.default().find_source_by_id(pendingHoverTimerId),
        'a hover-show timer that was pending at the moment disable() ran is still registered in the real GLib main context after disable() -- a real leaked timeout (shexli EGO-L-003)'
      );
    });

    record('teardown: the hover popup actor no longer exists in Main.layoutManager.uiGroup after disable() -- reference identity check only, never a method call on the destroyed object', () => {
      assertFalse(
        Main.layoutManager.uiGroup.get_children().includes(snapshot.hoverPopupObj),
        'the destroyed hover-popup actor is still a child of Main.layoutManager.uiGroup after disable()'
      );
    });

    record('teardown: every enable()-assigned instance field is nulled after disable()', () => {
      [
        '_button', '_label', '_menu', '_activeMenu', '_inactiveMenu', '_configMenu',
        '_state', '_settings', '_config', '_hint', '_labels', '_aliases',
        '_activeOrder', '_stateByZone', '_configSwitches', '_dropIndicator',
        '_rowDraggables', '_separatorId', '_formatting', '_formattingDefaults',
        '_separatorMenuItems',
        '_signalId', '_settingsChangedId', '_menuOpenStateId',
        '_labelStyleChangedId', '_ambientForegroundColorHex', '_applyingOwnLabelStyle',
        '_hoverPopup', '_hoverPopupBox', '_hoverShowTimeoutId', '_hoverSignalId',
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
        const hoverPopupObj2 = inst2._hoverPopup;

        // Also schedule a real pending hover-show timer in every cycle
        // (mirroring the dedicated pre-disable teardown check above), so
        // "no accumulating leaks" genuinely covers the timer too, not just
        // the two pre-existing signals.
        const entry2 = inst2._configSwitches.showHoverPopup;
        if (!entry2.getValue()) {
          entry2.item.toggle();
        }
        inst2._button.hover = true;
        const hoverTimerId2 = inst2._hoverShowTimeoutId;
        assertTrue(!!hoverTimerId2, `cycle ${i}: no hover-show timer was scheduled (test setup problem)`);
        // PRE-disable sanity check only (button is still alive here) --
        // deliberately no POST-disable GObject.signal_handler_is_connected()
        // check on the button in this loop, for the same reason the main
        // teardown section above no longer has one: this._button is
        // genuinely destroyed by disable(), so touching the same
        // reference afterwards is undefined-behavior access to a disposed
        // GObject (a real `Gjs-CRITICAL ... has been already disposed`,
        // caught once already by the shell-log scanner during this
        // feature's own development -- see the main teardown section's
        // comment for the full root-cause). `inst2._button === null`
        // below is the correct, disposal-safe verification instead.
        assertTrue(
          GObject.signal_handler_is_connected(inst2._button, inst2._hoverSignalId),
          `cycle ${i}: panel button "notify::hover" signal was not connected before disable() (test setup problem)`
        );

        const ok2 = extMgr.disableExtension(targetUuid);
        assertTrue(ok2 === true, `cycle ${i}: disableExtension returned ${ok2}`);

        assertFalse(GObject.signal_handler_is_connected(clockObj2, clockId2), `cycle ${i}: WallClock handler leaked`);
        assertFalse(GObject.signal_handler_is_connected(settingsObj2, settingsId2), `cycle ${i}: GSettings handler leaked`);
        assertFalse(!!GLib.MainContext.default().find_source_by_id(hoverTimerId2), `cycle ${i}: pending hover-show timer leaked past disable()`);
        assertFalse(
          Main.layoutManager.uiGroup.get_children().includes(hoverPopupObj2),
          `cycle ${i}: hover popup actor still a child of uiGroup after disable()`
        );
        assertTrue(inst2._button === null, `cycle ${i}: _button not nulled after disable()`);
        assertTrue(inst2._hoverPopup === null, `cycle ${i}: _hoverPopup not nulled after disable()`);
        assertTrue(inst2._hoverShowTimeoutId === null, `cycle ${i}: _hoverShowTimeoutId not nulled after disable()`);
        assertTrue(inst2._hoverSignalId === null, `cycle ${i}: _hoverSignalId not nulled after disable()`);
      }
    });

    // =====================================================================
    // Hover-popup teardown interleavings (precautionary hardening, see
    // tests/README.md's "Unreproduced flake" note).
    //
    // CONTEXT: a teardown assertion in the "three further enable/disable
    // cycles" test above failed exactly ONCE during a full four-resolution
    // matrix sweep, and was never reproduced again across 78 further runs
    // (40 standalone at 1024x768, 26 standalone at 1280x720, 3 full
    // sweeps -- see tests/README.md for the full record). The most
    // plausible mechanism -- disable() landing at an unlucky moment in the
    // hover lifecycle (mid-show-schedule, mid-show, mid-hide) and leaving
    // a handler/timer live -- was audited directly against extension.js's
    // disable() and found to ALREADY be safe by construction: GJS/Clutter
    // run a single-threaded main loop, so disable() (itself always run to
    // completion synchronously, no `await` anywhere inside it) can never
    // truly interleave with a GLib timeout callback or a GObject signal
    // handler's OWN execution -- only ever run strictly before or after
    // one, never during. disable() cancels the show-timer
    // (GLib.Source.remove(), only ever reached BEFORE the callback's own
    // dispatch, never during it) and disconnects 'notify::hover' before
    // destroying anything, so neither can fire once teardown has begun.
    // As a SECOND, independent layer, _showHoverPopup()/
    // _onButtonHoverChanged() also already null-check every field they
    // touch (this._config, this._hoverPopup/this._hoverPopupBox,
    // this._button) before dereferencing it -- so even a hypothetical
    // future refactor that broke the ordering guarantee above would
    // degrade to a safe no-op here, not a crash against torn-down state.
    // The sections below drive disable() at each of the three awkward
    // moments directly (not relying on real wall-clock timing, so they are
    // deterministic rather than luck-dependent) and prove no leaks either
    // way, plus drive the hover callbacks directly AFTER disable() to
    // prove that second guard is real, not theoretical.
    //
    // ONE GENUINE THING THIS INVESTIGATION DID FIND, and deliberately did
    // NOT "fix" in extension.js: destroying this._hoverPopup in the EXACT
    // SAME synchronous JS turn as its own open() call (i.e. calling
    // extMgr.disableExtension() with zero mainloop turns elapsed since
    // _showHoverPopup()) can produce a real
    // `Gjs-CRITICAL ... has been already disposed` from GNOME Shell's OWN
    // Main.layoutManager machinery. Root-caused by GObject-pointer
    // identity (a debug probe logging this._hoverPopup's own address at
    // creation/destruction, matched hex-for-hex against the disposed
    // object's address in the crash line) and confirmed with a completely
    // UNMODIFIED extension.js (no hide()/close() added, plain
    // `this._hoverPopup.destroy()`): the crash reproduces identically
    // either way, and disappears either way once a single real mainloop
    // turn elapses between show and disable. That proves it is not a
    // defect in this extension's teardown ordering -- it is a same-tick
    // artifact of GNOME Shell's own frame-scheduled bookkeeping, and a
    // real disable() can never be invoked in that same tick in the first
    // place (see interleaving B's own comment below for why). Interleaving
    // B and C below therefore use a short, explicitly-justified settle
    // rather than a literal zero-turn call, and tests/README.md records
    // this finding for posterity.
    // =====================================================================

    await recordAsync(
      'hover teardown interleaving A: disable() with a show-timer PENDING (scheduled but not yet fired) leaves nothing behind, and a subsequent enable() works cleanly',
      async () => {
        const ok1 = extMgr.enableExtension(targetUuid);
        assertTrue(ok1 === true, `enableExtension returned ${ok1}`);
        const meta = await waitUntil(() => {
          const m = extMgr.lookup(targetUuid);
          return m && m.stateObj ? m : null;
        });
        assertTrue(!!meta, 'stateObj never appeared after enable() (interleaving A setup)');
        const instA = meta.stateObj;

        const entry = instA._configSwitches.showHoverPopup;
        if (!entry.getValue()) {
          entry.item.toggle();
        }
        assertTrue(instA._menu.isOpen === false, 'main menu must be closed for this setup step (test setup problem)');

        instA._button.hover = true; // real property write -> real 'notify::hover' -> real _scheduleHoverPopupShow()
        const timerId = instA._hoverShowTimeoutId;
        assertTrue(!!timerId, 'no hover-show timer was scheduled (test setup problem)');
        assertTrue(
          !!GLib.MainContext.default().find_source_by_id(timerId),
          'scheduled timer source does not actually exist before disable() (test setup problem)'
        );
        assertTrue(instA._hoverPopup.visible === false, 'popup must not be visible yet -- the show-timer has not fired (test setup problem)');

        const hoverPopupObj = instA._hoverPopup;

        const ok2 = extMgr.disableExtension(targetUuid);
        assertTrue(ok2 === true, `disableExtension returned ${ok2}`);

        assertFalse(
          !!GLib.MainContext.default().find_source_by_id(timerId),
          'a show-timer that was PENDING at the moment disable() ran leaked past teardown (real GLib.MainContext proof)'
        );
        assertFalse(
          Main.layoutManager.uiGroup.get_children().includes(hoverPopupObj),
          'the hover-popup actor is still a child of uiGroup after disable() (pending-timer interleaving)'
        );
        ['_hoverPopup', '_hoverPopupBox', '_hoverShowTimeoutId', '_hoverSignalId', '_button', '_config'].forEach((field) => {
          assertTrue(instA[field] === null, `${field} is not null after disable() (pending-timer interleaving): ${JSON.stringify(instA[field])}`);
        });

        // Drive the timeout callback's own body directly, AFTER teardown
        // -- the real GLib source is already gone (proven above), so this
        // exact call can never happen via the real main loop; this proves
        // the SEPARATE defense-in-depth guard inside _showHoverPopup()
        // itself is real: calling it against a fully torn-down instance
        // must not throw and must not resurrect the destroyed popup actor.
        let threw = null;
        try {
          instA._showHoverPopup();
        } catch (e) {
          threw = e;
        }
        assertTrue(threw === null, `calling _showHoverPopup() on a disabled instance threw: ${threw}`);
        assertFalse(
          Main.layoutManager.uiGroup.get_children().includes(hoverPopupObj),
          '_showHoverPopup() called after disable() resurrected/re-added the destroyed popup actor to uiGroup'
        );

        // A subsequent enable() must still work cleanly.
        const ok3 = extMgr.enableExtension(targetUuid);
        assertTrue(ok3 === true, `re-enableExtension after pending-timer interleaving returned ${ok3}`);
        const meta2 = await waitUntil(() => {
          const m = extMgr.lookup(targetUuid);
          return m && m.stateObj ? m : null;
        });
        assertTrue(!!meta2, 'stateObj never reappeared after re-enable following pending-timer interleaving');
        const instA2 = meta2.stateObj;
        instA2._updateLabel();
        assertTrue(/\S/.test(instA2._label.clutter_text.get_text()), 'panel text is empty after re-enable following pending-timer interleaving');
        assertTrue(
          GObject.signal_handler_is_connected(instA2._button, instA2._hoverSignalId),
          'notify::hover not reconnected after re-enable following pending-timer interleaving'
        );

        const ok4 = extMgr.disableExtension(targetUuid);
        assertTrue(ok4 === true, `cleanup disableExtension after pending-timer interleaving returned ${ok4}`);
      }
    );

    await recordAsync(
      'hover teardown interleaving B: disable() called WHILE the popup is genuinely showing leaves nothing behind, and a subsequent enable() works cleanly',
      async () => {
        const ok1 = extMgr.enableExtension(targetUuid);
        assertTrue(ok1 === true, `enableExtension returned ${ok1}`);
        const meta = await waitUntil(() => {
          const m = extMgr.lookup(targetUuid);
          return m && m.stateObj ? m : null;
        });
        assertTrue(!!meta, 'stateObj never appeared after enable() (interleaving B setup)');
        const instB = meta.stateObj;
        // Let the freshly-enabled button's own panel allocation settle
        // before touching hover state -- same discipline this file's
        // module-header warm-up comment already documents for the FIRST
        // BoxPointer.open() in a process (a NaN allocation otherwise),
        // and the same 300ms this file already uses after every OTHER
        // real _showHoverPopup()/open() call (see "hover popup: rendering"
        // above). Without this, _showHoverPopup()'s own
        // BoxPointer._reposition() can read this._button's allocation
        // before the panel has ever laid it out, which measured directly
        // as the exact same `clutter_actor_set_allocation_internal:
        // assertion '!isnan(...)' failed` class of bug during this
        // section's own investigation.
        await sleep(300);

        const entry = instB._configSwitches.showHoverPopup;
        if (!entry.getValue()) {
          entry.item.toggle();
        }
        assertTrue(instB._menu.isOpen === false, 'main menu must be closed for this setup step (test setup problem)');

        instB._showHoverPopup(); // real show path, synchronous under PopupAnimation.NONE
        assertTrue(instB._hoverPopup.visible === true, 'popup did not become visible (test setup problem)');
        assertTrue(instB._hoverPopupBox.get_n_children() > 0, 'popup has no rows while showing (test setup problem)');

        const hoverPopupObj = instB._hoverPopup;

        // A short settle here (one real mainloop turn, NOT the 400ms
        // show-delay) before disabling -- NOT because extension.js's
        // teardown needs it. It does not: the investigation behind this
        // section (see tests/README.md's "hover-popup teardown
        // interleavings" note) proved, by GObject-pointer identity, that
        // calling extMgr.disableExtension() in the LITERAL SAME
        // synchronous JS turn as _showHoverPopup()'s open() call can hit a
        // real `Gjs-CRITICAL ... has been already disposed`, but it comes
        // from GNOME Shell's OWN Main.layoutManager machinery (a
        // `Meta.later_add()`-scheduled callback queued for the NEXT frame,
        // entirely outside this extension's code), and it reproduces
        // identically even with a completely UNMODIFIED extension.js
        // (plain `this._hoverPopup.destroy()`, nothing more) -- proving it
        // is not a defect in this extension's teardown at all. Crucially,
        // that exact zero-mainloop-turn construction can never happen via
        // a REAL disable(): GNOME Shell's ExtensionManager only ever
        // invokes disable() in response to an EXTERNAL event (a D-Bus
        // call, a keybinding, session lock) -- inherently a SEPARATE
        // mainloop turn from whatever caused the popup to be showing, so
        // at least one real turn has always already elapsed by the time a
        // genuine disable() runs. This settle reproduces that same
        // minimum realistic gap (measured sufficient: the crash reproduces
        // 100% of the time without it, 0% of the time with it, across
        // every run since), so this test still genuinely proves "disable()
        // while the popup is showing" safe, without asserting a
        // sub-mainloop-turn race no real invocation of disable() could
        // ever produce.
        await sleep(300);

        const ok2 = extMgr.disableExtension(targetUuid);
        assertTrue(ok2 === true, `disableExtension returned ${ok2}`);

        assertFalse(
          Main.layoutManager.uiGroup.get_children().includes(hoverPopupObj),
          'the hover-popup actor is still a child of uiGroup after disable() (mid-show interleaving)'
        );
        ['_hoverPopup', '_hoverPopupBox', '_hoverShowTimeoutId', '_hoverSignalId'].forEach((field) => {
          assertTrue(instB[field] === null, `${field} is not null after disable() (mid-show interleaving): ${JSON.stringify(instB[field])}`);
        });

        const ok3 = extMgr.enableExtension(targetUuid);
        assertTrue(ok3 === true, `re-enableExtension after mid-show interleaving returned ${ok3}`);
        const meta2 = await waitUntil(() => {
          const m = extMgr.lookup(targetUuid);
          return m && m.stateObj ? m : null;
        });
        assertTrue(!!meta2, 'stateObj never reappeared after re-enable following mid-show interleaving');
        const instB2 = meta2.stateObj;
        assertTrue(instB2._hoverPopup.visible === false, 'newly-built hover popup is somehow already visible right after enable() (mid-show interleaving)');
        assertTrue(
          Main.layoutManager.uiGroup.get_children().includes(instB2._hoverPopup),
          'newly-built hover popup was not added to uiGroup after re-enable (mid-show interleaving)'
        );

        const ok4 = extMgr.disableExtension(targetUuid);
        assertTrue(ok4 === true, `cleanup disableExtension after mid-show interleaving returned ${ok4}`);
      }
    );

    await recordAsync(
      'hover teardown interleaving C: disable() called shortly after a hide, before any real settle beyond the one mainloop turn GNOME Shell itself always needs (see interleaving B\'s own comment), leaves nothing behind, and a subsequent enable() works cleanly',
      async () => {
        const ok1 = extMgr.enableExtension(targetUuid);
        assertTrue(ok1 === true, `enableExtension returned ${ok1}`);
        const meta = await waitUntil(() => {
          const m = extMgr.lookup(targetUuid);
          return m && m.stateObj ? m : null;
        });
        assertTrue(!!meta, 'stateObj never appeared after enable() (interleaving C setup)');
        const instC = meta.stateObj;
        // Same settle, same reason -- see interleaving B's own comment.
        await sleep(300);

        const entry = instC._configSwitches.showHoverPopup;
        if (!entry.getValue()) {
          entry.item.toggle();
        }
        assertTrue(instC._menu.isOpen === false, 'main menu must be closed for this setup step (test setup problem)');

        instC._showHoverPopup();
        assertTrue(instC._hoverPopup.visible === true, 'popup did not become visible (test setup problem)');
        instC._hideHoverPopup();
        assertTrue(instC._hoverPopup.visible === false, 'popup did not become hidden -- BoxPointer.close(NONE) is expected to be synchronous (test setup problem)');

        // Same short, one-mainloop-turn settle as interleaving B above,
        // and for the identical reason (see its comment in full) -- a real
        // disable() can never land in the SAME synchronous JS turn as the
        // hide/show above, since it is always dispatched by
        // ExtensionManager from a separate mainloop turn. Genuinely
        // proves the "just hidden, no real settle beyond that" moment,
        // without asserting an unreachable sub-mainloop-turn race that
        // reproduces identically against an unmodified extension.js and a
        // bare GNOME Shell BoxPointer (see tests/README.md).
        const hoverPopupObj = instC._hoverPopup;
        await sleep(300);

        const ok2 = extMgr.disableExtension(targetUuid);
        assertTrue(ok2 === true, `disableExtension returned ${ok2}`);

        assertFalse(
          Main.layoutManager.uiGroup.get_children().includes(hoverPopupObj),
          'the hover-popup actor is still a child of uiGroup after disable() (immediate-post-hide interleaving)'
        );
        ['_hoverPopup', '_hoverPopupBox', '_hoverShowTimeoutId', '_hoverSignalId'].forEach((field) => {
          assertTrue(instC[field] === null, `${field} is not null after disable() (immediate-post-hide interleaving): ${JSON.stringify(instC[field])}`);
        });

        const ok3 = extMgr.enableExtension(targetUuid);
        assertTrue(ok3 === true, `re-enableExtension after immediate-post-hide interleaving returned ${ok3}`);
        const meta2 = await waitUntil(() => {
          const m = extMgr.lookup(targetUuid);
          return m && m.stateObj ? m : null;
        });
        assertTrue(!!meta2, 'stateObj never reappeared after re-enable following immediate-post-hide interleaving');
        const instC2 = meta2.stateObj;
        instC2._updateLabel();
        assertTrue(/\S/.test(instC2._label.clutter_text.get_text()), 'panel text is empty after re-enable following immediate-post-hide interleaving');

        const ok4 = extMgr.disableExtension(targetUuid);
        assertTrue(ok4 === true, `cleanup disableExtension after immediate-post-hide interleaving returned ${ok4}`);
      }
    );

    await recordAsync(
      'hover teardown: the real timeout-callback body AND the real notify::hover handler are both harmless if invoked directly right after disable() -- proves the defense-in-depth null-guards themselves, not just that the real GLib source/signal are gone',
      async () => {
        const ok1 = extMgr.enableExtension(targetUuid);
        assertTrue(ok1 === true, `enableExtension returned ${ok1}`);
        const meta = await waitUntil(() => {
          const m = extMgr.lookup(targetUuid);
          return m && m.stateObj ? m : null;
        });
        assertTrue(!!meta, 'stateObj never appeared after enable() (post-disable callback probe setup)');
        const instD = meta.stateObj;

        const ok2 = extMgr.disableExtension(targetUuid);
        assertTrue(ok2 === true, `disableExtension returned ${ok2}`);

        let threw = null;
        try {
          instD._showHoverPopup();
          instD._onButtonHoverChanged();
        } catch (e) {
          threw = e;
        }
        assertTrue(threw === null, `calling the hover callbacks directly on a disabled instance threw: ${threw}`);

        const ok3 = extMgr.enableExtension(targetUuid);
        assertTrue(ok3 === true, `re-enableExtension after post-disable callback probe returned ${ok3}`);
        const meta2 = await waitUntil(() => {
          const m = extMgr.lookup(targetUuid);
          return m && m.stateObj ? m : null;
        });
        assertTrue(!!meta2, 'stateObj never reappeared after re-enable following post-disable callback probe');

        const ok4 = extMgr.disableExtension(targetUuid);
        assertTrue(ok4 === true, `cleanup disableExtension after post-disable callback probe returned ${ok4}`);
      }
    );

    await recordAsync(
      'hover teardown: disable() after a session that NEVER touched the "Show dates on hover" toggle (the lazy popup was never created at all) is clean -- no errors, uiGroup child count unaffected, every field already-null stays null',
      async () => {
        // Normalize the PERSISTED 'config' gsetting back to
        // showHoverPopup=false first, via a genuinely throwaway
        // enable/fix/disable cycle. Several earlier sections (the
        // interleaving A/B/C tests, the "three further enable/disable
        // cycles" loop) deliberately turn the switch ON via the real
        // switch to exercise OTHER behavior, and none of them restore it
        // off afterward -- config is a shared, persisted gsetting
        // (verified pre-existing behavior, not something this test
        // should assume away), so by this point in the file it may well
        // still be persisted true. This throwaway cycle's own instance
        // DOES touch the switch (that is the point -- it is the fix-up,
        // not the test), so it is fully separate from instE below, which
        // is the one required to never touch it at all.
        const throwawayOk1 = extMgr.enableExtension(targetUuid);
        assertTrue(throwawayOk1 === true, `enableExtension (normalize-config throwaway) returned ${throwawayOk1}`);
        const throwawayMeta = await waitUntil(() => {
          const m = extMgr.lookup(targetUuid);
          return m && m.stateObj ? m : null;
        });
        assertTrue(!!throwawayMeta, 'stateObj never appeared after enable() (normalize-config throwaway)');
        const throwawayEntry = throwawayMeta.stateObj._configSwitches.showHoverPopup;
        if (throwawayEntry.getValue()) {
          throwawayEntry.item.toggle();
        }
        assertTrue(throwawayEntry.getValue() === false, 'failed to normalize showHoverPopup back to false (normalize-config throwaway)');
        const throwawayOk2 = extMgr.disableExtension(targetUuid);
        assertTrue(throwawayOk2 === true, `disableExtension (normalize-config throwaway) returned ${throwawayOk2}`);

        // A raw uiGroup CHILD-COUNT comparison across this throwaway
        // cycle's disable() and the real cycle's enable() below is NOT
        // used here (unlike the single-session "off by default" and
        // "repeated toggle" tests above, which stay within one unbroken
        // session): two separate enable()/disable() cycles, with a real
        // `await waitUntil()` poll in between, leave room for entirely
        // unrelated GNOME Shell chrome (notification banners, etc.) to
        // legitimately come or go and shift the total count for reasons
        // that have nothing to do with this extension. The
        // accessible_name-based check below is the count-independent
        // equivalent: this feature's own popup actor always sets
        // accessible_name to the SAME literal string (see
        // _initHoverPopup()), so its absence is a precise, real,
        // Clutter-level proof regardless of what else is in uiGroup.
        const hasHoverPopupActor = () => Main.layoutManager.uiGroup.get_children().some((child) => child.accessible_name === 'Timezones hover popup');
        assertFalse(hasHoverPopupActor(), 'a hover-popup actor already exists in uiGroup before the never-touched cycle even starts (test setup problem)');

        const ok1 = extMgr.enableExtension(targetUuid);
        assertTrue(ok1 === true, `enableExtension returned ${ok1}`);
        const meta = await waitUntil(() => {
          const m = extMgr.lookup(targetUuid);
          return m && m.stateObj ? m : null;
        });
        assertTrue(!!meta, 'stateObj never appeared after enable() (never-enabled-hover setup)');
        const instE = meta.stateObj;

        // Never touch instE._configSwitches.showHoverPopup at all --
        // the now-normalized persisted value (false) is left exactly
        // as-is, so _initHoverPopup() is never called by
        // _syncHoverPopupLifecycle() in _initMenu(), and the popup/signal
        // genuinely never exist for the whole lifetime of THIS instance.
        assertTrue(instE._config.showHoverPopup === false, 'test setup problem: showHoverPopup should be false after the normalize-config throwaway cycle');
        assertTrue(instE._hoverPopup === null, 'a popup actor exists despite the toggle never being touched (test setup problem)');
        assertTrue(instE._hoverSignalId === null, 'a notify::hover connection exists despite the toggle never being touched (test setup problem)');
        assertFalse(hasHoverPopupActor(), 'a hover-popup actor exists in uiGroup right after enable() with the toggle never touched');

        let threw = null;
        try {
          const ok2 = extMgr.disableExtension(targetUuid);
          assertTrue(ok2 === true, `disableExtension returned ${ok2}`);
        } catch (e) {
          threw = e;
        }
        assertTrue(threw === null, `disable() after a never-enabled hover session threw: ${threw}`);

        // Still nothing to show for it afterward either -- _teardownHoverPopup()
        // (called unconditionally by disable()) was a genuine no-op the
        // whole way through, not a silently-swallowed error.
        assertTrue(instE._hoverPopup === null, '_hoverPopup is not null after disable() (never-enabled-hover session)');
        assertTrue(instE._hoverPopupBox === null, '_hoverPopupBox is not null after disable() (never-enabled-hover session)');
        assertTrue(instE._hoverShowTimeoutId === null, '_hoverShowTimeoutId is not null after disable() (never-enabled-hover session)');
        assertTrue(instE._hoverSignalId === null, '_hoverSignalId is not null after disable() (never-enabled-hover session)');
        assertFalse(hasHoverPopupActor(), 'a hover-popup actor exists in uiGroup after disable() following a never-enabled hover session');
      }
    );

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
