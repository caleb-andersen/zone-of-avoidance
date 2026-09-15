// Everything tunable, in one place.

export const DATA_URL = 'data/2mrs.bin';

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
};

export const DEG = Math.PI / 180;
