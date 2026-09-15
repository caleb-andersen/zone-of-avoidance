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
press the arrow keys, or drag two fingers. There are no steps and nothing to
click.

| `t`    | what happens                                                         |
| ------ | -------------------------------------------------------------------- |
| `0`    | standing at the origin, free to look around; a bare stripe in the sky |
| `0→.35`| the heading sweeps a full circuit of galactic longitude               |
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

The foreground star field is also synthetic: an exponential disc plus a bulge
seen from 8 kpc out, with extinction integrated along each line of sight, which
is what carves the dark lane. It is a shell parented to the camera's position,
and its opacity is a function of camera radius rather than of `t` — being unable
to see out is a property of standing inside the Milky Way, so leaving removes it.

## Filming

`window.__zoa.setT(t)` seeks; `window.__zoa.step(dt)` advances one exact
timestep for frame-accurate capture; `#t=0.5` in the URL opens at a given point.
None of it is wired to any interface.

Data: Huchra et al. 2012, ApJS 199, 26 (VizieR J/ApJS/199/26/table3).
