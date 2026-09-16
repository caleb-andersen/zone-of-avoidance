import * as THREE from 'three';
import './style.css';
import { GREAT_ATTRACTOR, MASK_IN, R_END } from './constants.js';
import { loadCatalogue, dirFromLB } from './data.js';
import { synthesizeDeficit } from './synthesize.js';
import { makeGalaxyCloud, makeEstimateCloud, makeAttractor } from './clouds.js';
import { makeMilkyWay } from './milkyway.js';
import { loadMask, makeMask } from './mask.js';
import { createJourney } from './journey.js';
import { captionsFor, mountCaptions } from './captions.js';
import { makeRng } from './rng.js';

/**
 * Every material here writes gl_FragColor directly, so none of three's output
 * colour-space encoding is injected. Left on, colour management would convert
 * each hex to linear on the way in and nothing would convert it back, and the
 * palette would render several shades darker and more saturated than it was
 * written. Turning it off makes the hex values mean what they say.
 */
THREE.ColorManagement.enabled = false;

const canvas = document.getElementById('stage');
const statusEl = document.getElementById('status');
const titleEl = document.getElementById('title');
const captionsEl = document.getElementById('captions');
const progressEl = document.getElementById('progress-fill');

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a || 1e-9)));
  return t * t * (3 - 2 * t);
};

/** Phones get a smaller foreground field; it is the only thing that scales. */
function foregroundCount() {
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const small = Math.min(window.innerWidth, window.innerHeight) < 620;
  if (coarse || small) return 70000;
  return navigator.hardwareConcurrency >= 8 ? 210000 : 140000;
}

function fail(message) {
  statusEl.className = 'failed';
  statusEl.textContent = message;
  statusEl.removeAttribute('hidden');
}

async function start() {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: false,
    powerPreference: 'high-performance',
  });
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.setClearAlpha(0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(68, 1, 0.02, R_END * 4);

  const [cat, maskContour] = await Promise.all([loadCatalogue(), loadMask()]);
  const rng = makeRng(0x9a11c3);

  const estimates = synthesizeDeficit(cat, rng);

  const galaxies = makeGalaxyCloud(cat);
  const estimateCloud = makeEstimateCloud(estimates);

  const gaDir = dirFromLB(GREAT_ATTRACTOR.l, GREAT_ATTRACTOR.b);
  const attractor = makeAttractor(gaDir.map((v) => v * GREAT_ATTRACTOR.distance));

  const milkyWay = makeMilkyWay(foregroundCount(), rng);
  const mask = makeMask(maskContour);

  scene.add(galaxies, estimateCloud, attractor, mask.group, milkyWay.group);

  const journey = createJourney(canvas, camera);
  const updateCaptions = mountCaptions(captionsEl, captionsFor(cat.count));

  let pixelRatio = 1;
  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    galaxies.material.uniforms.uPixelRatio.value = pixelRatio;
    estimateCloud.material.uniforms.uPixelRatio.value = pixelRatio;
    attractor.material.uniforms.uPixelRatio.value = pixelRatio;
    milkyWay.setPixelRatio(pixelRatio);
  }
  window.addEventListener('resize', resize);
  resize();

  let lastTitle = -1;
  let lastProgress = -1;

  function applyFrame(frame) {
    const { t, radius, mwOpacity } = frame;

    // The shell follows the camera's position but never its rotation, so the
    // band stays fixed on the sky while the viewer turns.
    milkyWay.group.position.copy(camera.position);
    milkyWay.setOpacity(mwOpacity);

    // Keep point sizes sane as the camera retreats, and pull brightness back
    // as it does: the catalogue is flux limited, so the number density is
    // genuinely higher near us, and from outside the whole core would otherwise
    // burn out into a white blob.
    const ref = 60 + 0.55 * radius;
    galaxies.material.uniforms.uRefDist.value = ref;
    estimateCloud.material.uniforms.uRefDist.value = ref;
    // The minimum point size is a floor in screen pixels, so from far out every
    // one of tens of thousands of galaxies would claim its few pixels and the
    // core would clip to white. The floor has to come down as the camera goes.
    const zoom = smoothstep(40, R_END, radius);
    galaxies.material.uniforms.uMinPx.value = 3.1 - 2.05 * zoom;
    estimateCloud.material.uniforms.uMinPx.value = 5.0 - 1.7 * zoom;
    const crowding = 1 - 0.44 * zoom;
    galaxies.material.uniforms.uOpacity.value = crowding;
    galaxies.material.uniforms.uSizeScale.value = 31 - 9 * zoom;

    // The mask is named before it is filled: the outline arrives under the
    // caption about the Zone of Avoidance, and eases back once the estimates
    // are inside it and are the thing to be looking at.
    mask.setOpacity(
      smoothstep(MASK_IN[0], MASK_IN[1], t) * (1 - 0.22 * smoothstep(0.60, 0.74, t))
    );

    estimateCloud.material.uniforms.uOpacity.value = smoothstep(0.615, 0.70, t);
    attractor.material.uniforms.uOpacity.value = smoothstep(0.835, 0.90, t);

    updateCaptions(t);

    const titleAlpha = 1 - smoothstep(0.004, 0.035, t);
    if (Math.abs(titleAlpha - lastTitle) > 0.002) {
      titleEl.style.opacity = titleAlpha.toFixed(3);
      lastTitle = titleAlpha;
    }
    if (Math.abs(t - lastProgress) > 0.0008) {
      progressEl.style.transform = `scaleX(${t.toFixed(4)})`;
      lastProgress = t;
    }

    renderer.render(scene, camera);
  }

  // Deterministic seeking, for filming retakes and for capture. No UI.
  // Editing the hash is a same-page navigation, so it has to be listened for
  // as well as read at load, or a retake silently keeps the previous frame.
  function seekFromHash() {
    const hash = /t=([0-9]*\.?[0-9]+)/.exec(window.location.hash);
    if (hash) applyFrame(journey.setT(parseFloat(hash[1])));
  }
  window.addEventListener('hashchange', seekFromHash);
  seekFromHash();

  // Capture hook for filming: seek to an exact t, or advance by an exact
  // timestep for frame-accurate recording. Deliberately not wired to any UI.
  window.__zoa = {
    setT(v) { applyFrame(journey.setT(v)); return v; },
    getT: () => journey.state.t,
    step(dt) { applyFrame(journey.step(dt)); },
    counts: { observed: cat.count, estimated: estimates.count },
    mask: maskContour.measured,
  };

  statusEl.setAttribute('hidden', '');

  let last = performance.now();
  function loop(now) {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    applyFrame(journey.step(dt));
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

start().catch((err) => {
  console.error(err);
  fail(`Could not build the map. ${err.message}`);
});
