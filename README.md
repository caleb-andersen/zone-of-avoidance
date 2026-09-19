# zone-of-avoidance

A 3D map of every galaxy 2MRS measured within 160 megaparsecs, built so that
one fact arrives without being stated: there is a band of sky we cannot see
through, because our own galaxy is in the way.

Run it:

```bash
npm install
npm run dev
```

## The journey

Everything is derived from a single scalar `t` in `[0, 1]`. Scroll, hold space,
press the arrow keys, or drag two fingers. Along the bottom, the progress line
is also a scrubber, and `‹ ›` step between chapters — the middle of each
caption's range — for a phone held in one hand and for the keyboard:

| key              | does                                   |
| ---------------- | -------------------------------------- |
| Space, arrows    | travel while held (Shift+Space: back)  |
| PageDown, N      | next chapter                           |
| PageUp, P        | previous chapter                       |
| Home, End        | the start, the end                     |
| Tab              | the scrubber, then `‹` and `›`         |

With the scrubber focused, the arrows step it instead.

| `t`    | what happens                                                         |
| ------ | -------------------------------------------------------------------- |
| `0`    | standing at the origin, free to look around; a bare stripe in the sky |
| `0→.35`| the heading sweeps a full circuit of galactic longitude               |
| `~.21` | the measured edge of the blocked sky is outlined                      |
| `.35`  | the camera begins pulling out                                         |
| `~.42` | the Milky Way has fallen behind; the gap in the data has not closed   |
| `~.65` | the synthesised galaxies fade in                                      |
| `1`    | a slow orbit outside the cloud, the Great Attractor marked            |

The camera is one formula, `position = -viewDir * R(t)` looking along `viewDir`.
At `R = 0` that is a first-person look-around at the origin; at `R > 0` it is an
orbit about the origin. There is no second mode and no handover to blend.

## What is real and what is not

`public/data/2mrs.bin` is the observed catalogue: 43,507 galaxies, of which
31,697 fall inside the 160 Mpc cut. Positions, distances and K-band magnitudes
are measured.

The pale blue rings are not. 2MRS never surveyed `|b| < 5°`, or `|b| < 8°`
towards the bulge, so that sky is empty by construction rather than because the
universe is. `src/synthesize.js` estimates the deficit and fills it — about
4,400 galaxies. Their **number** is an estimate worth something; the position of
any individual one is not, which is why they are drawn hollow and in a colour
that matches nothing else on screen. They never appear without the caption that
says so.

The indigo wedge is measured, not drawn. `scripts/build-zoa-mask.mjs` bins the
whole catalogue into 180 × 138 equal-area cells in `(l, b)` — equal steps in
longitude and in `sin b`, so every cell holds the same solid angle — and scores
each cell against the median count over the unblocked part of its own `|b|`
ring. The mask is the contour where that ratio falls through 50%. Run it with
`npm run mask`; it writes `public/data/zoa-mask.json`, about 3 kB, and nothing
about the shape is computed in the browser.

Two things in that measurement need care. A ring cannot supply its own
reference where the survey observed nothing at any longitude, which below
`|b| = 5` is every ring, so rings that sit far below the level the open sky
settles at are handed the reference the surrounding latitudes measured instead;
left to themselves they would divide their own deficit by itself and report the
blocked sky complete. And the contour is never drawn inside the innermost
latitude actually observed at that longitude — which recovers 2MRS's own mask,
`|b| > 5` opening to `|b| > 8` towards the bulge, from the counts alone.

What comes out is `|b|` between 5.0° and 10.3°, mean 6.4°, covering 11.1% of
the sky against the 8.8% never observed at all. It is lumpy because the dust
is: the widest excursions sit over the Aquila Rift at `l ≈ 20–50`, over Cepheus
near `l ≈ 110`, and over Orion near `l ≈ 210`. The script splits the catalogue
in half at random and measures both halves independently to say how much of
that raggedness is real — 1.5° of structure against 0.2–0.6° of Poisson noise —
and prints the answer every time it runs. Longitude is smoothed at σ = 12°,
which is about the resolution seventeen galaxies per degree of longitude can
support, so structure narrower than roughly 25° is not claimed.

The foreground star field is also synthetic: an exponential disc plus a bulge
seen from 8 kpc out, with extinction integrated along each line of sight, which
is what carves the dark lane. It is a shell parented to the camera's position,
and its opacity is a function of camera radius rather than of `t` — being unable
to see out is a property of standing inside the Milky Way, so leaving removes it.
With `mwNoise` on, its clumps, filaments and dark lanes are fractal noise baked
once into a map in `(l, b)`, modelled on the character of a dark-site
photograph of the whole band (ESO's GigaGalaxy Zoom panorama). The large dark
complexes — Ophiuchus, the Aquila and Cygnus rifts, the Coalsack, Cepheus,
Taurus, Orion — sit where the real ones do; everything finer is invented.

The soft clouds around dense groups are light nobody measured. What they are
drawn from is measured: `scripts/build-density.mjs` gives every galaxy the
distance to its twelfth-nearest neighbour, and divides the density that implies
by the mean the survey reaches at that distance, because a flux-limited
catalogue thins out with distance for no other reason. Clusters come out 35 to
65 times the mean and the typical field galaxy about 3. Only observed galaxies
more than 4.5 times the mean get a cloud, and no cloud is drawn inside the
measured wedge. Run it with `npm run density`; it appends the density as a
fifth float to each row of `2mrs.bin` and records the mean-density table in
`2mrs.json`. Bloom is the same kind of thing: a property of lenses, not of the
sky. With both switched off, the wedge reads as empty exactly as it did before
either existed.

## Rendering switches

Each of these changes how the map looks and none changes what it says. All are
on by default except supersampling.

| switch     | what it does                                                        |
| ---------- | ------------------------------------------------------------------- |
| `hdr`      | float target, bloom on what is past white, ACES filmic tonemap       |
| `nebula`   | soft clouds where measured galaxies are dense                        |
| `scale`    | render at this multiple of the display resolution, then resolve (1)  |
| `dof`      | shallow depth of field, focused on the galactic plane                |
| `depthCue` | far galaxies desaturate and sink towards the background              |
| `mwNoise`  | fractal Milky Way: star clouds, filaments, dark lanes                |
| `camera`   | every stop eases out; a slow drift so no frame is static             |

Set them in the query string — `?hdr=0`, `?scale=2`, or `?fx=none` to start
from the look before any of them and add one back, `?fx=none&dof=1` — or live
with `window.__zoa.fx({ nebula: false })`. The tuning numbers for each are in
`src/constants.js`.

`prefers-reduced-motion` is read live (`src/motion.js`) and answered the same
way everywhere: nothing moves that the viewer did not move. The drift's clock
and the idle orbit stop, chapter steps cut instead of flying, and captions fade
without rising. Scrolling, dragging and held keys still move the camera. The depth of field only comes in
once the camera is out and above the plane: from the origin, the plane is seen
edge-on and focuses nothing.

## Filming

`window.__zoa.setT(t)` seeks; `window.__zoa.step(dt)` advances one exact
timestep for frame-accurate capture; `#t=0.5` in the URL opens at a given point.
The camera's easing and drift are exact functions of those timesteps, and a
seek resets the drift, so a retake is the same take. None of it is wired to any
interface.

Data: Huchra et al. 2012, ApJS 199, 26 (VizieR J/ApJS/199/26/table3).
