/**
 * One live answer to prefers-reduced-motion, for everything that moves.
 *
 * It used to be read once, by the journey alone, at start-up: change the
 * setting with the page open and nothing noticed, and the parts outside the
 * journey never asked at all. Now there is one query, it follows the setting
 * as it changes, and the stylesheet answers the same question with the same
 * media query.
 *
 * What it switches, everywhere: nothing moves that the viewer did not move.
 * No drift, no idle orbit, chapter jumps cut rather than fly, and captions
 * fade without rising. Movement the viewer makes -- scrolling, dragging,
 * holding a key -- still moves.
 */
const query = window.matchMedia('(prefers-reduced-motion: reduce)');

let reduced = query.matches;
const listeners = new Set();

query.addEventListener('change', (e) => {
  reduced = e.matches;
  for (const fn of listeners) fn(reduced);
});

export function prefersReducedMotion() {
  return reduced;
}

/** Call `fn(reduced)` whenever the preference changes. Returns an unsubscribe. */
export function onReducedMotionChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
