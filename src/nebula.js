import * as THREE from 'three';
import { NEBULA, DEPTH_CUE, MAX_DISTANCE } from './constants.js';

/**
 * Soft light where the measured galaxies crowd together.
 *
 * This is light nobody measured, so it is held to three rules. It comes only
 * from observed galaxies -- the estimates in the blocked band never get any.
 * It comes only from galaxies well above the survey's mean density at their
 * distance, so a lone field galaxy gets nothing and a cluster gets a glow the
 * size of its members' spacing. And it is switched off inside the measured
 * Zone of Avoidance, so the clouds of galaxies along its edge stop where the
 * survey stopped seeing instead of seeping into the gap.
 *
 * Each sprite is a camera-facing quad, not a point: at the origin a nearby
 * group can be most of the sky across, which is past what gl_PointSize will
 * draw. They are accumulated at quarter resolution into their own target and
 * compressed as a sum there, in src/post.js.
 */

const VERT = /* glsl */ `
  uniform float uOpacity;
  uniform vec3 uNear;
  uniform vec3 uFar;
  uniform float uFarDist;
  uniform float uCue;
  uniform vec2 uCueRange;
  uniform float uCueDesat;
  uniform float uCueDim;

  attribute vec3 aCenter;
  attribute float aRadius;
  attribute float aWeight;
  attribute float aDist;

  varying vec2 vQuad;
  varying vec3 vWorld;
  varying vec3 vColor;
  varying float vWeight;

  void main() {
    vec4 mvCenter = viewMatrix * vec4(aCenter, 1.0);
    float camDist = -mvCenter.z;

    // A cloud tens of degrees across is not a cloud any more, it is a fog over
    // the whole frame -- and from the origin, hundreds of nearby groups are
    // exactly that, and would cost more to draw than everything else put
    // together. Fade them out between about 16 and 9 degrees of radius, and
    // drop the ones behind the camera altogether. From out in the orbit
    // almost nothing is that close.
    float nearFade = smoothstep(3.5, 6.5, camDist / aRadius);
    if (nearFade <= 0.0) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }

    vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    vWorld = aCenter + (right * position.x + up * position.y) * aRadius;
    vQuad = position.xy;

    vec4 mv = mvCenter + vec4(position.xy * aRadius, 0.0, 0.0);
    gl_Position = projectionMatrix * mv;

    // The same depth tint the galaxies use, so the cloud reads as their light.
    float originDepth = clamp(aDist / uFarDist, 0.0, 1.0);
    float camDepth = clamp((camDist - uCueRange.x) / (uCueRange.y - uCueRange.x), 0.0, 1.0);
    float depth = mix(originDepth, min(originDepth, camDepth), uCue);
    vec3 color = mix(uNear, uFar, pow(depth, 0.65));
    float fog = uCue * smoothstep(0.42, 1.0, camDepth);
    // Greyed and dimmed with distance like the galaxies, but never pushed
    // towards the background's blue: a blue cloud would read as the estimates.
    float grey = dot(color, vec3(0.299, 0.587, 0.114));
    color = mix(color, vec3(grey), fog * uCueDesat);
    vColor = color;
    vWeight = aWeight * nearFade * uOpacity * mix(1.0, 0.55, pow(depth, 0.85))
            * mix(1.0, uCueDim, fog);
  }
`;

const FRAG = /* glsl */ `
  uniform sampler2D uMask;
  uniform float uFeather;
  varying vec2 vQuad;
  varying vec3 vWorld;
  varying vec3 vColor;
  varying float vWeight;

  void main() {
    float rr = dot(vQuad, vQuad);
    if (rr >= 1.0) discard;
    // Flat-topped, so neighbours merge into one cloud instead of a string of
    // separate puffs.
    float profile = (1.0 - rr) * (1.0 - rr);

    // Where on the sky this bit of cloud sits, in galactic degrees, against
    // the measured boundary at that longitude. Render frame: x = X, y = -Z, z = Y.
    vec3 d = normalize(vWorld);
    float b = degrees(asin(clamp(d.y, -1.0, 1.0)));
    float l = atan(-d.z, d.x);
    vec4 edge = texture2D(uMask, vec2(fract(l / 6.2831853), 0.5));
    float upper = edge.r * 25.5;
    float lower = -edge.g * 25.5;
    float outside = max(
      smoothstep(upper, upper + uFeather, b),
      1.0 - smoothstep(lower - uFeather, lower, b)
    );

    float w = vWeight * profile * outside;
    if (w <= 0.0) discard;
    gl_FragColor = vec4(vColor * w, w);
  }
`;

/**
 * The measured boundary as a 180-texel strip: upper edge in red, lower in
 * green, both as degrees over 25.5. Texel i is centred on l = 1 + 2i, which is
 * exactly where the contour was sampled, so linear filtering reads it back.
 */
function maskTexture(mask) {
  const n = mask.nLon;
  const data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    data[i * 4] = Math.round(Math.min(25.5, Math.max(0, mask.upper[i])) * 10);
    data[i * 4 + 1] = Math.round(Math.min(25.5, Math.max(0, -mask.lower[i])) * 10);
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, n, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function makeNebula(cat, mask) {
  const { overdensity, neighbourDist, position, dist, count } = cat;
  if (!overdensity) return null;

  const lo = Math.log(NEBULA.overdensityFrom);
  const hi = Math.log(NEBULA.overdensityTo);

  const picked = [];
  for (let i = 0; i < count; i++) {
    if (overdensity[i] > NEBULA.overdensityFrom) picked.push(i);
  }
  const n = picked.length;

  const center = new Float32Array(n * 3);
  const radius = new Float32Array(n);
  const weight = new Float32Array(n);
  const depth = new Float32Array(n);
  for (let j = 0; j < n; j++) {
    const i = picked[j];
    center[j * 3] = position[i * 3];
    center[j * 3 + 1] = position[i * 3 + 1];
    center[j * 3 + 2] = position[i * 3 + 2];
    radius[j] = Math.min(
      NEBULA.maxRadius,
      Math.max(NEBULA.minRadius, NEBULA.radiusPerNeighbour * neighbourDist[i])
    );
    weight[j] = NEBULA.weight * smoothstep(lo, hi, Math.log(overdensity[i]));
    depth[j] = dist[i];
  }

  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3)
  );
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.setAttribute('aCenter', new THREE.InstancedBufferAttribute(center, 3));
  geometry.setAttribute('aRadius', new THREE.InstancedBufferAttribute(radius, 1));
  geometry.setAttribute('aWeight', new THREE.InstancedBufferAttribute(weight, 1));
  geometry.setAttribute('aDist', new THREE.InstancedBufferAttribute(depth, 1));
  geometry.instanceCount = n;
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), MAX_DISTANCE * 1.1);

  const material = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uOpacity: { value: 1 },
      uNear: { value: new THREE.Color(NEBULA.color) },
      uFar: { value: new THREE.Color(NEBULA.farColor) },
      uFarDist: { value: MAX_DISTANCE },
      uCue: { value: 0 },
      uCueRange: { value: new THREE.Vector2(0, MAX_DISTANCE) },
      uCueDesat: { value: DEPTH_CUE.desaturate },
      uCueDim: { value: DEPTH_CUE.dim },
      uMask: { value: maskTexture(mask) },
      uFeather: { value: NEBULA.maskFeather },
    },
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    premultipliedAlpha: true,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;

  const scene = new THREE.Scene();
  scene.add(mesh);

  return { scene, material, count: n };
}
