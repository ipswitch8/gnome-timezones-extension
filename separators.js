// separators.js
//
// THE single place to customize the list of selectable separators used
// between timezone entries in the panel and menu.
//
// Entry shape:
//   {
//     id:    string  // Stable identifier PERSISTED to GSettings (the
//                     // "separator" key stores a `value`, but prefs UI
//                     // code should key its selection state off `id`).
//                     // Renaming an `id` orphans any user's saved choice
//                     // (their stored value simply won't match any entry
//                     // any more, though the raw string value itself will
//                     // still render fine -- it just won't be recognized
//                     // as "selected" in a picker UI). Changing `label`
//                     // or `value` for an existing `id` is always safe.
//     label: string  // Human-readable name shown in preference UI.
//     value: string  // The literal string inserted between entries.
//                     // Each value INCLUDES its own surrounding spacing
//                     // (e.g. ' | ' rather than '|'), so the renderer
//                     // only needs to join entries with `value` directly
//                     // -- no extra spacing should be added by callers.
//   }
//
// Do not remove entries that may already be persisted in a user's
// GSettings `separator` key; prefer adding new ones.

export const SEPARATORS = [
  { id: 'spaces', label: 'Wide space', value: '    ' },
  { id: 'pipe', label: 'Pipe', value: ' | ' },
  { id: 'slash', label: 'Forward slash', value: ' / ' },
  { id: 'bullet', label: 'Bullet', value: ' • ' },
  { id: 'middle-dot', label: 'Middle dot', value: ' · ' },
  { id: 'small-bullet', label: 'Small bullet', value: ' ‧ ' },
  { id: 'en-dash', label: 'En dash', value: ' – ' },
  { id: 'em-dash', label: 'Em dash', value: ' — ' },
  { id: 'box-vertical', label: 'Vertical line', value: ' │ ' },
  { id: 'double-vertical', label: 'Double vertical line', value: ' ‖ ' },
  { id: 'comma', label: 'Comma', value: ', ' },
  { id: 'arrow', label: 'Right arrow', value: ' → ' },
  { id: 'star', label: 'Star', value: ' ★ ' },
];

export const DEFAULT_SEPARATOR_ID = 'spaces';

export function getSeparatorById(id) {
  return SEPARATORS.find((entry) => entry.id === id);
}

// Hard cap on the length of a literal (non-curated) separator string
// resolved from the free-form 'separator' GSettings key. That key is
// type `s` with no schema-level constraint to the curated list above --
// any process with dconf access can write an arbitrary string into it.
// This bounds how much RAW text a single hand-edited/tampered value can
// inject between every panel/menu entry -- the cap is applied here, to the
// raw value, BEFORE the caller escapes it via escapeMarkup() (this
// function does not escape; see its own doc comment). escapeMarkup() can
// expand any individual character up to 6x (e.g. '"' -> '&quot;'), so the
// FINAL escaped separator actually inserted into markup is bounded at
// roughly 6x this constant (~192 characters as of this writing), not at
// MAX_LITERAL_SEPARATOR_LENGTH itself. That larger bound is still real and
// intentional (unbounded growth is what this guards against); this
// comment exists only so the two numbers are not confused.
const MAX_LITERAL_SEPARATOR_LENGTH = 32;

/**
 * Resolve a stored 'separator' GSettings value to the literal string that
 * should be inserted between entries, or `null` if `stored` does not
 * request an override (i.e. is empty/not a string) -- callers should fall
 * back to their own legacy default in that case.
 *
 * Defensive by design: `stored` is NOT assumed to have come from the
 * curated SEPARATORS list above (see MAX_LITERAL_SEPARATOR_LENGTH
 * comment). If it matches a curated entry's `id`, that entry's `value`
 * is returned (trusted, already-known-safe text). Otherwise `stored`
 * itself is treated as a literal separator: returned as-is (the caller
 * is responsible for escaping it before inserting into markup -- this
 * function only resolves/bounds the value, it does not escape), capped
 * at MAX_LITERAL_SEPARATOR_LENGTH characters.
 */
export function resolveSeparatorValue(stored) {
  if (typeof stored !== 'string' || stored === '') {
    return null;
  }

  const entry = getSeparatorById(stored);
  if (entry) {
    return entry.value;
  }

  return stored.slice(0, MAX_LITERAL_SEPARATOR_LENGTH);
}
