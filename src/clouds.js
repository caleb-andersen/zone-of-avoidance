import * as THREE from 'three';
import { COLOR, MAX_DISTANCE } from './constants.js';

/**
 * Point size comes from K-band magnitude, softened by distance from the
 * camera. Full inverse-distance falloff over a 160 Mpc range would make the
 * nearest galaxies enormous while standing at the origin, so the attenuation
 * is deliberately gentle.
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

  attribute float aBright;
  attribute vec2 aShape;
  attribute float aDist;

  varying float vAngle;
  varying float vQ;
  varying float vAlpha;
  varying vec3 vColor;

  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;

    float camDist = max(-mv.z, 0.001);
    float lum = 0.34 + 2.05 * pow(aBright, 1.45);
    float atten = pow(uRefDist / (uRefDist + camDist), 0.55);
    gl_PointSize = clamp(
      uSizeScale * lum * atten * uPixelRatio,
      uMinPx * uPixelRatio,
      uMaxPx * uPixelRatio
    );

    // Tint by distance from us, not from the camera: depth in the map should
    // not change when the camera moves.
    float depth = clamp(aDist / uFarDist, 0.0, 1.0);
    vColor = mix(uNearColor, uFarColor, pow(depth, 0.65));
    vAlpha = uOpacity * mix(1.0, uFarDim, pow(depth, 0.85)) * (0.40 + 0.60 * aBright);
    vAngle = aShape.x;
    vQ = aShape.y;
  }
`;

/** Rotate the sprite's UVs by the galaxy's own angle, then squash them. */
const ELLIPSE = /* glsl */ `
  vec2 ellipseCoord(float angle, float q) {
    vec2 uv = gl_PointCoord * 2.0 - 1.0;
    float s = sin(angle), c = cos(angle);
    vec2 p = vec2(c * uv.x - s * uv.y, s * uv.x + c * uv.y);
    p.y /= max(q, 0.10);
    return p;
  }
`;

/**
 * A cored elliptical profile: a small bright nucleus falling into a much
 * broader halo. A single gaussian reads as dust on the lens; this reads as a
 * disc seen at an angle.
 */
const FRAG_GALAXY = /* glsl */ `
  varying float vAngle;
  varying float vQ;
  varying float vAlpha;
  varying vec3 vColor;
  ${ELLIPSE}

  void main() {
    vec2 p = ellipseCoord(vAngle, vQ);
    float r = length(p);
    if (r > 1.0) discard;
    float nucleus = exp(-r * r * 26.0);
    float halo = exp(-pow(r + 0.02, 0.62) * 3.05);
    float edge = 1.0 - smoothstep(0.70, 1.0, r);
    float i = (0.95 * nucleus + 0.80 * halo) * edge;
    gl_FragColor = vec4(vColor, i * vAlpha);
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
  ${ELLIPSE}

  void main() {
    vec2 p = ellipseCoord(vAngle, vQ);
    float r = length(p);
    if (r > 1.0) discard;
    float ring = exp(-pow((r - 0.55) / 0.155, 2.0));
    float fill = 0.09 * (1.0 - smoothstep(0.0, 0.58, r));
    float edge = 1.0 - smoothstep(0.78, 1.0, r);
    float i = (ring * 0.92 + fill) * edge;
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
    renderOrder: 1,
  });
}

export function makeEstimateCloud(set) {
  return buildCloud(set, FRAG_ESTIMATE, {
    sizeScale: 26,
    minPx: 5.0,
    maxPx: 26,
    farDim: 0.52,
    opacity: 0,
    nearColor: COLOR.synth,
    farColor: 0x4d708c,
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
