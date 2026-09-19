import { prefersReducedMotion } from './motion.js';

/**
 * Captions live on ranges of t, but they fade on the clock.
 *
 * Fading in t looked right at exactly one speed of travel. Scroll quickly and
 * a caption flashed past in a few frames; hold a key and the same fade took a
 * quarter of a second; stop on a boundary and the text sat half-faded
 * indefinitely. So t only decides which caption is wanted, and the change is
 * made at reading pace however fast t moved: the outgoing line falls away
 * quickly, and the next one rises -- slower, because arriving text is read
 * and departing text is not -- once the old one is mostly gone. Two lines are
 * never legible at once, and scrubbing through several ranges shows nothing
 * until the viewer settles, rather than a strobe of half-read sentences.
 *
 * The fades are advanced by the same timestep as the camera, so a
 * frame-accurate capture is still exact, and a seek snaps them.
 *
 * The estimates only ever appear while a caption naming them as estimates is
 * up, and the last caption names them again so the run is unbroken.
 */
const FADE_IN = 1.1; // seconds
const FADE_OUT = 0.5;
/** The incoming caption starts to rise once the outgoing one is below this, */
const HANDOVER = 0.3;
/** and once t has asked for it for this long, so that passing through does not ghost it. */
const DWELL = 0.45;
/** How far past a boundary t must go before the caption changes, in t. */
const HYSTERESIS = 0.003;
/** Full opacity: the captions are the quietest thing that must be read. */
const MAX_OPACITY = 0.88;
/** How long a caption must be settled before it is announced to a screen reader. */
const ANNOUNCE_AFTER = 0.8;

export function captionsFor(galaxyCount) {
  const n = galaxyCount.toLocaleString('en-GB');
  return [
    {
      from: 0.015,
      to: 0.185,
      text: `Every galaxy we have measured within 160 megaparsecs, ${n} of them, each one placed where it actually sits. You are at the origin, looking out from inside our own galaxy.`,
    },
    {
      from: 0.185,
      to: 0.335,
      text: 'One stripe of the sky has nothing in it. It is called the Zone of Avoidance, and however far you turn, it is still there.',
    },
    {
      from: 0.335,
      to: 0.470,
      text: 'We are inside the Milky Way, looking out through its own stars and dust. Nine per cent of the sky was never surveyed at all, and the outline runs wider than that: it is drawn where the counts fall below half of what the open sky holds, measured off the catalogue itself. This catalogue reads in the near infrared, which sees through dust far better than visible light does, so this is the best view we have rather than the worst.',
    },
    {
      from: 0.470,
      to: 0.610,
      text: 'The band is behind us now, and the gap has not closed. It is a hole in the record rather than in the universe: the measurements were made from inside, and moving does not un-make them.',
    },
    {
      from: 0.610,
      to: 0.850,
      text: 'The pale blue rings are estimates, not observations. We counted how densely galaxies sit in the sky we can see and filled the deficit to match, so their number means something while the position of any single one does not.',
    },
    {
      from: 0.850,
      to: 1.001,
      text: 'That one hot point is the Great Attractor, about 68 megaparsecs away and sitting inside the band, which is much of why it took so long to find. We are falling towards it at some 600 kilometres per second, and the pale blue estimates crowding around it are a measure of how much there we still have not seen.',
    },
  ];
}

/**
 * Where the chapter controls stop: the opening frame, the middle of each
 * caption's range -- where its scene is most itself -- and the end.
 */
export function chapterStops(entries) {
  const stops = [0];
  for (let i = 0; i < entries.length - 1; i++) {
    stops.push(Number(((entries[i].from + entries[i].to) / 2).toFixed(4)));
  }
  stops.push(1);
  return stops;
}

/** Which caption t asks for, keeping `current` while t is only just past its edge. */
function wantedAt(entries, t, current) {
  if (current >= 0) {
    const { from, to } = entries[current];
    if (t >= from - HYSTERESIS && t < to + HYSTERESIS) return current;
  }
  for (let i = 0; i < entries.length; i++) {
    if (t >= entries[i].from && t < entries[i].to) return i;
  }
  return -1;
}

const ease = (a) => a * a * (3 - 2 * a);

export function mountCaptions(container, announcer, entries) {
  const nodes = entries.map((entry) => {
    const p = document.createElement('p');
    p.className = 'caption';
    p.textContent = entry.text;
    container.appendChild(p);
    return p;
  });

  const level = new Array(entries.length).fill(0);
  const last = new Array(entries.length).fill(-1);
  let wanted = -1;
  let wantedFor = 0;
  let settled = 0;
  let announced = -1;

  function write(i) {
    const a = ease(level[i]);
    if (Math.abs(a - last[i]) < 0.002 && !(a === 0 && last[i] !== 0)) return;
    last[i] = a;
    const node = nodes[i];
    node.style.opacity = (a * MAX_OPACITY).toFixed(3);
    // A few pixels of rise as it arrives, none as it leaves, none at all
    // with motion reduced.
    const rising = i === wanted && !prefersReducedMotion();
    node.style.transform = rising && a < 1 ? `translateY(${((1 - a) * 0.35).toFixed(3)}em)` : '';
    node.style.visibility = a === 0 ? 'hidden' : 'visible';
  }

  /**
   * Advance by `dt` seconds at journey position `t`. With `seek`, jump
   * straight to the settled state, as a retake needs.
   */
  return function update(t, dt, seek = false) {
    const now = wantedAt(entries, t, wanted);
    wantedFor = now === wanted ? wantedFor + dt : 0;
    wanted = now;

    if (seek) {
      for (let i = 0; i < entries.length; i++) level[i] = i === wanted ? 1 : 0;
    } else if (dt > 0) {
      let outgoing = 0;
      for (let i = 0; i < entries.length; i++) {
        if (i === wanted) continue;
        level[i] = Math.max(0, level[i] - dt / FADE_OUT);
        outgoing = Math.max(outgoing, level[i]);
      }
      if (wanted >= 0 && outgoing < HANDOVER && (wantedFor >= DWELL || level[wanted] > 0)) {
        level[wanted] = Math.min(1, level[wanted] + dt / FADE_IN);
      }
    }
    for (let i = 0; i < entries.length; i++) write(i);

    // The live region hears a caption once, when it has settled, not every
    // caption scrubbed past on the way.
    if (wanted >= 0 && level[wanted] === 1) settled = seek ? ANNOUNCE_AFTER : settled + dt;
    else settled = 0;
    if (wanted >= 0 && wanted !== announced && settled >= ANNOUNCE_AFTER) {
      announcer.textContent = entries[wanted].text;
      announced = wanted;
    }

    return wanted;
  };
}
