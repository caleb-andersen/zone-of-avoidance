// Everything tunable, in one place.

export const DATA_URL = 'data/2mrs.bin';
/** What the binary's columns are, and the density table that goes with them. */
export const MANIFEST_URL = 'data/2mrs.json';

/** The measured survey mask: see scripts/build-zoa-mask.mjs. */
export const MASK_URL = 'data/zoa-mask.json';

/** Hard distance cut, megaparsecs. "Every galaxy within about 160 Mpc." */
export const MAX_DISTANCE = 160;

/** K-band magnitude range in 2MRS, used to normalise brightness. */
export const MAG_BRIGHT = 3.815;
export const MAG_FAINT = 11.754;

/** Great Attractor, galactic coordinates. */
export const GREAT_ATTRACTOR = { l: 325, b: -7, distance: 68 };

/** Journey shape. */
export const T_PULLOUT = 0.35; // camera leaves the origin here
export const R_END = 205; // final orbit radius, Mpc
export const FOV_NEAR = 68; // vertical fov at the origin
export const FOV_FAR = 52; // vertical fov at the end
export const LON_START = 325; // we begin looking straight at the Great Attractor
export const LAT_SWEEP = 40; // degrees the opening circuit rides above/below b=0
// The empty wedge is a double cone. Viewed from well off the plane its near
// and far halves overlap in projection and fill each other in, so it stops
// looking empty. Near edge-on it reads as two voids opening out from us, which
// is what it actually is -- so the final orbit stays low.
export const LAT_END = 14;

/**
 * The blocked volume is drawn out to the edge of the catalogue, because that
 * is how far the claim goes: we cannot see through the band, and this map ends
 * at 160 Mpc.
 */
export const MASK_RADIUS = MAX_DISTANCE;
/** It fades in under the caption that names the Zone of Avoidance. */
export const MASK_IN = [0.205, 0.315];

/** Milky Way shell. Opacity is a function of camera radius, not of t. */
export const MW_SHELL_RADIUS = 60;
export const MW_FADE_END = 6.0; // Mpc: obstruction is gone once we are this far out

/** Palette. */
export const COLOR = {
  galaxyNear: 0xf2e8d8, // warm off-white
  galaxyFar: 0x7c8598, // dusty blue-grey
  synth: 0x7fa8c4, // cold pale blue: estimates
  attractor: 0xe8573f, // the only saturated thing on screen
  mwCore: 0xc9a227, // ochre
  mwBand: 0xb4655a, // rose
  mwDust: 0xb07a52, // starlight reddened by dust: brown, never pink
  mask: 0x5a4fc8, // indigo: the sky we could not see through
  maskRim: 0xa79cf5, // its hairline
};

export const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// The rendering pass. Each block is switched by a flag in src/fx.js.

/**
 * 1. HDR. The scene accumulates exactly as it always has -- the palette is
 * written in display values and additive sums of them -- but into a float
 * target, so a sum past 1.0 is kept instead of clipped. ACES then rolls it off.
 */
export const HDR = {
  /**
   * Gamma the accumulated display values are decoded with before bloom and
   * ACES, and re-encoded with after. 2.2 is the textbook choice and crushes
   * everything under about a tenth of white to black, which is most of this
   * scene; 1 applies the curve to the display values directly, which keeps the
   * shadows as they were graded and still gives the highlights a shoulder.
   */
  decodeGamma: 1.0,
  exposure: 1.05,
  /** Bloom, in the decoded domain. Only what is already past white spreads. */
  bloomThreshold: 0.85,
  bloomKnee: 0.45,
  bloomIntensity: 0.32,
  /** How much of each coarser level carries up: higher is a wider glow. */
  bloomScatter: 0.62,
  bloomLevels: 6,
  /** Bright nuclei are allowed past white, in proportion to how bright. */
  coreGain: 2.4,
  /** And the brightest reach of the band. */
  bandGain: 0.5,
};

/**
 * 2. Nebulosity. One large soft sprite per measured galaxy, sized from its
 * neighbour distance and weighted by its overdensity, accumulated at low
 * resolution and compressed so a rich cluster glows without burning.
 */
export const NEBULA = {
  /** Of the display resolution, per axis. */
  resolution: 0.25,
  /** Sprite radius, in units of the distance to the k-th neighbour. */
  radiusPerNeighbour: 2.2,
  minRadius: 1.2,
  maxRadius: 10,
  /** Overdensity where a galaxy starts to contribute, and where it is full. */
  overdensityFrom: 4.5,
  overdensityTo: 40,
  /** Per-sprite weight before compression. */
  weight: 0.05,
  /**
   * Compression: output = gain * (sum / (sum + knee))^0.6, faded to nothing
   * below `toe` so the thin overlap of unrelated clouds stays dark.
   */
  knee: 1.0,
  gain: 0.17,
  toe: 0.1,
  /** Degrees over which the clouds fade out at the measured mask's edge. */
  maskFeather: 2.5,
  /**
   * The galaxies' own light, diffused. Kept warm even when far: anything
   * blue or violet here would read as the estimates or as the mask.
   */
  color: 0xeadcc4,
  farColor: 0x8c8782,
};

/**
 * 4. Depth of field. A thin lens whose plane of focus is tilted onto the
 * galactic plane, applied per point: each sprite grows by its circle of
 * confusion and spreads the same light over the larger area.
 */
export const DOF = {
  /** Lens diameter, Mpc. */
  aperture: 1.6,
  /** Circle of confusion ceiling, CSS pixels. */
  maxCoc: 6,
  /** Camera radii over which it comes in; from the origin it means nothing. */
  ramp: [18, 110],
};

/**
 * 5. Depth cue. The tint follows whichever is nearer, us or the camera, so the
 * core and the near side stay warm; camera distance, normalised to the near
 * and far reach of the catalogue from where the camera is, then greys and
 * sinks everything past the middle of the cloud. At the origin all of it is
 * exactly the old distance-from-us tint.
 */
export const DEPTH_CUE = {
  /** How far towards grey the farthest galaxies go. */
  desaturate: 0.7,
  /** How far towards the background hue. */
  drift: 0.55,
  /** Extra dimming on top of the far tint's own. */
  dim: 0.78,
  color: 0x3a4256,
};

/** 6. Milky Way structure. */
export const MW_NOISE = {
  /** Resolution of the baked structure map, and the latitude it reaches. */
  mapWidth: 4096,
  mapHeight: 1024,
  mapLatitude: 45,
};

/** 7. Camera. */
export const CAMERA = {
  /** Critically damped spring on t, per second. */
  spring: 4.5,
  /** And on drag, which should stay close to the hand. */
  dragSpring: 11,
  /** Drift, as a fraction of orbit radius. */
  drift: 0.013,
  /** At the origin there is nothing to translate against: sway instead. */
  swayDeg: 0.35,
  /** Seconds. Chosen not to share a beat. */
  periods: [53, 79, 131],
};
