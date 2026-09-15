import * as THREE from 'three';
import { COLOR, MW_SHELL_RADIUS } from './constants.js';
import { gaussian } from './rng.js';
import { galacticToRender } from './data.js';

/**
 * A foreground star field, built as an actual disc rather than as a painted
 * stripe. Stars are drawn from an exponential disc plus a bulge, seen from a
 * Sun sitting 8 kpc out and a little above the midplane, then projected onto a
 * shell around the camera. Doing it in three dimensions gets the band's
 * thickness, its brightening towards l = 0 and its widening over the bulge for
 * free, and it lets extinction be integrated along each line of sight, which
 * is what carves the dark lane through the middle the same way the real one is
 * carved.
 */
const R_SUN = 8.0; // kpc
const Z_SUN = 0.02; // kpc above the midplane
const H_R = 2.6; // thin disc scale length
const H_Z = 0.30; // thin disc scale height
const THICK_R = 3.4; // thick disc: broadens the wings of the band, as it does
const THICK_Z = 0.85; // in the real thing
const THICK_FRACTION = 0.13;
const H_DUST = 0.125; // dust scale height
const KAPPA = 1.55; // extinction per kpc in the midplane
const BULGE_FRACTION = 0.14;

function gammaTwo(rng, scale) {
  return -scale * (Math.log(Math.max(rng(), 1e-9)) + Math.log(Math.max(rng(), 1e-9)));
}

function opticalDepth(d, sinB, kappa) {
  // Numerically integrate dust density along the ray. Twelve steps is plenty;
  // all that matters is that it diverges as the line of sight approaches b = 0.
  const STEPS = 12;
  const step = d / STEPS;
  let sum = 0;
  for (let i = 0; i < STEPS; i++) {
    const s = (i + 0.5) * step;
    sum += Math.exp(-Math.abs(-Z_SUN + s * sinB) / H_DUST);
  }
  return kappa * sum * step;
}

export function generateStars(count, rng) {
  const dir = new Float32Array(count * 3);
  const logFlux = new Float64Array(count);
  const tau = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    let gx, gy, gz;
    if (rng() < BULGE_FRACTION) {
      const r = gammaTwo(rng, 0.42);
      const u = 2 * rng() - 1;
      const phi = 2 * Math.PI * rng();
      const s = Math.sqrt(Math.max(0, 1 - u * u));
      gx = R_SUN + r * s * Math.cos(phi);
      gy = r * s * Math.sin(phi);
      gz = r * u * 0.62 - Z_SUN;
    } else {
      const thick = rng() < THICK_FRACTION;
      const hr = thick ? THICK_R : H_R;
      const hz = thick ? THICK_Z : H_Z;
      let rg = gammaTwo(rng, hr);
      if (rg > 22) rg = 22 * rng();
      const phi = 2 * Math.PI * rng();
      const zg = -hz * Math.log(Math.max(rng(), 1e-9)) * (rng() < 0.5 ? -1 : 1);
      gx = R_SUN + rg * Math.cos(phi);
      gy = rg * Math.sin(phi);
      gz = zg - Z_SUN;
    }

    const d = Math.max(Math.hypot(gx, gy, gz), 0.02);
    const nx = gx / d, ny = gy / d, nz = gz / d;

    // More dust towards the centre than towards the anticentre.
    const t = opticalDepth(d, nz, KAPPA * (0.55 + 0.9 * Math.max(0, nx)));
    const lum = Math.pow(10, Math.min(2.6, Math.max(-2.6, gaussian(rng))) * 1.05);

    const p = galacticToRender(nx, ny, nz);
    dir[i * 3] = p[0];
    dir[i * 3 + 1] = p[1];
    dir[i * 3 + 2] = p[2];
    logFlux[i] = Math.log10(lum / (d * d)) - t / Math.LN10;
    tau[i] = t;
  }

  // Normalise brightness against the population rather than against absolutes.
  const sorted = Float64Array.from(logFlux).sort();
  const lo = sorted[Math.floor(count * 0.04)];
  const hi = sorted[Math.floor(count * 0.9985)];
  const span = Math.max(hi - lo, 1e-6);

  const position = new Float32Array(count * 3);
  const aSize = new Float32Array(count);
  const aAlpha = new Float32Array(count);
  const color = new Float32Array(count * 3);

  const warm = new THREE.Color(0xffe9cc);
  const amber = new THREE.Color(0xffc69c);
  const rose = new THREE.Color(COLOR.mwBand);
  const tmp = new THREE.Color();

  for (let i = 0; i < count; i++) {
    const n = Math.min(1, Math.max(0, (logFlux[i] - lo) / span));
    position[i * 3] = dir[i * 3] * MW_SHELL_RADIUS;
    position[i * 3 + 1] = dir[i * 3 + 1] * MW_SHELL_RADIUS;
    position[i * 3 + 2] = dir[i * 3 + 2] * MW_SHELL_RADIUS;
    aSize[i] = 0.58 + 2.30 * Math.pow(n, 2.1);
    aAlpha[i] = 0.005 + 0.76 * Math.pow(n, 2.6);

    tmp.copy(warm).lerp(amber, rng());
    // Reddening has to bite hard in the lane and not at all out of the plane.
    // Optical depth alone is too generous away from b = 0, so it is raised to
    // a power: negligible below about one, decisive above two.
    tmp.lerp(rose, Math.min(0.85, Math.pow(tau[i] / 3.2, 1.8)));
    color[i * 3] = tmp.r;
    color[i * 3 + 1] = tmp.g;
    color[i * 3 + 2] = tmp.b;
  }

  return { position, aSize, aAlpha, color };
}

const STAR_VERT = /* glsl */ `
  uniform float uPixelRatio;
  uniform float uOpacity;
  attribute float aSize;
  attribute float aAlpha;
  varying float vAlpha;
  varying vec3 vTint;
  void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uPixelRatio;
    vAlpha = aAlpha * uOpacity;
    vTint = color;
  }
`;

const STAR_FRAG = /* glsl */ `
  varying float vAlpha;
  varying vec3 vTint;
  void main() {
    vec2 uv = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(uv, uv);
    if (r2 > 1.0) discard;
    gl_FragColor = vec4(vTint, exp(-r2 * 3.2) * vAlpha);
  }
`;

const NOISE = /* glsl */ `
  float hash31(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.11, 0.27, 0.43));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float vnoise(vec3 x) {
    vec3 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash31(i), hash31(i + vec3(1.0, 0.0, 0.0)), f.x),
          mix(hash31(i + vec3(0.0, 1.0, 0.0)), hash31(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
      mix(mix(hash31(i + vec3(0.0, 0.0, 1.0)), hash31(i + vec3(1.0, 0.0, 1.0)), f.x),
          mix(hash31(i + vec3(0.0, 1.0, 1.0)), hash31(i + vec3(1.0, 1.0, 1.0)), f.x), f.y),
      f.z);
  }
  float fbm(vec3 p) {
    float s = 0.0;
    float a = 0.5;
    for (int k = 0; k < 4; k++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; }
    return s;
  }
`;

const HAZE_VERT = /* glsl */ `
  varying vec3 vLocal;
  void main() {
    vLocal = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * The diffuse component, worked out analytically from the view direction so it
 * stays smooth at any resolution: a thin disc glow, a bulge, and the dust lane
 * threading through the middle of both.
 */
const HAZE_FRAG = /* glsl */ `
  uniform float uOpacity;
  uniform vec3 uCore;
  uniform vec3 uBand;
  varying vec3 vLocal;
  ${NOISE}

  void main() {
    // Render frame back to galactic: x = X, y = -Z, z = Y.
    vec3 d = normalize(vLocal);
    float b = asin(clamp(d.y, -1.0, 1.0));
    float l = atan(-d.z, d.x);

    float toCentre = 0.5 + 0.5 * cos(l);
    float lc = 0.38 + 0.62 * pow(toCentre, 1.4);

    float warp = 0.030 * sin(l + 0.5) + 0.014 * sin(2.2 * l + 2.0);
    float bb = b - warp;

    float h = mix(0.048, 0.068, toCentre);
    float core = exp(-abs(bb) / h);
    float wing = exp(-abs(bb) / (h * 2.6)) * 0.24;
    float disc = (core + wing) * lc;
    disc *= 0.60 + 0.66 * fbm(d * 6.0);

    float bulge = exp(-(bb * bb) / (2.0 * 0.058 * 0.058))
                * exp(-(l * l) / (2.0 * 0.30 * 0.30)) * 0.95;

    float glow = disc + bulge;

    float lanePos = -0.004 + 0.012 * sin(1.7 * l + 1.0);
    float laneW = mix(0.015, 0.024, toCentre);
    float lane = exp(-pow((bb - lanePos) / laneW, 2.0));
    lane *= 0.50 + 0.80 * fbm(d * 9.0 + 31.0);
    glow *= 1.0 - 0.84 * clamp(lane, 0.0, 1.0) * lc;

    vec3 col = mix(uBand, uCore, clamp(lc * 0.42 + bulge * 1.1, 0.0, 1.0));
    col = mix(col, vec3(0.95, 0.91, 0.84), clamp(glow * 0.30, 0.0, 0.45));
    col = mix(col, uBand, clamp(lane * 0.85, 0.0, 1.0));

    gl_FragColor = vec4(col, clamp(glow, 0.0, 1.9) * uOpacity);
  }
`;

/**
 * The shell is parented to the camera's position but never to its rotation, so
 * the band stays fixed on the sky while the viewer turns. It renders after the
 * galaxies and additively, which washes out whatever is behind it rather than
 * cleanly hiding it.
 */
export function makeMilkyWay(starCount, rng) {
  const group = new THREE.Group();
  group.frustumCulled = false;

  const stars = generateStars(starCount, rng);
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(stars.position, 3));
  starGeo.setAttribute('aSize', new THREE.BufferAttribute(stars.aSize, 1));
  starGeo.setAttribute('aAlpha', new THREE.BufferAttribute(stars.aAlpha, 1));
  starGeo.setAttribute('color', new THREE.BufferAttribute(stars.color, 3));
  starGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), MW_SHELL_RADIUS * 1.1);

  const starMat = new THREE.ShaderMaterial({
    vertexShader: STAR_VERT,
    fragmentShader: STAR_FRAG,
    uniforms: {
      uPixelRatio: { value: 1 },
      uOpacity: { value: 1 },
    },
    vertexColors: true,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const starPoints = new THREE.Points(starGeo, starMat);
  starPoints.frustumCulled = false;
  starPoints.renderOrder = 11;

  const hazeMat = new THREE.ShaderMaterial({
    vertexShader: HAZE_VERT,
    fragmentShader: HAZE_FRAG,
    uniforms: {
      uOpacity: { value: 0.27 },
      uCore: { value: new THREE.Color(COLOR.mwCore) },
      uBand: { value: new THREE.Color(COLOR.mwBand) },
    },
    side: THREE.BackSide,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const haze = new THREE.Mesh(
    new THREE.SphereGeometry(MW_SHELL_RADIUS, 64, 48),
    hazeMat
  );
  haze.frustumCulled = false;
  haze.renderOrder = 10;

  group.add(haze, starPoints);

  return {
    group,
    setPixelRatio(pr) {
      starMat.uniforms.uPixelRatio.value = pr;
    },
    /** Opacity is a function of where the camera is, not of where t is. */
    setOpacity(v) {
      group.visible = v > 0.002;
      starMat.uniforms.uOpacity.value = v;
      hazeMat.uniforms.uOpacity.value = 0.27 * v;
    },
  };
}
