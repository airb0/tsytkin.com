// Speed effects that work on any object. The object is a sprite (anything drawn into a canvas — a
// shape, a word, an icon, a PNG); its motion is a pure function of the frame, at(f) → a pose
// {x, y, rot, stretch, axis}. Effects read the sprite's silhouette from its alpha and follow the pose's
// trajectory, so the same code runs on a ball or on a product shot, on a straight line or on an arc.
// Options are in seconds and px/s, so an effect looks the same at any frame rate: pass `fps` (60 by
// default) and inFrames() turns them into the frame units the code works in.
// Loaded after core.js; exposes window.MotionSmear.
(function () {
  const { rng, clamp01 } = window.MotionCore;
  // Defaults were tuned at 60 fps; they are written as the frames and px/f they were tuned in.
  const F = (n) => n / 60, V = (n) => n * 60;

  // ---------- units ----------
  // How each time-based option converts: speed — px/s → px/f · rate — per second → per frame ·
  // count — seconds → whole frames · time — seconds → frames (fractional: lengths of travel, decays).
  const UNITS = {
    threshold: 'speed', stretchSpeed: 'speed', squashSpeed: 'speed', minDrop: 'speed', wobble: 'rate',
    linger: 'count', redraw: 'count', every: 'count', life: 'count', recover: 'count',
    length: 'time', frames: 'time', span: 'time', cutLength: 'time', damping: 'time',
  };
  // Options in seconds → the same options in frames of o.fps. Marked, so passing them on converts nothing twice.
  function inFrames(o) {
    if (o.inFrames) return o;
    const fps = o.fps || 60, out = { ...o, fps, inFrames: true };
    for (const k in UNITS) {
      const v = o[k], u = UNITS[k];
      if (typeof v !== 'number') continue;
      if (u === 'speed' || u === 'rate') out[k] = v / fps;
      else if (u === 'count') out[k] = Math.max(k === 'redraw' || k === 'every' ? 1 : 0, Math.round(v * fps));
      else out[k] = v * fps;
    }
    return out;
  }
  // Defaults (in seconds) under options that may already be in frames.
  const withDefaults = (defaults, options) => ({ ...inFrames({ ...defaults, fps: options.fps }), ...inFrames(options) });

  // ---------- sprites ----------
  // draw(g) paints the object centred on 0, 0 inside w × h. Rasterised once at `res`×; the alpha is
  // kept so effects can find the silhouette's edges in any direction.
  function makeSprite(draw, w, h, { res = 2, pad = 10 } = {}) {
    const c = document.createElement('canvas');
    c.width = Math.ceil((w + pad * 2) * res);
    c.height = Math.ceil((h + pad * 2) * res);
    const g = c.getContext('2d');
    g.scale(res, res);
    g.translate(w / 2 + pad, h / 2 + pad);
    draw(g);
    const px = g.getImageData(0, 0, c.width, c.height).data, alpha = new Uint8Array(c.width * c.height);
    for (let i = 0; i < alpha.length; i++) alpha[i] = px[i * 4 + 3];
    return {
      canvas: c, w, h, pad, res, alpha, profiles: new Map(), colors: spriteColors(px, alpha, c.width, c.height, res), tints: new Map(),
      // Draws the sprite (or a same-size canvas made from it, e.g. a tint) centred on 0, 0.
      draw(ctx, img = c) { ctx.drawImage(img, -(w / 2 + pad), -(h / 2 + pad), w + pad * 2, h + pad * 2); },
      // The silhouette in one flat colour (cached).
      tint(color) {
        if (this.tints.has(color)) return this.tints.get(color);
        const t = document.createElement('canvas');
        t.width = c.width; t.height = c.height;
        const tg = t.getContext('2d');
        tg.drawImage(c, 0, 0);
        tg.globalCompositeOperation = 'source-in';
        tg.fillStyle = color;
        tg.fillRect(0, 0, t.width, t.height);
        this.tints.set(color, t);
        return t;
      },
      // Is the sprite opaque at (x, y) px from its centre?
      solid(x, y) {
        const i = Math.floor((x + w / 2 + pad) * res), j = Math.floor((y + h / 2 + pad) * res);
        return i >= 0 && j >= 0 && i < c.width && j < c.height && alpha[j * c.width + i] > 96;
      },
      // The colour at (x, y) px from its centre, 'rgb(…)', or null where the sprite is see-through.
      colorAt(x, y) {
        const i = Math.floor((x + w / 2 + pad) * res), j = Math.floor((y + h / 2 + pad) * res);
        if (i < 0 || j < 0 || i >= c.width || j >= c.height) return null;
        const k = j * c.width + i;
        return alpha[k] > 96 ? `rgb(${px[k * 4]},${px[k * 4 + 1]},${px[k * 4 + 2]})` : null;
      },
    };
  }
  // The object's own colours. `outline` — the darkest colour that covers at least 3 % of the object
  // (drawn objects: their line; a box whose fill spills past its lines still gets the black), `fill` —
  // the most common other colour. Binned at 4 bits per channel; each result is the mean of its bin.
  function spriteColors(px, alpha, cw, ch, res) {
    const bins = new Map(), step = Math.max(1, Math.round(res));
    let total = 0;
    for (let y = 0; y < ch; y += step) {
      for (let x = 0; x < cw; x += step) {
        const i = y * cw + x;
        if (alpha[i] < 200) continue;
        const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2], key = (r >> 4) << 8 | (g >> 4) << 4 | (b >> 4);
        const e = bins.get(key) || [0, 0, 0, 0];
        e[0] += r; e[1] += g; e[2] += b; e[3]++;
        bins.set(key, e);
        total++;
      }
    }
    const css = (e) => `rgb(${Math.round(e[0] / e[3])}, ${Math.round(e[1] / e[3])}, ${Math.round(e[2] / e[3])})`;
    const lum = (e) => (0.3 * e[0] + 0.59 * e[1] + 0.11 * e[2]) / e[3];
    const common = [...bins.values()].filter((e) => e[3] >= total * 0.03);
    if (!common.length) return { outline: '#111', fill: '#111', second: '#111', palette: ['#111'] };
    const outline = common.reduce((a, e) => (lum(e) < lum(a) ? e : a));
    const others = common.filter((e) => e !== outline).sort((a, b) => b[3] - a[3]);
    const fill = others[0] || outline;
    // `second` — the next most common colour (a shadow, a second fill); `palette` — all common colours.
    return { outline: css(outline), fill: css(fill), second: css(others[1] || fill), palette: common.sort((a, b) => b[3] - a[3]).map(css) };
  }
  // Mix two css rgb()/hex colours, t = 0 → a, 1 → b.
  function mixColor(a, b, t) {
    const parse = (c) => (c.startsWith('#')
      ? [1, 3, 5].map((i) => parseInt(c.length === 4 ? c[(i + 1) / 2].repeat(2) : c.slice(i, i + 2), 16))
      : c.match(/\d+/g).slice(0, 3).map(Number));
    const x = parse(a), y = parse(b);
    return `rgb(${x.map((v, i) => Math.round(v + (y[i] - v) * t)).join(', ')})`;
  }

  // An image (loaded <img>, canvas, bitmap) as a sprite `h` px tall, keeping its aspect.
  function imageSprite(img, h, opts) {
    const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height, w = h * iw / ih;
    return makeSprite((g) => g.drawImage(img, -w / 2, -h / 2, w, h), w, h, opts);
  }

  // Silhouette seen along direction `ang` (sprite-local, 2° buckets, cached): for every offset s across
  // the motion, where the shape starts at the back and ends at the front (px along the motion).
  function profile(sprite, ang) {
    const key = Math.round(ang / (Math.PI / 90));
    if (sprite.profiles.has(key)) return sprite.profiles.get(key);
    const a = key * Math.PI / 90, ux = Math.cos(a), uy = Math.sin(a), px = -uy, py = ux;
    const R = Math.hypot(sprite.w, sprite.h) / 2 + sprite.pad, rows = [];
    let front = 0;
    for (let s = -R; s <= R; s += 2) {
      let b = null, e = null;
      for (let t = -R; t <= R; t += 1.5) {
        if (sprite.solid(px * s + ux * t, py * s + uy * t)) { if (b === null) b = t; e = t; }
      }
      if (b !== null) { rows.push({ s, back: b, front: e }); front = Math.max(front, e); }
    }
    const p = { ux, uy, px, py, rows, front };
    sprite.profiles.set(key, p);
    return p;
  }

  // ---------- poses ----------
  // A pose is {x, y, rot} plus an optional stretch along a world axis: stretch > 1 elongates along
  // `axis` (radians), < 1 squashes; the cross axis gets 1 / stretch^volume (volume 1 keeps the area).
  // Optional `scale` shrinks or grows the whole object (copies, particles).
  function poseMatrix(q) {
    const m = new DOMMatrix().translateSelf(q.x, q.y), st = q.stretch || 1;
    if (st !== 1) {
      const a = (q.axis || 0) * 180 / Math.PI;
      m.rotateSelf(a).scaleSelf(st, Math.pow(st, -(q.volume ?? 1))).rotateSelf(-a);
    }
    m.rotateSelf((q.rot || 0) * 180 / Math.PI);
    return q.scale ? m.scaleSelf(q.scale) : m;
  }
  // img — the sprite's own canvas by default, or one of its tints.
  function drawSprite(ctx, sprite, q, alpha = 1, img) {
    if (q.flatten > 0 && !img) return drawFlattened(ctx, sprite, q, alpha);
    const m = poseMatrix(q);
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
    sprite.draw(ctx, img);
    ctx.restore();
  }

  // ---------- layers ----------
  // Offscreen canvases the size of ctx's canvas, with ctx's transform, for effects that composite (erase,
  // tint, accumulate). Several can be open at once; flush draws one back onto ctx and frees it.
  const pool = [];
  function openLayer(ctx) {
    const cw = ctx.canvas.width, ch = ctx.canvas.height;
    let c = pool.find((x) => !x.busy);
    if (!c) { c = document.createElement('canvas'); pool.push(c); }
    c.busy = true;
    if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
    const g = c.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    g.filter = 'none';
    g.clearRect(0, 0, cw, ch);
    g.setTransform(ctx.getTransform());
    return g;
  }
  function flushLayer(ctx, g, alpha = 1, op = 'source-over') {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha *= alpha;
    ctx.globalCompositeOperation = op;
    ctx.drawImage(g.canvas, 0, 0);
    ctx.restore();
    g.canvas.busy = false;
  }

  // The sprite redrawn so that sprite-local direction `phi` points to +x, at the sprite's resolution:
  // {canvas, R, res}; column x of the canvas is (x / res − R) px along phi from the centre. Effects slice it.
  const axisCanvases = [];
  function axisCanvas(sprite, phi, slot = 0) {
    const R = Math.ceil(Math.hypot(sprite.w, sprite.h) / 2 + sprite.pad), res = sprite.res, size = 2 * R * res;
    const c = axisCanvases[slot] || (axisCanvases[slot] = document.createElement('canvas'));
    if (c.width < size) c.width = c.height = size;
    const g = c.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, c.width, c.height);
    g.setTransform(res, 0, 0, res, R * res, R * res);
    g.rotate(-phi);
    sprite.draw(g);
    return { canvas: c, R, res, size };
  }

  // Pressed into a flat surface: the object is cut into thin slices across `flatAxis` (the direction
  // into the surface). Its front `flatten` share of length is pressed flat against the surface, which
  // stays where the front edge was; slices near the contact spread sideways (`bulge`), the back keeps its
  // shape. The flat face gets a line in the object's outline colour, so a drawn object stays closed.
  function drawFlattened(ctx, sprite, q, alpha = 1) {
    const phi = q.flatAxis - (q.rot || 0), prof = profile(sprite, phi);
    if (!prof.rows.length) return;
    const F = prof.front, B = Math.min(...prof.rows.map((r) => r.back)), L = F - B;
    // Of the total squash `a`, a part presses the front flat (cut at P), the rest squashes the whole body
    // towards the surface (k); the length becomes L·(1 − a) with the front still at F.
    const a = q.flatten, cut = 0.4 * a, P = F - cut * L, k = (1 - a) / (1 - cut), bulge = q.bulge ?? 1;
    const vol = Math.pow(k, -(q.volume ?? 1));
    const { canvas: flatCanvas, R, res, size } = axisCanvas(sprite, phi, 1); // the impact direction → +x
    const widen = (t) => vol * (1 + bulge * a * Math.exp(-Math.max(0, P - t) / (0.3 * L)));
    const place = (t) => F - (P - t) * k;
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.translate(q.x, q.y);
    ctx.rotate(q.flatAxis);
    const sw = 2;
    for (let t = -R; t < P; t += sw) {
      const w = Math.min(sw, P - t), c = widen(t);
      ctx.drawImage(flatCanvas, (t + R) * res, 0, w * res, size, place(t), -R * c, w * k + 0.6, 2 * R * c);
    }
    // The flat face: the chord at the cut, widened like the slices next to it.
    const at = prof.rows.filter((r) => r.back <= P && r.front >= P);
    if (at.length) {
      const c = widen(P), lw = Math.max(3, Math.min(sprite.w, sprite.h) * 0.025);
      ctx.strokeStyle = sprite.colors.outline; ctx.lineWidth = lw; ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(F - lw / 2, at[0].s * c);
      ctx.lineTo(F - lw / 2, at[at.length - 1].s * c);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ---------- motion helpers ----------
  // Animation «on Ns»: the pose is held for n frames (at 60 fps: 1 = smooth, 2 = on twos, 4 = 15 drawings a second).
  const held = (at, n) => (n <= 1 ? at : (f) => at(Math.floor(f / n) * n));
  const velocity = (at, f) => { const a = at(f - 1), b = at(f); return { x: b.x - a.x, y: b.y - a.y }; };

  // The speed an effect should react to on frame f: travel over the last held step, in px/f. With
  // `linger` > 0 the strongest of the last frames is kept, fading, so the effect dies out after a stop
  // instead of vanishing on the frame the object lands.
  function recentVelocity(at, f, step = 1, linger = 0) {
    let best = null;
    for (let j = 0; j <= linger; j++) {
      const a = at(f - j - step), b = at(f - j);
      const vx = (b.x - a.x) / step, vy = (b.y - a.y) / step, speed = Math.hypot(vx, vy);
      const weight = speed * (1 - j / (linger + 1));
      if (!best || weight > best.weight) best = { vx, vy, speed, weight, ago: j };
    }
    return best;
  }

  // ---------- squash & stretch ----------
  const SQUASH_STRETCH = {
    stretch: 0.35,          // max elongation along the motion (+35 %)
    stretchSpeed: V(300),   // px/s that would give +100 %
    squash: 0.3,            // max squash on an impact (−30 % along the lost speed)
    squashSpeed: V(60),     // px/s of speed lost in one frame that gives +100 % squash
    minDrop: V(6),          // px/s lost in one frame: smaller drops in speed are braking, not impacts
    recover: F(24),         // s the squash takes to settle
    wobble: V(0.45),        // rad/s of the settle oscillation (0 — no overshoot)
    damping: F(5),          // s for the oscillation to fall to 1/e
    volume: 1,          // 1 keeps the area; 0.5 is a softer 1/√s
    impact: 'flatten',  // flatten — press the side that hit flat on the surface · uniform — squash the whole shape
    bulge: 1,           // flatten: how much the slices next to the surface spread sideways
    surface: null,      // direction into the surface, radians (0 — a wall on the right, π/2 — the floor);
                        // null — along the speed that was lost
  };
  // Wraps a motion so its pose stretches along the velocity and squashes on impacts (a sudden loss of
  // speed), settling with a small wobble. The squash keeps the leading edge in place (the side that hit).
  // With impact: 'flatten' the side that hit is pressed flat instead (drawSprite draws it); the wobble's
  // rebound past the rest shape stays a uniform stretch. A pose that comes with its own stretch (an
  // anticipation squash drawn into the motion) keeps it, times the stretch from speed.
  function squashStretch(at, sprite, options = {}) {
    const o = inFrames({ ...SQUASH_STRETCH, ...options });
    return (f) => {
      const q = at(f), v = velocity(at, f), speed = Math.hypot(v.x, v.y);
      let stretch = (q.stretch || 1) * (1 + Math.min(o.stretch, speed / o.stretchSpeed)), axis = speed > 0.01 ? Math.atan2(v.y, v.x) : q.axis || 0;
      // The strongest impact in the last `recover` frames: speed lost from one frame to the next.
      let hit = null;
      for (let j = 0; j < o.recover; j++) {
        const a = velocity(at, f - j - 1), b = velocity(at, f - j);
        const drop = Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y);
        if (drop > o.minDrop && (!hit || drop > hit.drop)) hit = { drop, j, axis: o.surface ?? Math.atan2(a.y - b.y, a.x - b.x) };
      }
      let x = q.x, y = q.y;
      if (hit) {
        // On Ns (o.step) the settle starts on the first drawing after the hit, so that drawing is the squash.
        const amount = Math.min(o.squash, hit.drop / o.squashSpeed), j = Math.max(0, hit.j - (o.step || 1) + 1);
        const s = 1 - amount * Math.exp(-j / o.damping) * Math.cos(j * o.wobble);
        // Pressed against the surface: flatten the side that hit (the front stays put by itself).
        if (o.impact === 'flatten' && s < 1 && speed <= o.minDrop) {
          return { ...q, stretch: 1, flatten: 1 - s, flatAxis: hit.axis, bulge: o.bulge, volume: o.volume };
        }
        stretch = speed > o.minDrop ? stretch * s : s;
        axis = hit.axis;
        // Keep the side that hit where it is: shift the centre towards it.
        const half = profile(sprite, hit.axis - (q.rot || 0)).front;
        x += Math.cos(hit.axis) * half * (1 - s);
        y += Math.sin(hit.axis) * half * (1 - s);
      }
      return { ...q, x, y, stretch, axis, volume: o.volume };
    };
  }

  // ---------- speed lines ----------
  // Defaults follow the reference (rikognition, «Speedlines»): many thin pointed strokes in the object's
  // line colour, some tinted with its fill, starting deep inside the body and drawn over it.
  const SPEED_LINES = {
    style: 'brush',    // brush — pointed strokes · thin — even lines · bars — flat, translucent
    count: 14,         // lines across the silhouette
    length: F(8),      // line length in seconds of travel (speed × length)
    maxLength: 900,    // px
    width: 2.5,        // px (brush: at the widest)
    threshold: V(8),   // px/s: below it there are no lines; full strength at twice this
    linger: F(6),      // s the lines keep shrinking after the object slows or stops
    redraw: F(2),      // s between new drawings of the lines (they wander, flicker)
    gap: 0,            // px between the silhouette's back edge and where a line starts
    inset: 120,        // px: lines start up to this far inside the silhouette (draw them over the object)
    spread: 0.95,      // share of the silhouette's height the lines cover
    across: 'even',    // even — spread over it evenly · gauss / laplace — gathered around the middle
    acrossSpread: 0.25, // σ of that gathering, share of the height
    jitter: 0.8,       // randomness of the line positions across (0 — evenly spaced)
    color: 'outline',  // 'outline' — the object's own line colour; or any css colour
    mix: 0.25,         // each line blends up to this far towards the object's fill colour
    opacity: 1,
    seed: 1,
  };

  // The trajectory behind the object, walked back in time and measured in px along the path: points
  // with the direction of travel at each. Still frames add nothing, so after a stop the lines start
  // where the object stopped and run back along the way it came. The track ends where the object stood
  // still before this move (a frame or more): a loop's previous move is not part of this one's smear.
  function trackBack(path, t0, maxLen, ux, uy) {
    const pts = [];
    let prev = path(t0), dist = 0, still = 0;
    pts.push({ x: prev.x, y: prev.y, ux, uy, dist });
    for (let i = 1; i <= 360 && dist < maxLen; i++) {
      const q = path(t0 - i * 0.5), d = Math.hypot(prev.x - q.x, prev.y - q.y);
      if (d > 1e-3) {
        if (dist > 0 && still >= 2) break;
        // Fast moves cover a lot in half a frame: sample finer, so an arc stays an arc, not a polyline
        // whose corners fan the slices and lines apart.
        const n = Math.min(32, Math.ceil(d / 6));
        for (let k = 1; k <= n; k++) {
          const r = k === n ? q : path(t0 - (i - 1) * 0.5 - k * 0.5 / n), sx = prev.x - r.x, sy = prev.y - r.y, sd = Math.hypot(sx, sy);
          if (sd > 1e-3) {
            // A turn back (the end of a swing) also ends the move: the smear does not fold onto itself.
            if (pts.length > 1 && (sx * ux + sy * uy) / sd < -0.2) return pts;
            ux = sx / sd; uy = sy / sd; dist += sd; pts.push({ x: r.x, y: r.y, ux, uy, dist });
          }
          prev = r;
        }
        still = 0;
      } else { still++; prev = q; }
    }
    return pts;
  }
  // A line `len` px long that runs parallel to the trajectory at a fixed offset from it: `side` px across
  // (left of travel is negative) and `along` px ahead of the centre (negative = behind it). `straight`:
  // where the track ends sooner (the object has just left its start), go on straight past its end.
  function followLine(track, side, along, len, straight = false) {
    const out = [];
    const last = track[track.length - 1];
    if (straight && len > last.dist) track = [...track, { x: last.x - last.ux * (len - last.dist), y: last.y - last.uy * (len - last.dist), ux: last.ux, uy: last.uy, dist: len }];
    for (let i = 0; i < track.length; i++) {
      const p = track[i];
      if (p.dist > len) {
        const a = track[i - 1], k = (len - a.dist) / (p.dist - a.dist);
        const x = a.x + (p.x - a.x) * k, y = a.y + (p.y - a.y) * k;
        out.push([x - p.uy * side + p.ux * along, y + p.ux * side + p.uy * along]);
        break;
      }
      out.push([p.x - p.uy * side + p.ux * along, p.y + p.ux * side + p.uy * along]);
    }
    return out;
  }
  // The point `d` px back along the track (negative — ahead of its start, along the first direction),
  // with the direction of travel there.
  function trackAt(track, d) {
    const p0 = track[0];
    if (d <= 0 || track.length < 2) return { x: p0.x - p0.ux * d, y: p0.y - p0.uy * d, ux: p0.ux, uy: p0.uy };
    for (let i = 1; i < track.length; i++) {
      const p = track[i];
      if (p.dist >= d) {
        const a = track[i - 1], k = (d - a.dist) / (p.dist - a.dist);
        return { x: a.x + (p.x - a.x) * k, y: a.y + (p.y - a.y) * k, ux: p.ux, uy: p.uy };
      }
    }
    const e = track[track.length - 1], over = d - e.dist;
    return { x: e.x - e.ux * over, y: e.y - e.uy * over, ux: e.ux, uy: e.uy };
  }
  // A pointed ribbon along a polyline: widest (w) a little before the middle, like brushStroke.
  function ribbon(ctx, pts, w) {
    if (pts.length < 2) return;
    const left = [], right = [], n = pts.length;
    for (let i = 0; i < n; i++) {
      const [x, y] = pts[i], [ax, ay] = pts[Math.max(0, i - 1)], [bx, by] = pts[Math.min(n - 1, i + 1)];
      const dx = bx - ax, dy = by - ay, d = Math.hypot(dx, dy) || 1, q = i / (n - 1);
      const half = w / 2 * (q < 0.4 ? Math.sin(q / 0.4 * Math.PI / 2) : Math.cos((q - 0.4) / 0.6 * Math.PI / 2));
      left.push([x - dy / d * half, y + dx / d * half]);
      right.push([x + dy / d * half, y - dx / d * half]);
    }
    ctx.beginPath();
    left.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    for (let i = n - 1; i >= 0; i--) ctx.lineTo(right[i][0], right[i][1]);
    ctx.closePath();
    ctx.fill();
  }

  // What every line effect needs on frame f: strength k, direction of travel, the pose matrix, the
  // silhouette seen along the travel and the trajectory behind. Null when the object is too slow.
  function lineSetup(f, sprite, at, o) {
    const step = o.step || 1, path = o.path || at;
    const v = recentVelocity(at, f, step, o.linger);
    // After a stop only a short residue lingers (the reference: a stub of a fifth to half the object,
    // gone in 2–3 drawings), not the whole trail; while the object still moves, it follows the speed.
    const now = Math.hypot(at(f).x - at(f - step).x, at(f).y - at(f - step).y) / step;
    const rest = v.ago ? Math.max(now / v.speed, 0.3 * (1 - v.ago / (o.linger + 1)) ** 2) : 1;
    const k = clamp01((v.weight - o.threshold) / Math.max(V(4) / (o.fps || 60), o.threshold)) * rest;
    if (k <= 0.02) return null;
    const cur = at(f), m = poseMatrix(cur), inv = m.inverse();
    let ux = v.vx / v.speed, uy = v.vy / v.speed;
    const track = trackBack(path, Math.floor(f / step) * step, o.maxLength, ux, uy);
    // The direction is the path's own at the drawing, not the chord over the held step: on an arc drawn
    // on Ns the two differ, and the smear would split where the object's slices meet the track.
    if (track.length > 1) { ux = track[1].ux; uy = track[1].uy; track[0].ux = ux; track[0].uy = uy; }
    const prof = profile(sprite, Math.atan2(inv.b * ux + inv.d * uy, inv.a * ux + inv.c * uy));
    if (!prof.rows.length) return null;
    return { k, v, ux, uy, m, prof, track };
  }
  // Row i of n across the silhouette, with how far towards its top or bottom it is. across: 'even' —
  // stratified and jittered (the default); 'gauss' / 'laplace' — around the middle, σ = acrossSpread.
  function pickRow(L, o, i, n, r) {
    let q;
    if (!o.across || o.across === 'even') q = 0.5 + ((i + 0.5 + (r() - 0.5) * o.jitter) / n - 0.5) * o.spread;
    else {
      const w = o.acrossSpread ?? 0.25;
      let x = 0.5 + (o.across === 'laplace' ? -Math.sign(r() - 0.5) * (w / Math.SQRT2) * Math.log(1 - r()) : w * Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r()));
      x = Math.min(1, Math.max(0, x));
      q = 0.5 + (x - 0.5) * o.spread;
    }
    const row = L.prof.rows[Math.max(0, Math.min(L.prof.rows.length - 1, Math.floor(q * L.prof.rows.length)))];
    return { row, edge: 1 - 0.55 * (2 * q - 1) ** 2 };
  }
  // A point of the sprite at offset s across and t along the travel, as a line that starts there and runs
  // back along the trajectory for `len` px (minus `gap`).
  function lineFrom(L, s, t, gap, len, straight = false) {
    const { prof, m, track, ux, uy } = L;
    const p = m.transformPoint(new DOMPoint(prof.px * s + prof.ux * t, prof.py * s + prof.uy * t));
    const rx = p.x - track[0].x, ry = p.y - track[0].y; // the track may be the undeformed motion
    return followLine(track, -uy * rx + ux * ry, ux * rx + uy * ry - gap, len, straight);
  }
  function strokeLine(ctx, pts, style, w) {
    if (style === 'brush') return ribbon(ctx, pts, w * 2);
    ctx.lineWidth = w;
    ctx.beginPath();
    pts.forEach(([x, y], j) => (j ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
  }

  // Draws speed lines on frame f. They start at the back edge of the silhouette as drawn (rotated,
  // stretched, squashed) and run back along the trajectory, so on an arc they curve with it.
  // at(f) is the pose as drawn. Pass in `path` the plain smooth motion (unheld, without squash & stretch):
  // the lines follow its curve instead of the jumps on Ns or the wobble after an impact. On Ns also
  // pass step = n. color: 'outline' takes the object's own line colour, `mix` blends each line up to
  // that far towards the object's fill.
  function speedLines(ctx, f, sprite, at, options = {}) {
    const o = withDefaults(SPEED_LINES, options), L = lineSetup(f, sprite, at, o);
    if (!L) return;
    const r = rng(Math.floor(f / o.redraw) * 7919 + o.seed * 104729);
    const base = o.color === 'outline' ? sprite.colors.outline : o.color;
    ctx.save();
    ctx.lineCap = o.style === 'bars' ? 'butt' : 'round';
    ctx.lineJoin = 'round';
    for (let i = 0; i < o.count; i++) {
      const { row, edge } = pickRow(L, o, i, o.count, r);
      const len = Math.min(o.maxLength, L.v.weight * o.length) * L.k * edge * (0.55 + 0.45 * r());
      const w = o.width * (0.7 + 0.6 * r()), inset = o.inset * (0.3 + 0.7 * r()), mix = o.mix * r();
      if (len < 2) continue;
      const pts = lineFrom(L, row.s, row.back + inset, o.gap, len + inset);
      if (pts.length < 2) continue;
      ctx.fillStyle = ctx.strokeStyle = mix > 0 ? mixColor(base, sprite.colors.fill, mix) : base;
      ctx.globalAlpha = o.opacity * (o.style === 'bars' ? 0.25 + r() * 0.35 : 1) * (0.4 + 0.6 * L.k);
      strokeLine(ctx, pts, o.style, w);
    }
    ctx.restore();
  }

  // ---------- front cuts ----------
  // Streaks through the front of the object where the background shows through, as if the object were
  // moving faster than it can be drawn. They start just past the front edge and run back into the body.
  // Defaults follow the same reference: a handful of thin streaks across the front half of the body.
  const FRONT_CUTS = {
    count: 8,          // cuts across the silhouette
    length: F(4),      // seconds of travel
    depth: 0.7,        // at most this share of the object's length along the travel
    width: 2.5,        // px at the widest
    overshoot: 8,      // px the cut starts beyond the front edge, so it breaks the outline
    threshold: V(8), linger: F(6), redraw: F(2), spread: 0.8, jitter: 0.8, maxLength: 900,
    color: null,       // null — erase (shows whatever is behind); or a colour to paint the cuts with
    seed: 7,
  };
  // Draws the sprite in its pose with front cuts on frame f (instead of drawSprite).
  function drawWithCuts(ctx, f, sprite, at, options = {}, alpha = 1) {
    // Cuts only while the object is actually moving: none on a pressed (flattened) pose, none lingering
    // after a stop — the pose they would cut is no longer the one moving.
    const o = withDefaults(FRONT_CUTS, options), q = at(f), step = o.step || 1;
    const now = Math.hypot(q.x - at(f - step).x, q.y - at(f - step).y) / step;
    const L = !q.flatten && now >= o.threshold && lineSetup(f, sprite, at, o);
    if (!L) return drawSprite(ctx, sprite, q, alpha);
    const g = openLayer(ctx);
    drawSprite(g, sprite, at(f));
    const r = rng(Math.floor(f / o.redraw) * 6007 + o.seed * 15485863);
    g.save();
    g.globalCompositeOperation = o.color ? 'source-atop' : 'destination-out';
    g.fillStyle = g.strokeStyle = o.color || '#000';
    for (let i = 0; i < o.count; i++) {
      const { row, edge } = pickRow(L, o, i, o.count, r);
      const front = L.m.transformPoint(new DOMPoint(L.prof.px * row.s + L.prof.ux * row.front, L.prof.py * row.s + L.prof.uy * row.front));
      const back = L.m.transformPoint(new DOMPoint(L.prof.px * row.s + L.prof.ux * row.back, L.prof.py * row.s + L.prof.uy * row.back));
      const depth = Math.hypot(front.x - back.x, front.y - back.y) * o.depth;
      const len = Math.min(depth, L.v.weight * o.length) * L.k * edge * (0.5 + 0.5 * r());
      if (len < 3) continue;
      const pts = lineFrom(L, row.s, row.front, -o.overshoot, len + o.overshoot);
      if (pts.length > 1) ribbon(g, pts, o.width * 2 * (0.6 + 0.8 * r()));
    }
    g.restore();
    flushLayer(ctx, g, alpha);
  }

  window.MotionSmear = {
    makeSprite, imageSprite, profile, poseMatrix, drawSprite, held, velocity, recentVelocity,
    squashStretch, SQUASH_STRETCH, speedLines, SPEED_LINES, drawWithCuts, FRONT_CUTS, mixColor, inFrames, UNITS,
    // building blocks for the effects in smear-effects.js
    openLayer, flushLayer, axisCanvas, trackBack, trackAt, followLine, ribbon, lineSetup, pickRow, lineFrom, strokeLine,
    EFFECTS: {},
  };
})();
