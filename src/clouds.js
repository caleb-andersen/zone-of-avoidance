import * as THREE from 'three';
import { COLOR, MAX_DISTANCE, DEPTH_CUE, DOF } from './constants.js';

/**
 * Point size comes from K-band magnitude, softened by distance from the
 * camera. Full inverse-distance falloff over a 160 Mpc range would make the
 * nearest galaxies enormous while standing at the origin, so the attenuation
 * is deliberately gentle.
 *
 * The tint has always been by distance from us. With the depth cue on it is by
 * whichever is nearer, us or the camera -- the same thing at the origin, and
 * out in the orbit it keeps both the core and the near side of the cloud warm.
 * Camera distance, normalised to the nearest and farthest reach of the
 * catalogue from where the camera is, then drives aerial perspective: past the
 * middle of the cloud, galaxies desaturate and sink towards the background.
 * `uCue` switches the whole thing, so with it off nothing moves.
 *
 * Depth of field is done here too, one point at a time, because an additive
 * cloud has no depth buffer for a post pass to read. The lens is focused on the
 * galactic plane rather than at a distance -- a tilted plane of focus -- so the
 * band and the gap in it stay sharp and what floats far above and below it
 * softens. Each sprite grows by its circle of confusion and the same light is
 * spread over the larger area.
 */
const VERT = /* glsl */ `
  uniform float uPixelRatio;
  uniform float uSizeScale;
  uniform float uOpacity;
  uniform float uRefDist;
  uniform float uMinPx;
  uniform float uMaxPx;
  uniform float uFarDist;
  uniform float uFarDim;
  uniform vec3 uNearColor;
  uniform vec3 uFarColor;

  uniform float uCue;
  uniform vec2 uCueRange;
  uniform float uCueDesat;
  uniform float uCueDrift;
  uniform float uCueDim;
  uniform vec3 uCueColor;

  uniform float uAperture;
  uniform float uFocalPx;
  uniform float uMaxCoc;

  attribute float aBright;
  attribute vec2 aShape;
  attribute float aDist;

  varying float vAngle;
  varying float vQ;
  varying float vAlpha;
  varying vec3 vColor;
  varying float vFocus;
  varying float vBright;
  varying float vSize;

  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vec4 mv = viewMatrix * world;
    gl_Position = projectionMatrix * mv;

    float camDist = max(-mv.z, 0.001);
    float lum = 0.34 + 2.05 * pow(aBright, 1.45);
    float atten = pow(uRefDist / (uRefDist + camDist), 0.55);
    float size = clamp(
      uSizeScale * lum * atten * uPixelRatio,
      uMinPx * uPixelRatio,
      uMaxPx * uPixelRatio
    );

    float originDepth = clamp(aDist / uFarDist, 0.0, 1.0);
    float camDepth = clamp((camDist - uCueRange.x) / (uCueRange.y - uCueRange.x), 0.0, 1.0);
    float depth = mix(originDepth, min(originDepth, camDepth), uCue);
    vec3 color = mix(uNearColor, uFarColor, pow(depth, 0.65));
    float alpha = uOpacity * mix(1.0, uFarDim, pow(depth, 0.85)) * (0.40 + 0.60 * aBright);

    if (uCue > 0.0) {
      // Nothing nearer than the middle of the cloud is touched; beyond it the
      // galaxies grey out and sink towards the background.
      float fog = uCue * smoothstep(0.42, 1.0, camDepth);
      float grey = dot(color, vec3(0.299, 0.587, 0.114));
      color = mix(color, vec3(grey), fog * uCueDesat);
      float cueGrey = max(dot(uCueColor, vec3(0.299, 0.587, 0.114)), 1e-3);
      color = mix(color, uCueColor * (grey / cueGrey), fog * uCueDrift);
      alpha *= mix(1.0, uCueDim, fog);
    }

    float focus = 1.0;
    vSize = size;
    if (uAperture > 0.0) {
      // Where this point's own line of sight crosses the galactic plane is
      // where the lens is focused along it. View depth scales linearly along
      // the ray, so the focus depth is the crossing fraction times this depth.
      vec3 ray = world.xyz - cameraPosition;
      float focusDepth = 1e9;
      if (abs(ray.y) > 1e-5) {
        float s = -cameraPosition.y / ray.y;
        if (s > 0.0) focusDepth = s * camDist;
      }
      float coc = uAperture * uFocalPx * abs(1.0 / camDist - 1.0 / focusDepth);
      coc = min(coc, uMaxCoc * uPixelRatio);
      float grown = sqrt(size * size + coc * coc);
      focus = size / grown;
      size = grown;
    }

    gl_PointSize = size;
    vColor = color;
    vAlpha = alpha;
    vFocus = focus;
    vBright = aBright;
    vAngle = aShape.x;
    vQ = aShape.y;
  }
`;

/** Rotate the sprite's UVs by the galaxy's own angle, then squash them. */
const ELLIPSE = /* glsl */ `
  vec2 ellipseCoord(vec2 uv, float angle, float q) {
    float s = sin(angle), c = cos(angle);
    vec2 p = vec2(c * uv.x - s * uv.y, s * uv.x + c * uv.y);
    p.y /= max(q, 0.10);
    return p;
  }
`;

/**
 * Out of focus, a point becomes a soft disc with a faint brighter rim, the
 * way a real lens renders one. Its normalisation is chosen so that the disc
 * carries the same light as the sharp profile it replaces: the constants are
 * the integrals of each profile over the unit disc.
 */
const BOKEH = /* glsl */ `
  const float BOKEH_ENERGY = 2.34026;
  float bokeh(float r) {
    return (1.0 - smoothstep(0.80, 1.0, r)) * (0.86 + 0.14 * r * r);
  }
`;

/**
 * A galaxy, as it would look in a small telescope image.
 *
 * A disc galaxy is two things with different shapes: a thin exponential disc,
 * which foreshortens all the way to its thickness when seen edge-on, and a
 * bulge, which is nearly as thick as it is wide and so stays round. Drawing
 * both with one axis ratio -- as a single squashed profile -- turns every
 * edge-on galaxy into a needle with no centre, which is the one thing a real
 * one never looks like. So the nucleus here is flattened by the bulge's
 * projected axis ratio and the disc by the disc's. Bigger, strongly inclined
 * discs also show the dust lane along the near side of the major axis.
 * Early types (their angle is tagged by +pi; see data.js) have no disc, only
 * a smooth cored envelope.
 *
 * Every scale is widened in quadrature by a pixel's footprint, with the
 * amplitude brought down to keep the light the same. A disc a fraction of a
 * pixel thick is not drawable; point-sampled, it aliases into a one-pixel
 * scratch. Prefiltered, it becomes a soft oval, and a sprite at the minimum
 * size becomes a soft dot rather than a hard single pixel.
 *
 * With HDR on, the nucleus of a bright galaxy is allowed past white, so that
 * the bloom has something to find.
 */
const GALAXY_PROFILE = /* glsl */ `
  const float PI = 3.14159265;
  /** Disc scale length, in sprite radii. */
  const float H_DISC = 0.22;
  /** Core radii of a bulge and of an elliptical, and the slopes of their wings. */
  const float A_BULGE = 0.075;
  const float A_ELLIPTICAL = 0.085;
  const float G_BULGE = 1.7;
  const float G_ELLIPTICAL = 1.35;
  /** Intrinsic thickness of a bulge: how round it stays when seen edge-on. */
  const float Q_BULGE = 0.62;
  /**
   * Peak brightness of each part. Balanced so that, averaged over the axis
   * ratios the catalogue is drawn with, a sprite carries the same light as
   * the single-profile sprite it replaced, and the scene's exposure holds.
   */
  const float DISC_PEAK = 1.5;
  const float BULGE_PEAK = 1.3;
  const float ELLIPTICAL_PEAK = 1.6;
  /** The axis ratio at which an inclined disc is neither brightened nor dimmed. */
  const float Q_REF = 0.62;

  /** Surface brightness at sprite coordinate m (x along the major axis) and its total light. */
  void galaxy(vec2 m, float q, float early, float px, float boost, float angle,
              out float light, out float energy, out vec3 tint) {
    // The disc is prefiltered by half a pixel; the core by nearly a whole
    // one, which stands in for seeing -- a core narrower than that is a star.
    // Both are capped so the smallest sprites still hold their own light.
    float b = min(0.45 * px, 0.22);
    float b2 = b * b;
    float bc = min(0.9 * px, 0.30);
    float bc2 = bc * bc;

    // Core: bulge or elliptical, cored power law, prefiltered.
    float a = mix(A_BULGE, A_ELLIPTICAL, early);
    float qc = early > 0.5 ? q : sqrt(q * q * (1.0 - Q_BULGE * Q_BULGE) + Q_BULGE * Q_BULGE);
    float g = mix(G_BULGE, G_ELLIPTICAL, early);
    float ax = sqrt(a * a + bc2), ay = sqrt(a * a * qc * qc + bc2);
    float cPeak = mix(BULGE_PEAK, ELLIPTICAL_PEAK, early) * boost * (a * a * qc) / (ax * ay);
    float rc2 = (m.x * m.x) / (ax * ax) + (m.y * m.y) / (ay * ay);
    float core = cPeak * pow(1.0 + rc2, -g);
    float eCore = cPeak * PI * ax * ay / (g - 1.0);

    // Disc: exponential, prefiltered. A disc seen at an angle keeps its light
    // in a smaller area, so it brightens -- by less than the full 1/q, since
    // edge-on the dust takes some of it back.
    float disc = 0.0, eDisc = 0.0, lane = 0.0;
    if (early < 0.5) {
      float hx = sqrt(H_DISC * H_DISC + b2);
      float hy = sqrt(H_DISC * H_DISC * q * q + b2);
      float dPeak = DISC_PEAK * sqrt(Q_REF / q) * (H_DISC * H_DISC * q) / (hx * hy);
      disc = dPeak * exp(-length(vec2(m.x / hx, m.y / hy)));
      eDisc = dPeak * 2.0 * PI * hx * hy;

      // The lane sits a little to the near side of the midplane, which is
      // why only one side of a real edge-on disc looks cut. Only drawn where
      // it spans enough pixels to be a lane rather than a darker line.
      float hq = H_DISC * q;
      float show = smoothstep(0.55, 0.28, q) * smoothstep(0.9, 2.2, hq / px);
      if (show > 0.0) {
        float side = fract(angle * 7.31) > 0.5 ? 1.0 : -1.0;
        float w = 0.42 * hq + 0.5 * px;
        float along = exp(-pow(m.x / (4.2 * H_DISC), 4.0));
        lane = 0.62 * show * along * exp(-pow((m.y - side * 0.45 * hq) / w, 2.0));
      }
    }

    // Round off where the sprite ends, well past where anything is visible.
    float edge = 1.0 - smoothstep(0.72, 1.0, length(m));
    float keep = 1.0 - lane;
    light = (core + disc) * keep * edge;
    energy = eCore + eDisc;

    // Old stars in the middle, a slightly bluer disc: barely, so that the
    // galaxies stay warm off-white as a population.
    float fc = core / max(core + disc, 1e-6);
    tint = mix(vec3(0.965, 0.99, 1.03), vec3(1.025, 0.99, 0.935), fc);
  }
`;

const FRAG_GALAXY = /* glsl */ `
  uniform float uCoreGain;
  varying float vAngle;
  varying float vQ;
  varying float vAlpha;
  varying vec3 vColor;
  varying float vFocus;
  varying float vBright;
  varying float vSize;
  ${BOKEH}
  ${GALAXY_PROFILE}

  void main() {
    vec2 uv = gl_PointCoord * 2.0 - 1.0;
    float boost = 1.0 + uCoreGain * smoothstep(0.35, 0.95, vBright);
    float early = step(PI, vAngle);

    // Into the galaxy's own frame: x along the major axis. The sharp profile
    // occupies the middle vFocus of a sprite grown by its circle of confusion.
    vec2 s = uv / vFocus;
    float sn = sin(vAngle), cs = cos(vAngle);
    vec2 m = vec2(cs * s.x - sn * s.y, sn * s.x + cs * s.y);
    float px = 2.0 / max(vSize, 1.0);

    float sharp, energy;
    vec3 tint;
    galaxy(m, max(vQ, 0.10), early, px, boost, vAngle, sharp, energy, tint);
    if (length(s) > 1.0) sharp = 0.0;

    float i = sharp;
    float blur = 1.0 - vFocus * vFocus;
    if (blur > 0.001) {
      float disc = bokeh(length(uv)) * energy / BOKEH_ENERGY;
      i = mix(sharp, disc * vFocus * vFocus, blur);
      tint = mix(tint, vec3(1.0), blur);
    }
    if (i <= 0.0) discard;
    gl_FragColor = vec4(vColor * tint, i * vAlpha);
  }
`;

/**
 * Estimates get a ring rather than a different colour alone, because in a dark
 * scene colour reads as a property of the galaxy and hollowness reads as a
 * property of our knowledge. They are still elongated and rotated, so they sit
 * in the scene as objects instead of as interface markers.
 */
const FRAG_ESTIMATE = /* glsl */ `
  varying float vAngle;
  varying float vQ;
  varying float vAlpha;
  varying vec3 vColor;
  varying float vFocus;
  ${ELLIPSE}
  ${BOKEH}

  const float RING_ENERGY = 0.89891;

  void main() {
    vec2 uv = gl_PointCoord * 2.0 - 1.0;
    vec2 p = ellipseCoord(uv / vFocus, vAngle, vQ);
    float r = length(p);
    float sharp = 0.0;
    if (r <= 1.0) {
      float ring = exp(-pow((r - 0.55) / 0.155, 2.0));
      float fill = 0.09 * (1.0 - smoothstep(0.0, 0.58, r));
      float edge = 1.0 - smoothstep(0.78, 1.0, r);
      sharp = (ring * 0.92 + fill) * edge;
    }

    float i = sharp;
    float blur = 1.0 - vFocus * vFocus;
    if (blur > 0.001) {
      float disc = bokeh(length(uv)) * RING_ENERGY * max(vQ, 0.10) / BOKEH_ENERGY;
      i = mix(sharp, disc * vFocus * vFocus, blur);
    }
    if (i <= 0.0) discard;
    gl_FragColor = vec4(vColor, i * vAlpha);
  }
`;

function buildCloud(set, fragment, opts) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(set.position, 3));
  geometry.setAttribute('aShape', new THREE.BufferAttribute(set.shape, 2));
  geometry.setAttribute('aBright', new THREE.BufferAttribute(set.bright, 1));
  geometry.setAttribute('aDist', new THREE.BufferAttribute(set.dist, 1));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), MAX_DISTANCE * 1.05);

  const material = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: fragment,
    uniforms: {
      uPixelRatio: { value: 1 },
      uSizeScale: { value: opts.sizeScale },
      uOpacity: { value: opts.opacity ?? 1 },
      uRefDist: { value: 60 },
      uMinPx: { value: opts.minPx },
      uMaxPx: { value: opts.maxPx },
      uFarDist: { value: MAX_DISTANCE },
      uFarDim: { value: opts.farDim },
      uNearColor: { value: new THREE.Color(opts.nearColor) },
      uFarColor: { value: new THREE.Color(opts.farColor) },
      uCue: { value: 0 },
      uCueRange: { value: new THREE.Vector2(0, MAX_DISTANCE) },
      uCueDesat: { value: opts.cueDesat },
      uCueDrift: { value: opts.cueDrift },
      uCueDim: { value: DEPTH_CUE.dim },
      uCueColor: { value: new THREE.Color(DEPTH_CUE.color) },
      uAperture: { value: 0 },
      uFocalPx: { value: 1 },
      uMaxCoc: { value: DOF.maxCoc },
      uCoreGain: { value: 0 },
    },
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = opts.renderOrder;
  return points;
}

export function makeGalaxyCloud(set) {
  return buildCloud(set, FRAG_GALAXY, {
    sizeScale: 31,
    minPx: 3.1,
    maxPx: 26,
    farDim: 0.62,
    nearColor: COLOR.galaxyNear,
    farColor: COLOR.galaxyFar,
    cueDesat: DEPTH_CUE.desaturate,
    cueDrift: DEPTH_CUE.drift,
    renderOrder: 1,
  });
}

/**
 * The estimates take the depth cue's dimming but not its change of colour:
 * their blue is what says they are estimates, and greying the far ones out
 * would make them read as galaxies.
 */
export function makeEstimateCloud(set) {
  return buildCloud(set, FRAG_ESTIMATE, {
    sizeScale: 26,
    minPx: 5.0,
    maxPx: 26,
    farDim: 0.52,
    opacity: 0,
    nearColor: COLOR.synth,
    farColor: 0x4d708c,
    cueDesat: 0,
    cueDrift: 0,
    renderOrder: 2,
  });
}

/** The Great Attractor: one point, and the only saturated thing on screen. */
export function makeAttractor(position) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array(position), 3)
  );
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), MAX_DISTANCE * 1.05);

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uPixelRatio: { value: 1 },
      uOpacity: { value: 0 },
      uSizePx: { value: 64 },
      uColor: { value: new THREE.Color(COLOR.attractor) },
    },
    vertexShader: /* glsl */ `
      uniform float uPixelRatio;
      uniform float uSizePx;
      void main() {
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = uSizePx * uPixelRatio;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uOpacity;
      uniform vec3 uColor;
      void main() {
        vec2 uv = gl_PointCoord * 2.0 - 1.0;
        float r = length(uv);
        if (r > 1.0) discard;
        float core = exp(-r * r * 46.0);
        float corona = exp(-r * 3.4) * 0.40;
        float ring = exp(-pow((r - 0.60) / 0.050, 2.0)) * 0.55;
        float edge = 1.0 - smoothstep(0.86, 1.0, r);
        gl_FragColor = vec4(uColor, (core + corona + ring) * edge * uOpacity);
      }
    `,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 3;
  return points;
}

/**
 * Per-frame state the depth cue and the lens need, shared by both clouds.
 * `radius` is the camera's distance from the origin; `sceneHeight` is the
 * height of the target the points are drawn into, in device pixels.
 */
export function updateCloudOptics(clouds, { camera, radius, sceneHeight, cue, aperture, coreGain, range }) {
  range.near = Math.max(0, radius - MAX_DISTANCE);
  range.far = radius + MAX_DISTANCE;
  // Pixels per unit of tan(angle): the lens's focal length on this target.
  const focalPx = camera.projectionMatrix.elements[5] * sceneHeight * 0.5;
  for (const cloud of clouds) {
    const u = cloud.material.uniforms;
    u.uCue.value = cue;
    u.uCueRange.value.set(range.near, range.far);
    u.uAperture.value = aperture;
    u.uFocalPx.value = focalPx;
    u.uCoreGain.value = coreGain;
  }
  return range;
}
