import * as THREE from 'three';
import { COLOR, MASK_URL, MASK_RADIUS, DEG } from './constants.js';

/**
 * The blocked sky, as a solid.
 *
 * The boundary is not a formula. It is the 50% completeness contour measured
 * off the catalogue itself by scripts/build-zoa-mask.mjs, shipped as a few
 * hundred numbers, and read here as it was written. Nothing about the shape is
 * decided in this file: what it does is turn a curve on the sky into something
 * with a near side and a far side.
 *
 * The volume is what the contour sweeps out from the origin to the edge of the
 * catalogue -- a belt around the whole sky, pinched to a point at the observer,
 * which is the correct shape for an obstruction that is a property of where we
 * are standing. Its surface is three pieces: a ruled sheet along the northern
 * boundary, another along the southern, and the spherical cap between them at
 * the far end.
 *
 * Both sheets contain the origin, so from the origin they are seen exactly
 * edge-on and cover no pixels at all: standing inside it, all that is visible
 * is the cap filling the band and the two hairlines bounding it, which is
 * precisely what the blocked sky looks like from here. They only open into
 * surfaces once the camera has somewhere else to be. That falls out of the
 * geometry rather than being staged.
 */

/**
 * Points per measured longitude sample. The contour was measured at 2 degrees
 * and carries no structure below about 25, so this is not inventing detail --
 * it is keeping the 2-degree sampling from reading as facets on a surface
 * 160 megaparsecs across.
 */
const SUBDIVISIONS = 3;
/** Rings along the radius. The surface normal does not vary along it. */
const RADIAL = [0.004, 0.36, 0.7, 1];
/** Steps across the cap, between the southern and northern boundary. */
const CAP_STEPS = 10;

export async function loadMask() {
  const base = import.meta.env?.BASE_URL ?? '/';
  const res = await fetch(base + MASK_URL);
  if (!res.ok) throw new Error(`mask request failed (${res.status})`);
  const mask = await res.json();
  if (!Array.isArray(mask.upper) || mask.upper.length !== mask.nLon) {
    throw new Error('mask contour is malformed');
  }
  return mask;
}

/** Catmull-Rom through four samples, wrapped, so the curve closes on itself. */
function resample(values, sub) {
  const n = values.length;
  const out = new Float64Array(n * sub);
  for (let i = 0; i < n; i++) {
    const p0 = values[(i - 1 + n) % n];
    const p1 = values[i];
    const p2 = values[(i + 1) % n];
    const p3 = values[(i + 2) % n];
    for (let s = 0; s < sub; s++) {
      const t = s / sub;
      const t2 = t * t;
      const t3 = t2 * t;
      out[i * sub + s] = 0.5 * (
        2 * p1 +
        (p2 - p0) * t +
        (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
        (3 * p1 - p0 - 3 * p2 + p3) * t3
      );
    }
  }
  return out;
}

/** Render frame: X towards l = 0, Y galactic north, Z = -y. */
function direction(lDeg, bDeg, out) {
  const l = lDeg * DEG;
  const b = bDeg * DEG;
  const cb = Math.cos(b);
  out.set(cb * Math.cos(l), Math.sin(b), -cb * Math.sin(l));
  return out;
}

/**
 * A ruled sheet: the boundary direction at each longitude, swept from the
 * apex out to the rim. Its normal is perpendicular to the ray and to the
 * boundary's own tangent, and because every point along a ray shares that ray,
 * the normal does not vary with radius -- so it is worked out once per
 * longitude and written to every ring.
 */
function sheet(lon, lat, flip) {
  const n = lon.length;
  const rings = RADIAL.length;
  const position = new Float32Array(n * rings * 3);
  const normal = new Float32Array(n * rings * 3);
  const radial = new Float32Array(n * rings);
  const wall = new Float32Array(n * rings);

  const d = new THREE.Vector3();
  const next = new THREE.Vector3();
  const prev = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const nrm = new THREE.Vector3();

  for (let j = 0; j < n; j++) {
    direction(lon[j], lat[j], d);
    direction(lon[(j + 1) % n], lat[(j + 1) % n], next);
    direction(lon[(j - 1 + n) % n], lat[(j - 1 + n) % n], prev);
    tangent.subVectors(next, prev);
    nrm.crossVectors(d, tangent).normalize();
    if (flip) nrm.negate();

    for (let i = 0; i < rings; i++) {
      const k = (i * n + j) * 3;
      const r = RADIAL[i] * MASK_RADIUS;
      position[k] = d.x * r;
      position[k + 1] = d.y * r;
      position[k + 2] = d.z * r;
      normal[k] = nrm.x;
      normal[k + 1] = nrm.y;
      normal[k + 2] = nrm.z;
      radial[i * n + j] = RADIAL[i];
    }
  }

  return { position, normal, radial, wall, rows: rings, cols: n };
}

/** The far end: the sky between the two boundaries, at the catalogue's edge. */
function cap(lon, lower, upper) {
  const n = lon.length;
  const rows = CAP_STEPS + 1;
  const position = new Float32Array(n * rows * 3);
  const normal = new Float32Array(n * rows * 3);
  const radial = new Float32Array(n * rows);
  const wall = new Float32Array(n * rows).fill(1);
  const d = new THREE.Vector3();

  for (let i = 0; i < rows; i++) {
    const f = i / CAP_STEPS;
    for (let j = 0; j < n; j++) {
      direction(lon[j], lower[j] + f * (upper[j] - lower[j]), d);
      const k = (i * n + j) * 3;
      position[k] = d.x * MASK_RADIUS;
      position[k + 1] = d.y * MASK_RADIUS;
      position[k + 2] = d.z * MASK_RADIUS;
      normal[k] = d.x;
      normal[k + 1] = d.y;
      normal[k + 2] = d.z;
      radial[i * n + j] = 1;
    }
  }

  return { position, normal, radial, wall, rows, cols: n };
}

/** Quad strip indices for a grid that wraps in the column direction. */
function appendGridIndices(into, rows, cols, offset) {
  for (let i = 0; i < rows - 1; i++) {
    for (let j = 0; j < cols; j++) {
      const a = offset + i * cols + j;
      const b = offset + i * cols + ((j + 1) % cols);
      const c = offset + (i + 1) * cols + j;
      const e = offset + (i + 1) * cols + ((j + 1) % cols);
      into.push(a, c, b, b, c, e);
    }
  }
}

function mergeParts(parts) {
  const total = parts.reduce((s, p) => s + p.rows * p.cols, 0);
  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  const radial = new Float32Array(total);
  const wall = new Float32Array(total);
  const index = [];

  let at = 0;
  for (const p of parts) {
    position.set(p.position, at * 3);
    normal.set(p.normal, at * 3);
    radial.set(p.radial, at);
    wall.set(p.wall, at);
    appendGridIndices(index, p.rows, p.cols, at);
    at += p.rows * p.cols;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  geometry.setAttribute('aRadial', new THREE.BufferAttribute(radial, 1));
  geometry.setAttribute('aWall', new THREE.BufferAttribute(wall, 1));
  geometry.setIndex(index);
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), MASK_RADIUS * 1.05);
  return geometry;
}

const SURFACE_VERT = /* glsl */ `
  attribute float aRadial;
  attribute float aWall;
  varying vec3 vNormal;
  varying vec3 vView;
  varying float vRadial;
  varying float vWall;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vNormal = normalMatrix * normal;
    vView = -mv.xyz;
    vRadial = aRadial;
    vWall = aWall;
    gl_Position = projectionMatrix * mv;
  }
`;

/**
 * Translucent in the way a volume is translucent rather than the way a pane of
 * glass is: the fill gathers along the silhouette and thins out face-on, so
 * what carries is the edge, which is where the measurement is. It stays very
 * low throughout. The wedge is enormous -- near the plane a single sheet can
 * cross most of the frame -- and anything strong enough to read as a surface
 * in its own right would be a curtain drawn over the galaxies it exists to
 * point at. The hairline states the boundary; the fill only says which side of
 * it is the inside.
 */
const SURFACE_FRAG = /* glsl */ `
  uniform float uOpacity;
  uniform vec3 uColor;
  varying vec3 vNormal;
  varying vec3 vView;
  varying float vRadial;
  varying float vWall;

  void main() {
    vec3 n = normalize(vNormal);
    vec3 v = normalize(vView);
    // Seen from the origin the cap is exactly face-on, and rounding can put
    // |n.v| a hair over one; pow of a negative is NaN, which a float target
    // keeps and a tonemapper turns black.
    float graze = pow(max(1.0 - abs(dot(n, v)), 0.0), 1.8);
    float body = mix(0.30, 1.0, graze);
    // Thin towards the apex: the two sheets converge on the observer and would
    // otherwise pile a bright knot up at the origin, where there is nothing.
    float taper = mix(0.34, 1.0, smoothstep(0.0, 0.60, vRadial));
    // The far wall is the back of the volume and should read as further away
    // than the sheets in front of it.
    float weight = mix(1.0, 0.42, vWall);
    gl_FragColor = vec4(uColor, uOpacity * body * taper * weight);
  }
`;

function rimLoop(lon, lat, material) {
  const n = lon.length;
  const position = new Float32Array(n * 3);
  const d = new THREE.Vector3();
  for (let j = 0; j < n; j++) {
    direction(lon[j], lat[j], d);
    position[j * 3] = d.x * MASK_RADIUS;
    position[j * 3 + 1] = d.y * MASK_RADIUS;
    position[j * 3 + 2] = d.z * MASK_RADIUS;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), MASK_RADIUS * 1.05);
  const loop = new THREE.LineLoop(geometry, material);
  loop.frustumCulled = false;
  loop.renderOrder = 6;
  return loop;
}

export function makeMask(mask) {
  const sub = SUBDIVISIONS;
  const n = mask.nLon * sub;
  const lon = new Float64Array(n);
  for (let i = 0; i < n; i++) lon[i] = mask.lon0 + (i / sub) * mask.dLon;
  const upper = resample(mask.upper, sub);
  const lower = resample(mask.lower, sub);

  const geometry = mergeParts([
    sheet(lon, upper, false),
    sheet(lon, lower, true),
    cap(lon, lower, upper),
  ]);

  const material = new THREE.ShaderMaterial({
    vertexShader: SURFACE_VERT,
    fragmentShader: SURFACE_FRAG,
    uniforms: {
      uOpacity: { value: 0 },
      uColor: { value: new THREE.Color(COLOR.mask) },
    },
    side: THREE.DoubleSide,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const surface = new THREE.Mesh(geometry, material);
  surface.frustumCulled = false;
  surface.renderOrder = 5;

  // A hairline, and it has to stay one: WebGL will not widen a line, which for
  // once is exactly the wanted behaviour. It is the same curve the sheets are
  // ruled from, so it sits on the silhouette from the origin and traces the
  // mouth of the cone from anywhere else.
  const rimMaterial = new THREE.LineBasicMaterial({
    color: new THREE.Color(COLOR.maskRim),
    transparent: true,
    opacity: 0,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const group = new THREE.Group();
  group.frustumCulled = false;
  group.renderOrder = 5;
  group.add(
    surface,
    rimLoop(lon, upper, rimMaterial),
    rimLoop(lon, lower, rimMaterial)
  );

  // A supersampled frame is resolved by averaging, which would thin a one-pixel
  // line to a fraction of itself. Brightening it by the scale puts the same
  // light back, spread over the pixel it now covers only part of.
  let lineScale = 1;
  let opacity = 0;

  return {
    group,
    setOpacity(v) {
      opacity = v;
      group.visible = v > 0.002;
      material.uniforms.uOpacity.value = 0.072 * v;
      rimMaterial.opacity = 0.55 * v * lineScale;
    },
    setLineScale(s) {
      lineScale = Math.max(1, s);
      rimMaterial.opacity = 0.55 * opacity * lineScale;
    },
  };
}
