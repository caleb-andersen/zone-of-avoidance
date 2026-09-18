/**
 * Rendering switches. Every one of these changes how the map looks and none of
 * them changes what it says, so each can be flipped on its own to compare.
 *
 *   hdr       float target, bloom, ACES filmic
 *   nebula    soft clouds where the measured galaxies are dense
 *   scale     render at this multiple of the display resolution, then resolve
 *   dof       shallow depth of field focused on the galactic plane
 *   depthCue  distant galaxies desaturate and sink towards the background
 *   mwNoise   fractal structure in the Milky Way: star clouds and dust
 *   camera    eased stops, and a slow drift so no frame is static
 *
 * The query string overrides the defaults: `?hdr=0&scale=2`, or `?fx=none` to
 * start from everything off (the look before this pass) and switch things on
 * one at a time, `?fx=none&dof=1`. `window.__zoa.fx({ hdr: false })` changes
 * them live. None of it is wired to any interface.
 */

export const FX_DEFAULTS = Object.freeze({
  hdr: true,
  nebula: true,
  scale: 1,
  dof: true,
  depthCue: true,
  mwNoise: true,
  camera: true,
});

const TRUE = new Set(['1', 'true', 'on', 'yes', '']);
const FALSE = new Set(['0', 'false', 'off', 'no']);

/** Render scale is clamped here, and again against the GPU's limits later. */
export const SCALE_RANGE = [0.5, 4];

export function sanitiseFx(fx) {
  const out = { ...fx };
  for (const key of Object.keys(FX_DEFAULTS)) {
    if (key === 'scale') {
      const v = Number(out.scale);
      out.scale = Number.isFinite(v)
        ? Math.min(SCALE_RANGE[1], Math.max(SCALE_RANGE[0], v))
        : FX_DEFAULTS.scale;
    } else {
      out[key] = Boolean(out[key]);
    }
  }
  for (const key of Object.keys(out)) {
    if (!(key in FX_DEFAULTS)) delete out[key];
  }
  return out;
}

export function readFx(search = window.location.search) {
  const params = new URLSearchParams(search);
  const fx = { ...FX_DEFAULTS };

  const preset = params.get('fx');
  if (preset === 'none' || preset === 'all') {
    for (const key of Object.keys(fx)) {
      if (key !== 'scale') fx[key] = preset === 'all';
    }
  }

  for (const key of Object.keys(FX_DEFAULTS)) {
    const raw = params.get(key) ?? params.get(key.toLowerCase());
    if (raw === null) continue;
    const v = raw.trim().toLowerCase();
    if (key === 'scale') fx.scale = parseFloat(v);
    else if (TRUE.has(v)) fx[key] = true;
    else if (FALSE.has(v)) fx[key] = false;
  }

  return sanitiseFx(fx);
}
