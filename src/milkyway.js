import * as THREE from 'three';
import { COLOR, MW_SHELL_RADIUS, MW_NOISE, HDR, DEG } from './constants.js';
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
/**
 * The structured dust sits in clouds a few hundred parsecs out, so a star
 * nearer than that is in front of it and a star well beyond is fully behind.
 */
const CLOUD_NEAR = 0.15; // kpc
const CLOUD_FAR = 0.9;

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

/**
 * Brightness, size and reddening are no longer settled here: they are worked
 * out in the vertex shader from each star's normalised flux and optical depth,
 * so that the structured dust can dim and redden the stars behind it without
 * the field having to be generated twice. With the structure off the shader
 * reproduces the old formulas exactly.
 */
export function generateStars(count, rng) {
  const dir = new Float32Array(count * 3);
  const logFlux = new Float64Array(count);
  const tau = new Float32Array(count);
  const front = new Float32Array(count);

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
    const f = Math.min(1, Math.max(0, (d - CLOUD_NEAR) / (CLOUD_FAR - CLOUD_NEAR)));
    front[i] = f * f * (3 - 2 * f);
  }

  // Normalise brightness against the population rather than against absolutes.
  const sorted = Float64Array.from(logFlux).sort();
  const lo = sorted[Math.floor(count * 0.04)];
  const hi = sorted[Math.floor(count * 0.9985)];
  const span = Math.max(hi - lo, 1e-6);

  const position = new Float32Array(count * 3);
  const level = new Float32Array(count);
  const color = new Float32Array(count * 3);

  const warm = new THREE.Color(0xffe9cc);
  const amber = new THREE.Color(0xffc69c);
  const tmp = new THREE.Color();

  for (let i = 0; i < count; i++) {
    position[i * 3] = dir[i * 3] * MW_SHELL_RADIUS;
    position[i * 3 + 1] = dir[i * 3 + 1] * MW_SHELL_RADIUS;
    position[i * 3 + 2] = dir[i * 3 + 2] * MW_SHELL_RADIUS;
    // Unclamped: extinction in the shader may push it below zero.
    level[i] = (logFlux[i] - lo) / span;

    tmp.copy(warm).lerp(amber, rng());
    color[i * 3] = tmp.r;
    color[i * 3 + 1] = tmp.g;
    color[i * 3 + 2] = tmp.b;
  }

  return { position, level, tau, front, color, span };
}

/**
 * Hash-based gradient noise. Integer hashing (pcg3d, Jarzynski and Olano 2020)
 * rather than the usual fract-of-a-product, which loses precision at the
 * frequencies the dust needs and leaves blocky cells behind.
 */
const GNOISE = /* glsl */ `
  uvec3 pcg3d(uvec3 v) {
    v = v * 1664525u + 1013904223u;
    v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
    v ^= v >> 16u;
    v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
    return v;
  }
  vec3 gradAt(ivec3 c) {
    return vec3(pcg3d(uvec3(c + 8192))) * (2.0 / 4294967295.0) - 1.0;
  }
  float gnoise(vec3 x) {
    vec3 fl = floor(x);
    ivec3 i = ivec3(fl);
    vec3 f = x - fl;
    vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    float n000 = dot(gradAt(i), f);
    float n100 = dot(gradAt(i + ivec3(1, 0, 0)), f - vec3(1.0, 0.0, 0.0));
    float n010 = dot(gradAt(i + ivec3(0, 1, 0)), f - vec3(0.0, 1.0, 0.0));
    float n110 = dot(gradAt(i + ivec3(1, 1, 0)), f - vec3(1.0, 1.0, 0.0));
    float n001 = dot(gradAt(i + ivec3(0, 0, 1)), f - vec3(0.0, 0.0, 1.0));
    float n101 = dot(gradAt(i + ivec3(1, 0, 1)), f - vec3(1.0, 0.0, 1.0));
    float n011 = dot(gradAt(i + ivec3(0, 1, 1)), f - vec3(0.0, 1.0, 1.0));
    float n111 = dot(gradAt(i + ivec3(1, 1, 1)), f - vec3(1.0, 1.0, 1.0));
    return 1.4 * mix(
      mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
      mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y),
      u.z
    );
  }
`;

/**
 * What each channel of the structure map is divided by when written, and
 * multiplied by when read, so that every value fits in [0, 1]. On a float
 * target that costs nothing; without one, the map falls back to eight bits and
 * still works, only coarser.
 */
const STRUCTURE_RANGE = /* glsl */ `
  const vec4 STRUCTURE_RANGE = vec4(12.0, 8.0, 2.0, 2.0);
`;

/**
 * The structure map: everything about the band that is not a smooth profile,
 * baked once into an equirectangular float texture in galactic (l, b), which
 * both the haze and the stars read.
 *
 *   r  optical depth of the structured dust
 *   g  diffuse starlight before that dust: disc, bulge and star clouds
 *   b  star-cloud factor, for the point stars
 *   a  emission: the few pink nebulae bright enough to see by eye
 *
 * The character is taken from a dark-site wide-field photograph of the whole
 * band (ESO's GigaGalaxy Zoom panorama). What that shows, and what this is
 * built to have: dust that is filamentary at every scale, nearly black where
 * it is thick, sitting in a thinner layer than the stars and wandering off the
 * midplane; tendrils rising well above the plane over the bulge; one long rift
 * splitting the band from Cygnus down into Ophiuchus; starlight mottled into
 * clouds a few degrees across; a bulge that is broad and soft; an anticentre
 * that is faint and thin; and a warm brown rim wherever light comes through
 * dust that is thin enough to redden it rather than stop it.
 *
 * The large dark complexes are placed where the real ones are. They are the
 * same clouds the survey could not see through, which is why the measured
 * mask bulges at the Aquila Rift, Cepheus and Orion; the fine structure inside
 * and between them is noise.
 */
const BAKE_FRAG = /* glsl */ `
  uniform float uLatMax;
  varying vec2 vUv;
  ${GNOISE}
  ${STRUCTURE_RANGE}

  float fbm(vec3 p, int octaves) {
    float s = 0.0, a = 0.5;
    for (int k = 0; k < 8; k++) {
      if (k >= octaves) break;
      s += a * gnoise(p);
      p = p * 2.03 + vec3(17.1, 5.3, 11.7);
      a *= 0.5;
    }
    return s;
  }

  /** Ridged multifractal: sharp crests along the zero set, which is filaments. */
  float ridged(vec3 p, int octaves) {
    float s = 0.0, a = 0.5, w = 1.0, norm = 0.0;
    for (int k = 0; k < 8; k++) {
      if (k >= octaves) break;
      float n = 1.0 - abs(gnoise(p));
      n *= n;
      n *= w;
      w = clamp(n * 1.8, 0.0, 1.0);
      s += a * n;
      norm += a;
      p = p * 2.07 + vec3(3.3, 9.1, 1.7);
      a *= 0.52;
    }
    return s / norm;
  }

  float blob(float l, float b, float l0, float b0, float sl, float sb) {
    float dl = mod(l - l0 + 180.0, 360.0) - 180.0;
    return exp(-0.5 * ((dl * dl) / (sl * sl) + ((b - b0) * (b - b0)) / (sb * sb)));
  }

  /** Smooth window in longitude, wrapped: 1 inside [a, b], feathered by f. */
  float lonWindow(float l, float a, float b, float f) {
    float c = 0.5 * (a + b), h = 0.5 * (b - a);
    float dl = abs(mod(l - c + 180.0, 360.0) - 180.0);
    return 1.0 - smoothstep(h, h + f, dl);
  }

  void main() {
    float l = (vUv.x - 0.5) * 360.0;         // degrees, -180..180
    float b = (vUv.y - 0.5) * 2.0 * degrees(uLatMax);
    float lr = radians(l), br = radians(b);
    vec3 d = vec3(cos(br) * cos(lr), cos(br) * sin(lr), sin(br));

    float toCentre = 0.5 + 0.5 * cos(lr);
    float inner = pow(toCentre, 1.5);

    // Warp the domain, so nothing sits on the noise lattice.
    vec3 q = vec3(fbm(d * 2.1 + 3.1, 4), fbm(d * 2.1 + 7.7, 4), fbm(d * 2.1 + 13.3, 4));
    vec3 w = d + 0.085 * q;
    // Stretched a little along the plane, as the real clouds are.
    vec3 wa = vec3(w.xy, w.z * 1.55);

    // --- starlight --------------------------------------------------------
    // The band's edge is not an exponential any more: its latitude wobbles,
    // and its thickness does, so the wings break up into lobes and spurs.
    float warp = 0.9 * sin(lr + 0.5) + 0.4 * sin(2.2 * lr + 2.0);
    float edgeWobble = 2.4 * fbm(wa * 3.0 + 40.0, 4);
    float bb = b - warp - edgeWobble * (0.4 + 0.6 * smoothstep(2.0, 9.0, abs(b)));
    float h = mix(2.6, 4.6, toCentre) * (0.85 + 0.35 * fbm(w * 1.6 + 70.0, 3));
    float disc = exp(-abs(bb) / h) + 0.30 * exp(-abs(bb) / (h * 2.8));
    disc *= 0.42 + 0.58 * inner;

    // A bulge that is broad, soft, a little boxy, and sits just south of the
    // plane, where the dust lets more of it through.
    float dl0 = abs(mod(l + 180.0, 360.0) - 180.0);
    float bulge = exp(-pow(abs(b + 1.8) / 7.0, 1.5)) * exp(-pow(dl0 / 13.0, 1.7));

    // Star clouds: mottling a few degrees across, higher contrast towards the
    // inner Galaxy, where the real ones (Scutum, Sagittarius) are brightest.
    float sc = fbm(wa * 5.2 + 21.0, 5);
    float clouds = 0.50 + 1.05 * smoothstep(-0.30, 0.40, sc) * (0.55 + 0.45 * inner);
    float grain = 0.84 + 0.32 * fbm(w * 26.0 + 5.0, 3);
    // And a faint, much wider glow around it: what the Ophiuchus dust is seen
    // against, well above the plane.
    float halo = exp(-pow(abs(b + 1.0) / 13.0, 1.2)) * exp(-pow(dl0 / 30.0, 1.5));
    float glow = (disc * clouds + bulge * (0.8 + 0.4 * clouds) * 2.1 + 0.30 * halo * clouds) * grain;

    // --- dust -------------------------------------------------------------
    // Clouds with edges rather than a smoke: a threshold on low-frequency
    // noise decides where dust is, and filaments and tendrils live mostly in
    // and around those clouds.
    float mass = fbm(wa * 4.2 + 50.0, 5);
    float fil = ridged(wa * 12.0 + q * 0.6, 6);
    float wisps = ridged(w * 30.0 + 7.0, 4);
    float cloudy = smoothstep(0.02, 0.30, mass);
    float fringe = smoothstep(-0.20, 0.10, mass);
    float structure = cloudy * (0.45 + 1.25 * pow(fil, 2.4))
                    + fringe * (0.35 * pow(fil, 5.0) + 0.45 * pow(wisps, 5.0));

    // A thin layer whose midline wanders, thicker towards the centre.
    float laneMid = -0.3 + 0.9 * sin(1.7 * lr + 1.0) + 1.6 * fbm(w * 2.5 + 90.0, 3);
    float hDust = mix(1.4, 2.9, inner) * (0.8 + 0.5 * fbm(w * 2.0 + 60.0, 3));
    float layer = exp(-abs(b - laneMid) / hDust) * mix(0.75, 1.3, inner);

    // The Great Rift: one coherent dark lane from Cygnus into Ophiuchus.
    float riftMid = 1.2 + 1.5 * smoothstep(40.0, -5.0, l);
    float rift = lonWindow(l, -12.0, 88.0, 14.0)
               * exp(-pow((b - riftMid) / (2.2 + 1.4 * smoothstep(40.0, 0.0, l)), 2.0));

    // The big complexes, where they are.
    float complexes =
        1.30 * blob(l, b, 354.0, 15.0, 7.0, 6.0)      // Ophiuchus, rho Oph
      + 0.90 * blob(l, b,   2.0,  5.5, 3.0, 2.2)      // Pipe
      + 1.10 * blob(l, b,  28.0,  3.0, 12.0, 4.5)     // Aquila Rift
      + 0.95 * blob(l, b,  75.0,  1.0, 14.0, 3.2)     // Cygnus Rift
      + 0.60 * blob(l, b, 110.0, 12.0, 10.0, 5.0)     // Cepheus flare
      + 0.55 * blob(l, b, 172.0, -15.0, 8.0, 5.0)     // Taurus
      + 0.55 * blob(l, b, 210.0, -19.0, 5.5, 4.0)     // Orion
      + 1.40 * blob(l, b, 301.0, -1.0, 2.6, 3.0)      // Coalsack
      + 0.45 * blob(l, b, 340.0, 13.0, 5.0, 4.0)      // Lupus
      + 0.35 * blob(l, b, 300.0, -16.0, 3.0, 2.0)     // Chamaeleon
      + 0.35 * blob(l, b,   0.0, -19.0, 3.0, 1.6);    // Corona Australis

    float tau = (2.1 * layer + 1.9 * rift + 2.4 * complexes) * structure;
    // Nothing reaches the edge of the map.
    float fade = 1.0 - smoothstep(0.75, 0.98, abs(b) / degrees(uLatMax));
    tau *= fade;
    glow *= fade;

    // --- emission ---------------------------------------------------------
    float emission =
        blob(l, b, 287.6, -0.6, 1.1, 0.9)   // Carina
      + blob(l, b,   6.0, -1.2, 0.7, 0.6)   // Lagoon
      + blob(l, b,  17.0,  0.8, 0.6, 0.6)   // Eagle, Omega
      + blob(l, b,  85.0, -1.0, 1.2, 1.0)   // North America
      + blob(l, b, 206.3, -2.1, 0.8, 0.8)   // Rosette
      + blob(l, b, 209.0, -19.4, 0.6, 0.6)  // Orion Nebula
      + 0.5 * blob(l, b, 267.0, -1.0, 6.0, 2.0); // Gum/Vela, faint and wide
    emission *= 0.65 + 0.7 * smoothstep(-0.2, 0.4, fbm(w * 18.0 + 11.0, 3));

    vec4 value = vec4(tau, glow, clouds * fade + (1.0 - fade), emission);
    gl_FragColor = clamp(value / STRUCTURE_RANGE, 0.0, 1.0);
  }
`;

function bakeStructure(renderer, width, height) {
  const floatOk =
    renderer.extensions.has('EXT_color_buffer_half_float') ||
    renderer.extensions.has('EXT_color_buffer_float');
  const rt = new THREE.WebGLRenderTarget(width, height, {
    type: floatOk ? THREE.HalfFloatType : THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });

  const material = new THREE.ShaderMaterial({
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = position.xy * 0.5 + 0.5;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: BAKE_FRAG,
    uniforms: { uLatMax: { value: MW_NOISE.mapLatitude * DEG } },
    depthTest: false,
    depthWrite: false,
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3)
  );
  const quad = new THREE.Mesh(geometry, material);
  quad.frustumCulled = false;
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  // In strips, so no single draw holds the GPU long enough to trip a
  // driver watchdog on a slow machine.
  // A render target carries its own scissor, applied when it is bound.
  const prevTarget = renderer.getRenderTarget();
  const STRIPS = 8;
  rt.scissorTest = true;
  for (let s = 0; s < STRIPS; s++) {
    const y0 = Math.floor((s * height) / STRIPS);
    const y1 = Math.floor(((s + 1) * height) / STRIPS);
    rt.scissor.set(0, y0, width, y1 - y0);
    renderer.setRenderTarget(rt);
    renderer.render(quad, camera);
    renderer.getContext().flush();
  }
  rt.scissor.set(0, 0, width, height);
  rt.scissorTest = false;
  renderer.setRenderTarget(prevTarget);

  geometry.dispose();
  material.dispose();
  return rt;
}

const STAR_VERT = /* glsl */ `
  uniform float uPixelRatio;
  uniform float uOpacity;
  uniform float uStructured;
  uniform sampler2D uStructure;
  uniform float uLatMax;
  uniform float uSpan;
  uniform vec3 uRose;
  ${STRUCTURE_RANGE}
  attribute float aLevel;
  attribute float aTau;
  attribute float aFront;
  varying float vAlpha;
  varying vec3 vTint;

  void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);

    float level = aLevel;
    float tau = aTau;
    if (uStructured > 0.5) {
      vec3 d = normalize(position);
      float b = asin(clamp(d.y, -1.0, 1.0));
      float l = atan(-d.z, d.x);
      vec4 m = textureLod(uStructure, vec2(l / 6.2831853 + 0.5, b / (2.0 * uLatMax) + 0.5), 0.0) * STRUCTURE_RANGE;
      float t = m.r * aFront;
      tau += t;
      // Extinction and star clouds both act on flux, which is what the
      // normalised level is the logarithm of.
      level += (log(max(m.b, 0.05)) - t) / (2.302585 * uSpan);
    }
    float n = clamp(level, 0.0, 1.0);

    gl_PointSize = (0.58 + 2.30 * pow(n, 2.1)) * uPixelRatio;
    vAlpha = (0.005 + 0.76 * pow(n, 2.6)) * uOpacity;
    // Reddening has to bite hard in the lane and not at all out of the plane.
    // Optical depth alone is too generous away from b = 0, so it is raised to
    // a power: negligible below about one, decisive above two.
    vTint = mix(color, uRose, min(0.85, pow(tau / 3.2, 1.8)));
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
 * threading through the middle of both. This is the smooth version, kept as
 * it was for when the structure is switched off.
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
 * The structured version: the band read from the baked map, with the dust
 * given a little sub-texel grit so its edges stay crisp at full resolution.
 * Light that comes through thin dust is reddened towards a warm brown; light
 * that meets thick dust does not come through at all.
 */
const HAZE_FRAG_STRUCTURED = /* glsl */ `
  uniform float uOpacity;
  uniform vec3 uCore;
  uniform vec3 uBand;
  uniform sampler2D uStructure;
  uniform float uLatMax;
  uniform float uBandGain;
  varying vec3 vLocal;
  ${GNOISE}
  ${STRUCTURE_RANGE}

  void main() {
    vec3 d = normalize(vLocal);
    float b = asin(clamp(d.y, -1.0, 1.0));
    float l = atan(-d.z, d.x);
    vec4 m = texture2D(uStructure, vec2(l / 6.2831853 + 0.5, b / (2.0 * uLatMax) + 0.5)) * STRUCTURE_RANGE;

    float grit = gnoise(d * 340.0) * 0.6 + gnoise(d * 760.0) * 0.4;
    float tau = max(m.r, 0.0) * (1.0 + 0.30 * grit);
    float glow = max(m.g, 0.0);
    float absorb = exp(-tau);
    float light = glow * absorb;

    float toCentre = 0.5 + 0.5 * cos(l);
    float bulgeness = exp(-abs(b) / 0.13) * exp(-(l * l) / (2.0 * 0.26 * 0.26));

    // The palette's ochre and rose stay underneath, but in the photograph the
    // band is starlight first: where it is bright it is a warm cream, and the
    // colour lives in the fainter light and at the edges of the dust.
    vec3 cream = vec3(0.95, 0.92, 0.85);
    vec3 col = mix(uBand, mix(uCore, cream, 0.45), clamp(0.25 * pow(toCentre, 1.4) + bulgeness, 0.0, 1.0));
    col = mix(col, cream, clamp(light * 0.55, 0.0, 0.72));
    // Thin dust: some light through, and redder for it. Peaks near tau = 0.7.
    float redden = clamp(4.0 * absorb * (1.0 - absorb), 0.0, 1.0);
    col = mix(col, vec3(0.60, 0.40, 0.28), redden * 0.5);
    col += vec3(0.55, 0.16, 0.30) * m.a * absorb * 0.8;

    float a = light * 1.3;
    // With somewhere to put it, the brightest part of the band goes past white.
    a *= 1.0 + uBandGain * smoothstep(0.7, 1.8, light);
    a = uBandGain > 0.0 ? a : min(a, 1.9);
    gl_FragColor = vec4(col, a * uOpacity);
  }
`;

/**
 * The shell is parented to the camera's position but never to its rotation, so
 * the band stays fixed on the sky while the viewer turns. It renders after the
 * galaxies and additively, which washes out whatever is behind it rather than
 * cleanly hiding it.
 */
export function makeMilkyWay(renderer, starCount, rng, { detail = 1 } = {}) {
  const group = new THREE.Group();
  group.frustumCulled = false;

  const structure = bakeStructure(
    renderer,
    Math.round(MW_NOISE.mapWidth * detail),
    Math.round(MW_NOISE.mapHeight * detail)
  );

  const stars = generateStars(starCount, rng);
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(stars.position, 3));
  starGeo.setAttribute('aLevel', new THREE.BufferAttribute(stars.level, 1));
  starGeo.setAttribute('aTau', new THREE.BufferAttribute(stars.tau, 1));
  starGeo.setAttribute('aFront', new THREE.BufferAttribute(stars.front, 1));
  starGeo.setAttribute('color', new THREE.BufferAttribute(stars.color, 3));
  starGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), MW_SHELL_RADIUS * 1.1);

  const starMat = new THREE.ShaderMaterial({
    vertexShader: STAR_VERT,
    fragmentShader: STAR_FRAG,
    uniforms: {
      uPixelRatio: { value: 1 },
      uOpacity: { value: 1 },
      uStructured: { value: 0 },
      uStructure: { value: structure.texture },
      uLatMax: { value: MW_NOISE.mapLatitude * DEG },
      uSpan: { value: stars.span },
      uRose: { value: new THREE.Color(COLOR.mwBand) },
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

  const hazeUniforms = {
    uOpacity: { value: 0.27 },
    uCore: { value: new THREE.Color(COLOR.mwCore) },
    uBand: { value: new THREE.Color(COLOR.mwBand) },
  };
  const hazeOptions = {
    vertexShader: HAZE_VERT,
    side: THREE.BackSide,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  };
  const smoothHaze = new THREE.ShaderMaterial({
    ...hazeOptions,
    fragmentShader: HAZE_FRAG,
    uniforms: hazeUniforms,
  });
  const structuredHaze = new THREE.ShaderMaterial({
    ...hazeOptions,
    fragmentShader: HAZE_FRAG_STRUCTURED,
    uniforms: {
      ...hazeUniforms,
      uStructure: { value: structure.texture },
      uLatMax: { value: MW_NOISE.mapLatitude * DEG },
      uBandGain: { value: 0 },
    },
  });

  const haze = new THREE.Mesh(
    new THREE.SphereGeometry(MW_SHELL_RADIUS, 64, 48),
    smoothHaze
  );
  haze.frustumCulled = false;
  haze.renderOrder = 10;

  group.add(haze, starPoints);

  return {
    group,
    structure,
    setPixelRatio(pr) {
      starMat.uniforms.uPixelRatio.value = pr;
    },
    /** Opacity is a function of where the camera is, not of where t is. */
    setOpacity(v) {
      group.visible = v > 0.002;
      starMat.uniforms.uOpacity.value = v;
      hazeUniforms.uOpacity.value = 0.27 * v;
    },
    setFx({ structured, hdr }) {
      starMat.uniforms.uStructured.value = structured ? 1 : 0;
      haze.material = structured ? structuredHaze : smoothHaze;
      structuredHaze.uniforms.uBandGain.value = hdr ? HDR.bandGain : 0;
    },
  };
}
