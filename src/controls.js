/**
 * The strip along the bottom: the progress hairline, which is also a
 * scrubber, and a step back and forward between chapters.
 *
 * The journey is still one continuous t and still driven by scrolling, a held
 * key or two fingers. What this adds is for the people those do not serve: a
 * phone held in one hand, where one finger is already looking around; and a
 * keyboard, which could hold a key down but could not stop anywhere on
 * purpose or reach a control by Tab.
 *
 *   PageDown, N    next chapter          PageUp, P    previous chapter
 *   Home           the start             End          the end
 *   Space, arrows  travel, while held    Shift+Space  travel back
 *
 * With the scrubber focused, the arrows step it instead, as a slider's do.
 */

const STEP = 0.01; // t per arrow press on the focused scrubber
const EPS = 0.002;

function firstSentence(text) {
  const m = /^.*?[.!?](?=\s|$)/.exec(text);
  return m ? m[0] : text;
}

export function mountControls({ journey, stops, captions }) {
  const slider = document.getElementById('progress');
  const track = slider.querySelector('.progress__track');
  const fill = document.getElementById('progress-fill');
  const thumb = slider.querySelector('.progress__thumb');
  const prev = document.getElementById('prev');
  const next = document.getElementById('next');
  const hint = document.getElementById('hint');

  for (const s of stops.slice(1, -1)) {
    const tick = document.createElement('span');
    tick.className = 'progress__tick';
    tick.style.left = `${(s * 100).toFixed(2)}%`;
    track.appendChild(tick);
  }

  // Say what actually works on this device.
  const touch = window.matchMedia('(pointer: coarse)');
  const setHint = () => {
    hint.textContent = touch.matches
      ? 'drag to look around · tap › to travel'
      : 'scroll, or hold space';
  };
  touch.addEventListener('change', setHint);
  setHint();

  // Chapters are counted from where the viewer is headed, not where the
  // camera happens to be mid-flight, so pressing twice goes two chapters.
  const nextStop = () => stops.find((s) => s > journey.state.target + EPS) ?? 1;
  const prevStop = () => [...stops].reverse().find((s) => s < journey.state.target - EPS) ?? 0;
  const goNext = () => journey.jump(nextStop());
  const goPrev = () => journey.jump(prevStop());

  prev.addEventListener('click', () => { if (prev.getAttribute('aria-disabled') !== 'true') goPrev(); });
  next.addEventListener('click', () => { if (next.getAttribute('aria-disabled') !== 'true') goNext(); });

  function chapterKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    switch (e.key) {
      case 'PageDown': case 'n': case 'N': goNext(); return true;
      case 'PageUp': case 'p': case 'P': goPrev(); return true;
      case 'Home': journey.jump(0); return true;
      case 'End': journey.jump(1); return true;
      default: return false;
    }
  }

  window.addEventListener('keydown', (e) => {
    if (e.target === slider) return;
    if (e.target instanceof Element && e.target.closest('input, textarea, select')) return;
    if (chapterKey(e)) e.preventDefault();
  });

  slider.addEventListener('keydown', (e) => {
    let handled = true;
    switch (e.key) {
      case 'ArrowRight': case 'ArrowUp':
        journey.setTarget(journey.state.target + STEP * (e.shiftKey ? 5 : 1)); break;
      case 'ArrowLeft': case 'ArrowDown':
        journey.setTarget(journey.state.target - STEP * (e.shiftKey ? 5 : 1)); break;
      default: handled = chapterKey(e);
    }
    if (handled) e.preventDefault();
  });

  // Press anywhere on the line to go there; drag along it to scrub.
  const fromPointer = (e) => {
    const r = track.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / Math.max(r.width, 1)));
  };
  slider.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    slider.setPointerCapture(e.pointerId);
    slider.classList.add('is-dragging');
    journey.setTarget(fromPointer(e));
  });
  const endDrag = () => slider.classList.remove('is-dragging');
  slider.addEventListener('pointerup', endDrag);
  slider.addEventListener('pointercancel', endDrag);
  slider.addEventListener('pointermove', (e) => {
    if (slider.hasPointerCapture(e.pointerId)) journey.setTarget(fromPointer(e));
  });

  let lastFill = -1;
  let lastValue = -1;
  let lastChapter = -2;
  let lastEnds = '';

  return {
    /** Reflect the journey's position; cheap when nothing visible changed. */
    update(t, chapter) {
      if (Math.abs(t - lastFill) > 0.0008) {
        fill.style.transform = `scaleX(${t.toFixed(4)})`;
        thumb.style.left = `${(t * 100).toFixed(2)}%`;
        lastFill = t;
      }
      const value = Math.round(t * 100);
      if (value !== lastValue) {
        slider.setAttribute('aria-valuenow', String(value));
        lastValue = value;
      }
      if (chapter !== lastChapter) {
        slider.setAttribute(
          'aria-valuetext',
          chapter < 0
            ? 'The start'
            : `Part ${chapter + 1} of ${captions.length}: ${firstSentence(captions[chapter].text)}`
        );
        lastChapter = chapter;
      }
      const target = journey.state.target;
      const ends = `${target <= EPS}${target >= 1 - EPS}`;
      if (ends !== lastEnds) {
        prev.setAttribute('aria-disabled', String(target <= EPS));
        next.setAttribute('aria-disabled', String(target >= 1 - EPS));
        lastEnds = ends;
      }
    },
  };
}
