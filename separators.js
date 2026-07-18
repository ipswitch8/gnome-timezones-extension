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
