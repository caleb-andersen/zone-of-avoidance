const FADE = 0.020;

/**
 * Captions live on ranges of t and cross-fade, rather than sitting in a box
 * that swaps its contents. Consecutive ranges abut exactly: one is fading out
 * as the next begins to rise, so two lines of text are never legible at once.
 * The estimates only ever appear while a caption naming them as estimates is
 * up, and the last caption names them again so the run is unbroken.
 */
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
      // Starts rising just before the previous one has finished falling. Every
      // other boundary is a clean hand-off, but the estimates are on screen
      // across this one and must never be left unexplained, so the two overlap
      // briefly -- both are under a sixth of full opacity while they cross, far
      // too faint to read as two captions at once.
      from: 0.850 - FADE * 0.3,
      to: 1.0 + FADE * 3,
      text: 'That one hot point is the Great Attractor, about 68 megaparsecs away and sitting inside the band, which is much of why it took so long to find. We are falling towards it at some 600 kilometres per second, and the pale blue estimates crowding around it are a measure of how much there we still have not seen.',
    },
  ];
}

export function mountCaptions(container, entries) {
  const nodes = entries.map((entry) => {
    const p = document.createElement('p');
    p.className = 'caption';
    p.textContent = entry.text;
    container.appendChild(p);
    return p;
  });

  let last = new Array(entries.length).fill(-1);

  return function update(t) {
    for (let i = 0; i < entries.length; i++) {
      const { from, to } = entries[i];
      let a = 0;
      if (t > from - FADE && t < to + FADE) {
        const rise = Math.min(1, Math.max(0, (t - from) / FADE));
        const fall = Math.min(1, Math.max(0, (to - t) / FADE));
        a = Math.min(rise, fall);
        a = a * a * (3 - 2 * a);
      }
      if (Math.abs(a - last[i]) > 0.002) {
        nodes[i].style.opacity = (a * 0.74).toFixed(3);
        last[i] = a;
      }
    }
  };
}
