import {
  T_PULLOUT, R_END, FOV_NEAR, FOV_FAR,
  LON_START, LAT_SWEEP, LAT_END, MW_FADE_END, DEG, CAMERA,
} from './constants.js';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a || 1e-9), 0, 1);
  return t * t * (3 - 2 * t);
};

/**
 * One exact step of a critically damped spring towards `target`. Exact rather
 * than integrated, so the same sequence of timesteps always lands in the same
 * place, which is what frame-accurate capture depends on. Starting from rest
 * it eases in, and it always eases out: every stop is a deceleration.
 */
function spring(x, v, target, omega, dt) {
  const d = x - target;
  const k = v + omega * d;
  const e = Math.exp(-omega * dt);
  return [target + (d + k * dt) * e, (v - omega * k * dt) * e];
}

/**
 * Continuing the circuit's motion into the pull-out. Position and direction are
 * continuous at the handover by construction, but the *rates* would not be: the
 * circuit is turning at 360 degrees per 0.35 of t and the latitude sweep is at
 * the steepest part of its sine, and both would stop dead. So the pull-out
 * inherits those rates and lets them decay, which is the difference between
 * arriving somewhere and being cut there.
 *
 * DECAY and SETTLE are chosen so the derivatives match at v = 0; COAST is a
 * steady slow turn underneath, so the camera is still moving at the end.
 */
const SWING = 42; // degrees of longitude in the decaying part
const DECAY = 0.0668; // its decay constant, in v
const COAST = 40; // degrees of steady longitude drift across the pull-out
const SETTLE = 0.030; // latitude decay constant, in v
/** Radians per second of idle orbit once the journey has arrived. */
const IDLE_ORBIT = 0.9;

const KEY_RATE = 0.08; // t per second while a key is held
const WHEEL_RATE = 1 / 2600; // t per pixel of wheel travel
const DRAG_RATE = 0.14; // degrees per pixel
const TOUCH_T_RATE = 1 / 620; // t per pixel of two-finger travel
const PINCH_RATE = 1 / 900;

/**
 * The whole camera is one formula:
 *
 *     position = -viewDir * R(t)
 *     look at   position + viewDir
 *
 * At R = 0 that is a first-person look-around standing at the origin. At R > 0
 * it is an orbit around the origin looking back at it. There is no second mode
 * and nothing to cross-fade: the camera pulls out backwards along whatever
 * direction it was already facing, so the handover cannot be felt because
 * there is no handover.
 *
 * Over the first third, t drives the heading right around the sky. Longitude
 * sweeps a full circuit while the view latitude rides a sine, so the bare
 * stripe starts across the middle of the frame, drifts out of shot, sweeps
 * back through the middle at the halfway point, drifts out the other side and
 * returns to centre exactly as the pull-out begins. Drag adds an offset on top
 * of that base heading rather than replacing it, so looking around by hand
 * still works and t still means how far through the journey you are.
 */
export function createJourney(canvas, camera) {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const state = {
    t: 0,
    target: 0,
    /** Rate of change of t, for the spring. */
    velocity: 0,
    dragLon: 0,
    dragLat: 0,
    idle: 0,
    reduced,
    /**
     * With `eased` on, t and the drag both settle on springs, and the camera
     * drifts on its own clock. Off, they behave as they always have.
     */
    eased: false,
    /** Seconds of drift, advanced by step() and reset by setT(). */
    clock: 0,
  };

  // Where the hand has put the view; the spring carries dragLon/Lat after it.
  const drag = { lon: 0, lat: 0, vLon: 0, vLat: 0 };

  // ---- input ------------------------------------------------------------

  const keys = new Set();
  const pointers = new Map();
  let lastCentroid = null;
  let lastSpread = 0;

  const nudge = (d) => { state.target = clamp(state.target + d, 0, 1); };

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 800 : 1;
    nudge(e.deltaY * scale * WHEEL_RATE);
  }, { passive: false });

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    lastCentroid = null;
    lastSpread = 0;
  });

  const release = (e) => {
    pointers.delete(e.pointerId);
    lastCentroid = null;
    lastSpread = 0;
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);

  canvas.addEventListener('pointermove', (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size === 1) {
      // One finger, or the mouse: look around, or orbit once we are outside.
      drag.lon -= (e.clientX - prev.x) * DRAG_RATE;
      drag.lat += (e.clientY - prev.y) * DRAG_RATE;
      return;
    }

    if (pointers.size === 2) {
      // Two fingers: drag up or spread to advance.
      const [a, b] = [...pointers.values()];
      const cy = (a.y + b.y) / 2;
      const spread = Math.hypot(a.x - b.x, a.y - b.y);
      if (lastCentroid !== null) {
        nudge(-(cy - lastCentroid) * TOUCH_T_RATE);
        nudge((spread - lastSpread) * PINCH_RATE);
      }
      lastCentroid = cy;
      lastSpread = spread;
    }
  });

  window.addEventListener('keydown', (e) => {
    const k = e.key;
    if (k === ' ' || k === 'Spacebar' || k.startsWith('Arrow')) {
      e.preventDefault();
      keys.add(k === 'Spacebar' ? ' ' : k);
    }
  });
  window.addEventListener('keyup', (e) => {
    keys.delete(e.key === 'Spacebar' ? ' ' : e.key);
  });
  window.addEventListener('blur', () => keys.clear());

  function readKeys(dt, shift) {
    let d = 0;
    if (keys.has(' ')) d += shift ? -1 : 1;
    if (keys.has('ArrowRight') || keys.has('ArrowUp')) d += 1;
    if (keys.has('ArrowLeft') || keys.has('ArrowDown')) d -= 1;
    if (d) nudge(d * KEY_RATE * dt);
  }

  let shiftHeld = false;
  window.addEventListener('keydown', (e) => { shiftHeld = e.shiftKey; });
  window.addEventListener('keyup', (e) => { shiftHeld = e.shiftKey; });

  // ---- derivation -------------------------------------------------------

  /** Base heading in galactic degrees for a given t. */
  function heading(t) {
    const u = clamp(t / T_PULLOUT, 0, 1);
    let lon = LON_START + 360 * u;
    let lat = LAT_SWEEP * Math.sin(2 * Math.PI * u);
    if (t > T_PULLOUT) {
      const v = (t - T_PULLOUT) / (1 - T_PULLOUT);
      lon = LON_START + 360 + SWING * (1 - Math.exp(-v / DECAY)) + COAST * v;
      lat = LAT_END * (1 - Math.exp(-v / SETTLE));
    }
    return { lon, lat };
  }

  /**
   * Orbit radius. It has to creep for the first moment, so that leaving the
   * Milky Way behind is something you watch happen rather than a cut, and then
   * open out fast enough that the wedge has resolved into three dimensions by
   * halfway. One power curve cannot do both, so two are blended.
   */
  function radius(t) {
    if (t <= T_PULLOUT) return 0;
    const v = (t - T_PULLOUT) / (1 - T_PULLOUT);
    const w = smoothstep(0.10, 0.55, v);
    return R_END * ((1 - w) * Math.pow(v, 2.1) + w * v);
  }

  /**
   * The drift: three slow sines on periods that never line up. Out in the
   * orbit it is a translation, a couple of megaparsecs at most, which is what
   * makes near galaxies slide over far ones. At the origin a translation would
   * move the viewer off the point the mask's sheets are built to be seen
   * edge-on from, and there is nothing near enough to slide anyway, so there
   * it is a fraction of a degree of sway instead. One hands over to the other
   * as the camera leaves.
   */
  function drift(r) {
    const [p1, p2, p3] = CAMERA.periods;
    const c = state.clock;
    const a = Math.sin((2 * Math.PI * c) / p1 + 0.7);
    const b = Math.sin((2 * Math.PI * c) / p2 + 2.1);
    const e = Math.sin((2 * Math.PI * c) / p3 + 4.0);
    const sway = CAMERA.swayDeg * (1 - smoothstep(0, 6, r));
    const amp = CAMERA.drift * r;
    return { lon: sway * a, lat: sway * 0.6 * b, right: amp * b, up: amp * 0.6 * a, back: amp * 0.5 * e };
  }

  function apply(dt) {
    const { t } = state;
    const base = heading(t);

    if (!state.reduced) state.idle += dt * IDLE_ORBIT * smoothstep(0.9, 1.0, t);

    // Absorb any overshoot back into the drag offset instead of merely
    // clamping the result, so dragging past the pole and back does not leave a
    // dead zone where the view refuses to move.
    const wanted = base.lat + drag.lat;
    const held = clamp(wanted, -85, 85);
    drag.lat -= wanted - held;
    if (!state.eased) {
      state.dragLon = drag.lon;
      state.dragLat = drag.lat;
    }

    const r = radius(t);
    const moving = state.eased && !state.reduced;
    const d = moving ? drift(r) : null;

    const lon = (base.lon + state.dragLon + state.idle + (d ? d.lon : 0)) * DEG;
    const lat = clamp(base.lat + state.dragLat + (d ? d.lat : 0), -85, 85) * DEG;

    const cb = Math.cos(lat);
    // Render frame: X towards l = 0, Y galactic north, Z = -y.
    const dx = cb * Math.cos(lon);
    const dy = Math.sin(lat);
    const dz = -cb * Math.sin(lon);

    camera.position.set(-dx * r, -dy * r, -dz * r);
    if (d && r > 0) {
      // Right and up relative to the view, with galactic north as up.
      const rl = Math.hypot(dz, dx) || 1;
      const rx = -dz / rl, rz = dx / rl;
      const ux = -dy * rz, uy = dx * rz - dz * rx, uz = dy * rx;
      camera.position.x += rx * d.right + ux * d.up - dx * d.back;
      camera.position.y += uy * d.up - dy * d.back;
      camera.position.z += rz * d.right + uz * d.up - dz * d.back;
    }
    camera.lookAt(
      camera.position.x + dx,
      camera.position.y + dy,
      camera.position.z + dz
    );

    const fov = FOV_NEAR + (FOV_FAR - FOV_NEAR) * smoothstep(0.30, 0.95, t);
    if (Math.abs(camera.fov - fov) > 1e-4) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }

    return {
      t,
      radius: r,
      /** The obstruction is a property of standing inside the Milky Way. */
      mwOpacity: 1 - smoothstep(0.2, MW_FADE_END, r),
    };
  }

  return {
    state,
    step(dt) {
      readKeys(dt, shiftHeld);
      if (state.eased) {
        [state.t, state.velocity] = spring(state.t, state.velocity, state.target, CAMERA.spring, dt);
        if (state.t < 0 || state.t > 1) {
          state.t = clamp(state.t, 0, 1);
          state.velocity = 0;
        }
        if (Math.abs(state.target - state.t) < 1e-5 && Math.abs(state.velocity) < 1e-4) {
          state.t = state.target;
          state.velocity = 0;
        }
        [state.dragLon, drag.vLon] = spring(state.dragLon, drag.vLon, drag.lon, CAMERA.dragSpring, dt);
        [state.dragLat, drag.vLat] = spring(state.dragLat, drag.vLat, drag.lat, CAMERA.dragSpring, dt);
        if (!state.reduced) state.clock += dt;
      } else {
        // Ease towards the target so scroll, keys and touch all feel filmable.
        state.t += (state.target - state.t) * (1 - Math.exp(-dt * 5));
        if (Math.abs(state.target - state.t) < 1e-5) state.t = state.target;
        state.velocity = 0;
      }
      return apply(dt);
    },
    setT(v) {
      state.target = clamp(v, 0, 1);
      state.t = state.target;
      state.velocity = 0;
      state.idle = 0;
      state.clock = 0;
      state.dragLon = drag.lon;
      state.dragLat = drag.lat;
      drag.vLon = drag.vLat = 0;
      return apply(0);
    },
    setEased(on) {
      state.eased = Boolean(on);
      if (!state.eased) state.velocity = 0;
    },
  };
}
