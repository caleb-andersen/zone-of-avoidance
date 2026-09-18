import * as THREE from 'three';
import { HDR, NEBULA } from './constants.js';

/**
 * Everything between the scene and the canvas.
 *
 * With every switch off this does nothing at all: the scene is drawn straight
 * into the canvas, which composites over the page background the way it always
 * has. Each switch adds one stage.
 *
 *   scene --(nebula underneath)--> scene target, at display size x render scale
 *         --resolve--> display size          (only if the scale is not 1)
 *         --bloom, ACES--> canvas            (only with HDR; else a plain copy)
 *
 * The canvas keeps its alpha throughout, so the page's gradient still shows
 * through wherever nothing was drawn, exactly as before.
 */

const FULLSCREEN_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = position.xy * 0.5 + 0.5;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

/** Interleaved gradient noise: a cheap, well-spread per-pixel dither. */
const DITHER = /* glsl */ `
  float ign(vec2 p) {
    return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
  }
  /** Triangular noise in [-1, 1]: removes banding without adding texture. */
  float dither(vec2 p) {
    return ign(p) + ign(p + vec2(47.0, 17.0)) - 1.0;
  }
`;

/**
 * Supersample resolve. For an integer scale every tap lands on a texel centre,
 * so this is an exact box filter. With HDR each sample is weighted by a
 * reversible tonemap first: otherwise one sub-pixel core at twenty times white
 * would outvote the other fifteen samples and the edge would alias anyway.
 */
const RESOLVE_FRAG = /* glsl */ `
  uniform sampler2D tSrc;
  uniform vec2 uDstSize;
  uniform float uTaps;
  uniform float uKaris;

  void main() {
    vec4 sum = vec4(0.0);
    for (int j = 0; j < 4; j++) {
      if (float(j) >= uTaps) break;
      for (int i = 0; i < 4; i++) {
        if (float(i) >= uTaps) break;
        vec2 off = (vec2(float(i), float(j)) + 0.5) / uTaps - 0.5;
        vec4 c = texture2D(tSrc, (gl_FragCoord.xy + off) / uDstSize);
        if (any(isnan(c)) || any(isinf(c))) c = vec4(0.0);
        if (uKaris > 0.5) c.rgb /= 1.0 + max(max(c.r, c.g), c.b);
        sum += c;
      }
    }
    sum /= uTaps * uTaps;
    if (uKaris > 0.5) sum.rgb /= max(1.0 - max(max(sum.r, sum.g), sum.b), 1e-4);
    gl_FragColor = sum;
  }
`;

/**
 * Bloom downsample: the 13-tap filter from Jimenez, "Next Generation Post
 * Processing in Call of Duty" (2014), for every level but the first.
 *
 * The first level reads the whole frame and writes a quarter of it in each
 * direction, so it is four bilinear taps, each the average of a two-by-two
 * block, together exactly the four-by-four block its output texel stands for.
 * It also decodes, and applies a soft threshold so only what is past white
 * spreads.
 *
 * It deliberately skips the usual Karis average on that first level. That
 * weighting exists to stop lone bright pixels flickering, and here lone bright
 * pixels are the galaxy cores the bloom is for; they are also never smaller
 * than a few pixels, which is what makes the flicker it prevents. A plain
 * ceiling on each tap is enough to keep a stray value from blowing up.
 */
const PREFILTER_FRAG = /* glsl */ `
  uniform sampler2D tSrc;
  uniform vec2 uTexel;
  uniform float uThreshold;
  uniform float uKnee;
  varying vec2 vUv;

  vec3 tap(vec2 o) {
    vec3 c = texture2D(tSrc, vUv + o * uTexel).rgb;
    // One non-finite pixel would otherwise be spread into a black patch.
    if (any(isnan(c)) || any(isinf(c))) c = vec3(0.0);
    c = max(c, 0.0);
    #ifndef DECODE_IDENTITY
    c = pow(c, vec3(DECODE_GAMMA));
    #endif
    return min(c, vec3(64.0));
  }

  void main() {
    vec3 col = 0.25 * (tap(vec2(-1.0, -1.0)) + tap(vec2(1.0, -1.0)) + tap(vec2(-1.0, 1.0)) + tap(vec2(1.0, 1.0)));
    float br = max(max(col.r, col.g), col.b);
    float soft = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
    soft = soft * soft / (4.0 * uKnee + 1e-4);
    col *= max(br - uThreshold, soft) / max(br, 1e-4);
    gl_FragColor = vec4(col, 1.0);
  }
`;

const DOWNSAMPLE_FRAG = /* glsl */ `
  uniform sampler2D tSrc;
  uniform vec2 uTexel;
  varying vec2 vUv;

  vec3 tap(vec2 o) { return texture2D(tSrc, vUv + o * uTexel).rgb; }

  void main() {
    vec3 a = tap(vec2(-2.0, 2.0)), b = tap(vec2(0.0, 2.0)), c = tap(vec2(2.0, 2.0));
    vec3 d = tap(vec2(-2.0, 0.0)), e = tap(vec2(0.0, 0.0)), f = tap(vec2(2.0, 0.0));
    vec3 g = tap(vec2(-2.0, -2.0)), h = tap(vec2(0.0, -2.0)), i = tap(vec2(2.0, -2.0));
    vec3 j = tap(vec2(-1.0, 1.0)), k = tap(vec2(1.0, 1.0));
    vec3 l = tap(vec2(-1.0, -1.0)), m = tap(vec2(1.0, -1.0));

    vec3 col = (j + k + l + m) * 0.125
             + (a + c + g + i) * 0.03125
             + (b + d + f + h) * 0.0625
             + e * 0.125;
    gl_FragColor = vec4(col, 1.0);
  }
`;

/**
 * Bloom upsample: a 3x3 tent over the coarser level, mixed into this one. Four
 * bilinear taps, each half a texel off along a diagonal, average to the same
 * 1-2-1 tent as nine point taps, for less than half the fetches.
 */
const UPSAMPLE_FRAG = /* glsl */ `
  uniform sampler2D tLow;
  uniform sampler2D tHigh;
  uniform vec2 uTexel;
  uniform float uScatter;
  varying vec2 vUv;

  void main() {
    vec2 t = uTexel * 0.5;
    vec3 low = 0.25 * (
      texture2D(tLow, vUv + vec2(-t.x, -t.y)).rgb + texture2D(tLow, vUv + vec2(t.x, -t.y)).rgb +
      texture2D(tLow, vUv + vec2(-t.x, t.y)).rgb + texture2D(tLow, vUv + vec2(t.x, t.y)).rgb
    );
    gl_FragColor = vec4(mix(texture2D(tHigh, vUv).rgb, low, uScatter), 1.0);
  }
`;

/**
 * The last stage. ACES here is the RRT+ODT fit by Stephen Hill, as three.js
 * ships it, applied to the decoded scene plus bloom. Alpha passes through
 * untouched, so the page background still composites underneath.
 *
 * Applied channel by channel, ACES drains saturation long before anything is
 * bright -- the warm near galaxies go grey at full intensity, and the
 * estimates' blue, which has to match nothing else on screen, loses half its
 * colour. So up to white the curve is applied to the brightest channel and the
 * colour scaled by the same factor, which keeps hue and saturation exactly;
 * only above white does it hand over to the per-channel curve and its path to
 * white, which is what makes an overexposed core look overexposed.
 */
const COMPOSITE_FRAG = /* glsl */ `
  uniform sampler2D tScene;
  uniform sampler2D tBloom;
  uniform float uExposure;
  uniform float uBloom;
  varying vec2 vUv;
  ${DITHER}

  vec3 rrtAndOdtFit(vec3 v) {
    vec3 a = v * (v + 0.0245786) - 0.000090537;
    vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
    return a / b;
  }

  vec3 acesFilmic(vec3 color) {
    const mat3 inputMat = mat3(
      vec3(0.59719, 0.07600, 0.02840),
      vec3(0.35458, 0.90834, 0.13383),
      vec3(0.04823, 0.01566, 0.83777)
    );
    const mat3 outputMat = mat3(
      vec3( 1.60475, -0.10208, -0.00327),
      vec3(-0.53108,  1.10813, -0.07276),
      vec3(-0.07367, -0.00605,  1.07602)
    );
    color *= 1.0 / 0.6;
    color = inputMat * color;
    color = rrtAndOdtFit(color);
    color = outputMat * color;
    return clamp(color, 0.0, 1.0);
  }

  /** The ACES curve for a grey level, without the colour matrices. */
  float acesGrey(float v) {
    return clamp(rrtAndOdtFit(vec3(v / 0.6)).r, 0.0, 1.0);
  }

  vec3 tonemap(vec3 c) {
    float peak = max(max(c.r, c.g), c.b);
    vec3 held = c * (acesGrey(peak) / max(peak, 1e-6));
    // Nearly every pixel is well under white; only those past it pay for the
    // full per-channel curve.
    if (peak <= 1.0) return held;
    return mix(held, acesFilmic(c), smoothstep(1.0, 3.0, peak));
  }

  void main() {
    vec4 src = texture2D(tScene, vUv);
    if (any(isnan(src)) || any(isinf(src))) src = vec4(0.0);
    vec3 lin = max(src.rgb, 0.0);
    #ifndef DECODE_IDENTITY
    lin = pow(lin, vec3(DECODE_GAMMA));
    #endif
    lin += texture2D(tBloom, vUv).rgb * uBloom;
    vec3 outc = tonemap(lin * uExposure);
    #ifndef DECODE_IDENTITY
    outc = pow(outc, vec3(1.0 / DECODE_GAMMA));
    #endif
    outc += dither(gl_FragCoord.xy) / 255.0;
    gl_FragColor = vec4(max(outc, 0.0), clamp(src.a, 0.0, 1.0));
  }
`;

/**
 * The nebula layer is drawn at low resolution into its own target, as summed
 * weight in alpha and weighted colour in rgb, and only compressed here. That
 * is what lets a rich cluster glow without burning while a thin filament still
 * registers: the curve applies to the sum, not to each sprite.
 */
const NEBULA_FRAG = /* glsl */ `
  uniform sampler2D tNebula;
  uniform vec2 uTexel;
  uniform float uKnee;
  uniform float uGain;
  uniform float uToe;
  varying vec2 vUv;
  ${DITHER}

  void main() {
    vec2 t = uTexel * 0.5;
    vec4 s = 0.25 * (
      texture2D(tNebula, vUv + vec2(-t.x, -t.y)) + texture2D(tNebula, vUv + vec2(t.x, -t.y)) +
      texture2D(tNebula, vUv + vec2(-t.x, t.y)) + texture2D(tNebula, vUv + vec2(t.x, t.y))
    );
    float w = max(s.a, 0.0);
    vec3 col = s.rgb / max(w, 1e-5);
    // Several hundredfold between a thin filament and a rich cluster core,
    // brought within about tenfold of each other. The toe keeps the faint
    // overlap of unrelated clouds, which covers most of the frame, from
    // becoming a haze over all of it: only real concentrations glow.
    float lum = uGain * pow(w / (w + uKnee), 0.6) * smoothstep(0.0, uToe, w);
    lum = max(lum + dither(gl_FragCoord.xy) * 0.5 / 255.0, 0.0);
    gl_FragColor = vec4(col * lum, lum);
  }
`;

/**
 * The decode gamma is baked in rather than a uniform: at 1, which is what the
 * scene is graded for, the pow calls disappear from two full-frame passes.
 */
const DECODE = HDR.decodeGamma === 1
  ? { DECODE_IDENTITY: '' }
  : { DECODE_GAMMA: HDR.decodeGamma.toFixed(4) };

function pass(fragmentShader, uniforms, blending = THREE.NoBlending, defines = {}) {
  return new THREE.ShaderMaterial({
    vertexShader: FULLSCREEN_VERT,
    fragmentShader,
    uniforms,
    defines,
    blending,
    premultipliedAlpha: blending !== THREE.NoBlending,
    transparent: blending !== THREE.NoBlending,
    depthTest: false,
    depthWrite: false,
  });
}

function target(width, height, type) {
  const rt = new THREE.WebGLRenderTarget(width, height, {
    type,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  rt.texture.name = 'post';
  return rt;
}

/** Keep the supersampled target inside what the GPU and a sane budget allow. */
const PIXEL_BUDGET = 48e6;

export function createPipeline(renderer) {
  const gl = renderer.getContext();
  const floatOk =
    renderer.extensions.has('EXT_color_buffer_half_float') ||
    renderer.extensions.has('EXT_color_buffer_float');
  const maxSize = Math.min(
    gl.getParameter(gl.MAX_TEXTURE_SIZE),
    gl.getParameter(gl.MAX_RENDERBUFFER_SIZE)
  );

  const quad = new THREE.Mesh(
    (() => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
      return g;
    })()
  );
  quad.frustumCulled = false;
  const quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const resolveMat = pass(RESOLVE_FRAG, {
    tSrc: { value: null },
    uDstSize: { value: new THREE.Vector2() },
    uTaps: { value: 1 },
    uKaris: { value: 0 },
  });
  const prefilterMat = pass(PREFILTER_FRAG, {
    tSrc: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uThreshold: { value: HDR.bloomThreshold },
    uKnee: { value: HDR.bloomKnee },
  }, THREE.NoBlending, DECODE);
  const downMat = pass(DOWNSAMPLE_FRAG, {
    tSrc: { value: null },
    uTexel: { value: new THREE.Vector2() },
  });
  const upMat = pass(UPSAMPLE_FRAG, {
    tLow: { value: null },
    tHigh: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uScatter: { value: HDR.bloomScatter },
  });
  const compositeMat = pass(COMPOSITE_FRAG, {
    tScene: { value: null },
    tBloom: { value: null },
    uExposure: { value: HDR.exposure },
    uBloom: { value: HDR.bloomIntensity },
  }, THREE.NoBlending, DECODE);
  const nebulaMat = pass(
    NEBULA_FRAG,
    {
      tNebula: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uKnee: { value: NEBULA.knee },
      uGain: { value: NEBULA.gain },
      uToe: { value: NEBULA.toe },
    },
    THREE.AdditiveBlending
  );

  const noBloom = new THREE.DataTexture(new Uint8Array(4), 1, 1);
  noBloom.needsUpdate = true;

  const config = { width: 0, height: 0, scale: 1, hdr: false, nebula: false };
  let sceneRT = null;
  let resolveRT = null;
  let nebulaRT = null;
  let down = [];
  let up = [];
  /** The scale actually in use, after the GPU has had its say. */
  let effectiveScale = 1;

  function disposeTargets() {
    for (const rt of [sceneRT, resolveRT, nebulaRT, ...down, ...up]) rt?.dispose();
    sceneRT = resolveRT = nebulaRT = null;
    down = [];
    up = [];
  }

  function draw(material, rt) {
    quad.material = material;
    renderer.setRenderTarget(rt);
    renderer.render(quad, quadCamera);
  }

  /**
   * Sizes are in device pixels. Anything that has not changed keeps its
   * targets; anything that has rebuilds them all, which is cheap and rare.
   */
  function configure({ width, height, scale, hdr, nebula }) {
    const wantHdr = hdr && floatOk;
    const wantNebula = nebula && floatOk;
    const same =
      width === config.width && height === config.height && scale === config.scale &&
      wantHdr === config.hdr && wantNebula === config.nebula;
    if (same) return;
    Object.assign(config, { width, height, scale, hdr: wantHdr, nebula: wantNebula });
    disposeTargets();

    let s = scale;
    s = Math.min(s, maxSize / width, maxSize / height, Math.sqrt(PIXEL_BUDGET / (width * height)));
    effectiveScale = Math.max(0.25, s);
    const sw = Math.max(1, Math.round(width * effectiveScale));
    const sh = Math.max(1, Math.round(height * effectiveScale));
    const scaled = sw !== width || sh !== height;

    const type = wantHdr ? THREE.HalfFloatType : THREE.UnsignedByteType;
    if (wantHdr || scaled) sceneRT = target(sw, sh, type);

    if (wantHdr) {
      if (scaled) resolveRT = target(width, height, THREE.HalfFloatType);
      // The chain starts at a quarter of the frame, not half: the prefilter's
      // four taps cover exactly the four-by-four block each texel stands for,
      // and a half-resolution level costs more than the rest of the chain
      // together for a glow tighter than the one asked for.
      let w = Math.max(1, width >> 2);
      let h = Math.max(1, height >> 2);
      for (let i = 0; i < HDR.bloomLevels; i++) {
        down.push(target(w, h, THREE.HalfFloatType));
        up.push(target(w, h, THREE.HalfFloatType));
        if (w <= 8 || h <= 8) break;
        w = Math.max(1, w >> 1);
        h = Math.max(1, h >> 1);
      }
    }

    if (wantNebula) {
      nebulaRT = target(
        Math.max(1, Math.round(width * NEBULA.resolution)),
        Math.max(1, Math.round(height * NEBULA.resolution)),
        THREE.HalfFloatType
      );
    }

    resolveMat.uniforms.uTaps.value = Math.min(4, Math.max(1, Math.ceil(effectiveScale - 1e-6)));
    resolveMat.uniforms.uKaris.value = wantHdr ? 1 : 0;
  }

  function bloom(source, width, height) {
    let src = source;
    let sw = width;
    let sh = height;
    for (let i = 0; i < down.length; i++) {
      const mat = i === 0 ? prefilterMat : downMat;
      mat.uniforms.tSrc.value = src.texture;
      mat.uniforms.uTexel.value.set(1 / sw, 1 / sh);
      draw(mat, down[i]);
      src = down[i];
      sw = down[i].width;
      sh = down[i].height;
    }
    let low = down[down.length - 1];
    for (let i = down.length - 2; i >= 0; i--) {
      upMat.uniforms.tLow.value = low.texture;
      upMat.uniforms.tHigh.value = down[i].texture;
      upMat.uniforms.uTexel.value.set(1 / low.width, 1 / low.height);
      draw(upMat, up[i]);
      low = up[i];
    }
    return low;
  }

  /**
   * `nebulaScene` is drawn first, underneath everything, and only when the
   * nebula switch is on.
   */
  function render(scene, camera, nebulaScene) {
    const into = sceneRT;
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;

    if (config.nebula && nebulaScene) {
      renderer.setRenderTarget(nebulaRT);
      renderer.clear(true, false, false);
      renderer.render(nebulaScene, camera);
    }

    renderer.setRenderTarget(into);
    renderer.clear(true, true, false);

    if (config.nebula && nebulaScene) {
      nebulaMat.uniforms.tNebula.value = nebulaRT.texture;
      nebulaMat.uniforms.uTexel.value.set(1 / nebulaRT.width, 1 / nebulaRT.height);
      draw(nebulaMat, into);
    }

    renderer.setRenderTarget(into);
    renderer.render(scene, camera);

    if (into) {
      let display = into;
      const needsResolve = into.width !== config.width || into.height !== config.height;
      if (needsResolve) {
        resolveMat.uniforms.tSrc.value = into.texture;
        resolveMat.uniforms.uDstSize.value.set(config.width, config.height);
        if (config.hdr) {
          draw(resolveMat, resolveRT);
          display = resolveRT;
        }
      }

      if (config.hdr) {
        // With no bloom asked for, none of its passes are paid for either.
        const glow = compositeMat.uniforms.uBloom.value > 0
          ? bloom(display, config.width, config.height).texture
          : noBloom;
        compositeMat.uniforms.tScene.value = display.texture;
        compositeMat.uniforms.tBloom.value = glow;
        renderer.setRenderTarget(null);
        renderer.clear(true, true, false);
        draw(compositeMat, null);
      } else {
        // Without HDR the scene target only exists because it is scaled.
        renderer.setRenderTarget(null);
        renderer.clear(true, true, false);
        draw(resolveMat, null);
      }
    }

    renderer.autoClear = prevAutoClear;
  }

  return {
    configure,
    render,
    get scale() { return effectiveScale; },
    get hdr() { return config.hdr; },
    get nebula() { return config.nebula; },
    /** Device pixels the scene itself is drawn at. */
    get sceneHeight() { return sceneRT ? sceneRT.height : config.height; },
    floatOk,
    /** Live tuning, for A/B work in the console. */
    uniforms: {
      exposure: compositeMat.uniforms.uExposure,
      bloom: compositeMat.uniforms.uBloom,
      threshold: prefilterMat.uniforms.uThreshold,
      knee: prefilterMat.uniforms.uKnee,
      scatter: upMat.uniforms.uScatter,
      nebulaGain: nebulaMat.uniforms.uGain,
      nebulaKnee: nebulaMat.uniforms.uKnee,
      nebulaToe: nebulaMat.uniforms.uToe,
    },
  };
}
