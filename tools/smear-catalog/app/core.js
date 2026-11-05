// Motion engine core: the reusable part of every scene. A scene is a pure function of the frame
// number; this file gives it easing, tweens, springs, seeded randomness, hand-drawn strokes, smooth
// text, grain and camera zoom keys. Loaded before scene.js; exposes window.MotionCore.
(function () {
  // ---------- easing ----------
  // CSS cubic-bezier as a function of progress 0…1.
  function bezier(x1, y1, x2, y2) {
    const b = (t, a, c) => 3 * a * t * (1 - t) ** 2 + 3 * c * t * t * (1 - t) + t ** 3;
    return (x) => {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      let lo = 0, hi = 1;
      for (let i = 0; i < 30; i++) {
        const mid = (lo + hi) / 2;
        if (b(mid, x1, x2) < x) lo = mid; else hi = mid;
      }
      return b((lo + hi) / 2, y1, y2);
    };
  }
  // Curve tokens.
  const E = {
    out: bezier(.16, 1, .3, 1),          // entrances: already moving, brakes into place
    exit: bezier(.55, .055, .675, .19),  // exits: accelerates out, never brakes in view
    contact: bezier(.55, 0, .9, .55),    // acceleration into an impact
    smooth: bezier(.65, 0, .35, 1),      // crouches, slow pushes, drift
    cam: bezier(.48, .1, 0, .9),         // camera moves
    ui: bezier(.4, 0, .2, 1),            // small UI, marker wipes, presses
    move: bezier(.55, 0, .25, 1),        // in-scene moves (objects and camera): quick start, long brake
    launch: bezier(.2, .75, .35, 1),     // entries over long distances: arrive at speed, softer than out
    linear: (x) => Math.min(1, Math.max(0, x)),
  };
  const clamp01 = (x) => Math.min(1, Math.max(0, x));
  const lerp = (a, b, t) => a + (b - a) * t;

  // One acceleration for every in-scene move: duration depends on distance only,
  // frames = √(distance × MOVE_K / acc), acc in px/f².
  const MOVE_K = (() => { // E.move's peak acceleration for a unit move over a unit time
    let m = 0; const h = 1 / 2000;
    for (let x = h; x < 1; x += h) m = Math.max(m, (E.move(x + h) - 2 * E.move(x) + E.move(x - h)) / (h * h));
    return m;
  })();
  const moveFrames = (dist, acc) => Math.round(Math.sqrt(Math.abs(dist) * MOVE_K / acc));
  // Value of a tween from a to b between frames f0 and f1.
  const tw = (f, f0, f1, a, b, ease = E.linear) => lerp(a, b, ease(clamp01((f - f0) / (f1 - f0))));

  // Damped spring step response 0 → 1, simulated at 600 Hz (damping / stiffness / mass).
  const SPRINGS = { snap: [18, 260, 0.7], soft: [26, 120, 1], heavy: [30, 90, 1.4], calm: [16, 64, 1] };
  function makeSpring(fps) {
    return function spring(name, frames) {
      if (frames <= 0) return 0;
      const [c, k, m] = SPRINGS[name];
      let x = 0, v = 0;
      const dt = 1 / 600, steps = Math.round(frames / fps / dt);
      for (let i = 0; i < steps; i++) {
        v += ((k * (1 - x) - c * v) / m) * dt;
        x += v * dt;
      }
      return x;
    };
  }

  // Seeded random: the same frame always draws the same thing (needed for review and export).
  function rng(seed) {
    return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  }

  // ---------- hand-drawn shapes ----------
  // Absolute M / L / C / Z paths only.
  function parsePath(d) {
    const out = [];
    const re = /([MLCZ])([^MLCZ]*)/gi;
    let m;
    while ((m = re.exec(d))) {
      const nums = (m[2].match(/-?[\d.]+(?:e-?\d+)?/gi) || []).map(Number);
      out.push({ cmd: m[1].toUpperCase(), nums });
    }
    return out;
  }
  // Path2D of an SVG path {d, w, h} fitted into rect {x, y, w, h}; with amp > 0 every point is
  // jittered by ±amp px — `variant` picks one of the repeatable jitters (for a boil, cycle 0, 1, 2).
  function boiledPath(src, variant, rect, amp) {
    const r = rng(1000 + variant * 7919);
    const sx = rect.w / src.w, sy = rect.h / src.h;
    const p = new Path2D();
    for (const { cmd, nums } of parsePath(src.d)) {
      const pts = [];
      for (let i = 0; i < nums.length; i += 2) {
        const jx = amp ? (r() * 2 - 1) * amp : 0;
        const jy = amp ? (r() * 2 - 1) * amp : 0;
        pts.push(rect.x + nums[i] * sx + jx, rect.y + nums[i + 1] * sy + jy);
      }
      if (cmd === 'M') p.moveTo(pts[0], pts[1]);
      else if (cmd === 'L') for (let i = 0; i < pts.length; i += 2) p.lineTo(pts[i], pts[i + 1]);
      else if (cmd === 'C') for (let i = 0; i < pts.length; i += 6) p.bezierCurveTo(...pts.slice(i, i + 6));
      else if (cmd === 'Z') p.closePath();
    }
    return p;
  }
  // A brush stroke with pointed ends, widest (w px) a little before the middle. Uses ctx.fillStyle.
  function brushStroke(ctx, x0, y0, x1, y1, w) {
    const len = Math.hypot(x1 - x0, y1 - y0), nx = -(y1 - y0) / len * w / 2, ny = (x1 - x0) / len * w / 2;
    const mx = lerp(x0, x1, 0.4), my = lerp(y0, y1, 0.4);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.quadraticCurveTo(mx + nx * 2, my + ny * 2, x1, y1);
    ctx.quadraticCurveTo(mx - nx * 2, my - ny * 2, x0, y0);
    ctx.fill();
  }

  // ---------- smooth text ----------
  // fillText snaps glyphs to the pixel grid, so still text twitches by a pixel during a slow zoom.
  // Words are rasterised once at 2× and drawn as images, which resample smoothly.
  // setFont(ctx) sets font + letterSpacing; size = font size in px; colour = fill.
  function makeWordCache(setFont, size, colour) {
    const cache = new Map(), PAD = 40;
    function image(word) {
      if (cache.has(word)) return cache.get(word);
      const c = document.createElement('canvas');
      const g = c.getContext('2d');
      setFont(g);
      c.width = Math.ceil((g.measureText(word).width + PAD * 2) * 2);
      c.height = Math.ceil(size * 1.6 * 2);
      g.scale(2, 2);
      setFont(g);
      g.fillStyle = colour;
      g.textBaseline = 'middle';
      g.textAlign = 'left';
      g.fillText(word, PAD, c.height / 4);
      cache.set(word, c);
      return c;
    }
    // x = left edge of the word, y = its vertical middle.
    function draw(ctx, word, x, y, alpha = 1) {
      if (alpha <= 0) return;
      const img = image(word);
      ctx.globalAlpha = alpha;
      ctx.drawImage(img, x - PAD, y - img.height / 4, img.width / 2, img.height / 2);
      ctx.globalAlpha = 1;
    }
    return { image, draw };
  }

  // ---------- grain ----------
  // 4 noise tiles, a new one every `every` frames with a random offset; overlay at `amount`.
  function makeGrain(W, H, { amount = 0.1, size = 1.5, every = 2 } = {}) {
    let patterns = null;
    function tiles(ctx) {
      return [0, 1, 2, 3].map((k) => {
        const c = document.createElement('canvas');
        c.width = c.height = 256;
        const g = c.getContext('2d');
        const img = g.createImageData(256, 256);
        const r = rng(77 + k * 131);
        for (let i = 0; i < img.data.length; i += 4) {
          const v = 128 + (r() + r() + r() - 1.5) * 120;
          img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
          img.data[i + 3] = 255;
        }
        g.putImageData(img, 0, 0);
        return ctx.createPattern(c, 'repeat');
      });
    }
    return function drawGrain(ctx, f, amt = amount) {
      if (amt <= 0) return;
      patterns = patterns || tiles(ctx);
      const step = Math.floor(f / every), r = rng(step * 9973 + 1);
      ctx.save();
      ctx.globalCompositeOperation = 'overlay';
      ctx.globalAlpha = amt;
      ctx.translate(-r() * 256, -r() * 256);
      ctx.scale(size, size);
      ctx.fillStyle = patterns[step % 4];
      ctx.fillRect(0, 0, W / size + 256, H / size + 256);
      ctx.restore();
    };
  }

  // ---------- camera ----------
  // Zoom as a chain of keys [frame, value, ease-into-this-key]. The camera should never float:
  // on still shots every segment is a slow push in or pull out.
  function zoomKeys(keys) {
    return function zoomAt(f) {
      for (let i = 1; i < keys.length; i++) {
        const [f1, z1, ease] = keys[i], [f0, z0] = keys[i - 1];
        if (f <= f1) return tw(f, f0, f1, z0, z1, ease || E.linear);
      }
      return keys[keys.length - 1][1];
    };
  }

  // ---------- assets ----------
  // assets = { fonts: [{family, url, weight}], images: {key: src} } → Promise<{key: Image}>
  async function loadAssets({ fonts = [], images = {} }) {
    for (const { family, url, weight } of fonts) {
      const ff = new FontFace(family, `url(${url})`, { weight: String(weight || 400) });
      document.fonts.add(await ff.load());
    }
    const out = {};
    await Promise.all(Object.entries(images).map(([k, src]) => new Promise((res) => {
      const im = new Image();
      im.onload = () => { out[k] = im; res(); };
      im.src = src;
    })));
    return out;
  }

  // Story safe zones (Instagram / TikTok): top 220 px, bottom 250 px at 1080 × 1920.
  function drawSafeZones(ctx, W, H, top = 220, bottom = 250) {
    ctx.save();
    ctx.fillStyle = 'rgba(255, 0, 90, 0.10)';
    ctx.fillRect(0, 0, W, top);
    ctx.fillRect(0, H - bottom, W, bottom);
    ctx.restore();
  }

  window.MotionCore = {
    bezier, E, clamp01, lerp, tw, moveFrames, makeSpring, rng, parsePath, boiledPath, brushStroke,
    makeWordCache, makeGrain, zoomKeys, loadAssets, drawSafeZones,
  };
})();
