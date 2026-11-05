// Smear effects: the taxonomy of rikognition's «Types of Animation Smear Frames»
// built on smear.js. Every effect works on any sprite and any trajectory: it reads
// the silhouette from the sprite, its colours from the sprite's own outline and fill, and runs along the
// path the object actually travelled, so on an arc it curves. Effects grow with speed above `threshold`,
// and `linger` seconds after a stop they die out instead of vanishing on the landing frame.
//
// Each effect: { family, label, note, defaults, params, render(ctx, f, sprite, at, options) }.
// render draws the effect and the object itself. at(f) is the pose as drawn (squash & stretch, on Ns);
// options.path is the plain smooth motion, options.posed the posed motion before holding on Ns,
// options.step the N of «on Ns», options.fps the frame rate f counts in (60 by default). Options are in
// seconds and px/s (MotionSmear.UNITS); render gets them in frames. Defaults follow the reference slides.
// Loaded after smear.js; fills MotionSmear.EFFECTS.
(function () {
  const M = window.MotionSmear, { rng, clamp01 } = window.MotionCore;
  // Defaults were tuned at 60 fps; they are written as the frames and px/f they were tuned in.
  const F = (n) => n / 60, V = (n) => n * 60;
  const COMMON = { threshold: V(8), linger: F(6), redraw: F(2), maxLength: 900 };
  // Ranges of time-based params are written in frames and px/f at 60 fps too; the loop at the end turns
  // them into seconds and px/s. The lab shows seconds as ms.
  const COMMON_PARAMS = [
    ['threshold', 'Threshold, px/s', 0, 40, 1],
    ['linger', 'Linger after stop, ms', 0, 24, 1],
    ['redraw', 'Redraw every, ms', 1, 8, 1],
  ];

  // ---------- shared helpers ----------
  const lineWidthOf = (sprite) => Math.max(3, Math.min(sprite.w, sprite.h) * 0.025);
  const drawPlain = (ctx, f, sprite, at, alpha) => M.drawSprite(ctx, sprite, at(f), alpha);
  const seed = (f, o, k = 1) => rng(Math.floor(f / o.redraw) * 7919 + k * 104729);
  // Extent of the silhouette along the travel: back, front, length, height across.
  function extent(L) {
    const rows = L.prof.rows;
    const back = Math.min(...rows.map((r) => r.back)), front = Math.max(...rows.map((r) => r.front));
    return { back, front, length: front - back, height: rows[rows.length - 1].s - rows[0].s };
  }
  const posePath = (o, at) => o.path || at;
  function polyline(ctx, pts) {
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  }
  // Union of silhouettes as one flat shape with an outline: the outline colour dilated by lw in 12
  // directions, then the fill colour on top. Poses are drawn tinted, so the object's details vanish.
  function flatUnion(ctx, sprite, poses, fill, outline, lw) {
    const g = M.openLayer(ctx), out = sprite.tint(outline), inner = sprite.tint(fill);
    for (let i = 0; i < 12; i++) {
      const a = i * Math.PI / 6, dx = Math.cos(a) * lw, dy = Math.sin(a) * lw;
      for (const q of poses) M.drawSprite(g, sprite, { ...q, x: q.x + dx, y: q.y + dy }, 1, out);
    }
    for (const q of poses) M.drawSprite(g, sprite, q, 1, inner);
    return g;
  }
  // How much of an elongation each part of the object takes: u — share of its length from the front, c —
  // the centre, w — the width (share of the length). flat — even inside w, cosine edges w / 4 wide (w = 1
  // around the middle: the whole object evenly); cosine — a raised-cosine bell w wide, nothing outside it;
  // gauss — a bell with σ = w / 4, soft tails everywhere.
  const WEIGHTS = {
    flat: (u, c, w) => { const x = Math.abs(u - c) - w / 2, edge = Math.max(w / 4, 1e-3); return x <= 0 ? 1 : x >= edge ? 0 : 0.5 * (1 + Math.cos(Math.PI * x / edge)); },
    cosine: (u, c, w) => (Math.abs(u - c) >= w / 2 ? 0 : 0.5 * (1 + Math.cos(2 * Math.PI * (u - c) / w))),
    gauss: (u, c, w) => Math.exp(-0.5 * ((u - c) / (w / 4)) ** 2),
  };
  // The object sliced across its travel and laid along the trajectory, `extra` px longer and `cross`
  // times as tall. The front stays where it is; the extra length is shared between the slices by weight
  // (`profile` and `bell` around `at`, see WEIGHTS; bell 0 — one slice takes it all). Long slices are laid
  // in short pieces, so they follow the curve of the track.
  function drawAlong(ctx, sprite, q, L, extra, cross, { at = 0.5, bell = 1, profile = 'flat' } = {}, sw = 2) {
    const phi = Math.atan2(L.uy, L.ux) - (q.rot || 0), ax = M.axisCanvas(sprite, phi, 2), e = extent(L);
    const ts = [];
    for (let t = e.back - 2; t <= e.front + 2; t += sw) ts.push(t);
    const fn = WEIGHTS[profile] || WEIGHTS.flat, len0 = Math.max(1, e.length);
    let w = ts.map((t) => (bell > 0.005 ? fn(clamp01((e.front - t - sw / 2) / len0), at, bell) : 0));
    if (!w.some((x) => x > 0)) {
      const tc = e.front - at * len0;
      let best = 0;
      ts.forEach((t, i) => { if (Math.abs(t + sw / 2 - tc) < Math.abs(ts[best] + sw / 2 - tc)) best = i; });
      w = ts.map((_, i) => (i === best ? 1 : 0));
    }
    const total = w.reduce((a, b) => a + b, 0), ahead = [];
    for (let i = ts.length - 1, acc = 0; i >= 0; i--) { ahead[i] = acc / total; acc += w[i]; }
    const slice = (t, d, len) => {
      const p = M.trackAt(L.track, d), p2 = M.trackAt(L.track, d + len);
      // On a bend the outer edge of a slice is longer than its centre line: stretch it to close the gap.
      const turn = Math.abs(Math.atan2(p.ux * p2.uy - p.uy * p2.ux, p.ux * p2.ux + p.uy * p2.uy));
      len += turn * ax.R * cross;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(Math.atan2(p.uy, p.ux));
      ctx.drawImage(ax.canvas, (t + ax.R) * ax.res, 0, sw * ax.res, ax.size, -1, -ax.R * cross, len + 2.5, 2 * ax.R * cross); // overlap hides seams on curves
      ctx.restore();
    };
    ts.forEach((t, i) => {
      const back = -t + extra * (ahead[i] + w[i] / total), len = sw + extra * w[i] / total, n = Math.ceil(len / 6);
      for (let j = 0; j < n; j++) slice(t, back - j * len / n, len / n);
    });
  }
  // A share of the object (0 front … 1 back) drawn around c: gauss (σ = w), laplace (as spread, a sharper
  // peak and longer tails), uniform (c ± w). Drawn again, up to four times, to land inside 0…1.
  function sample(r, c, w, shape) {
    for (let i = 0; i < 4; i++) {
      let x;
      if (shape === 'uniform') x = c + (2 * r() - 1) * w;
      else if (shape === 'laplace') { const u = r() - 0.5; x = c - Math.sign(u) * (w / Math.SQRT2) * Math.log(1 - 2 * Math.abs(u)); }
      else x = c + w * Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
      if (x >= 0 && x <= 1) return x;
    }
    return clamp01(c);
  }

  // The object turning into its own smear, as in every «replace» slide of the reference: the object is
  // drawn, then each row across the travel, from `from` of its length (0 — the front, 1 — the back) back,
  // is redrawn as a streak of the colour found there, running back along the trajectory. each(row, u)
  // (u — 0…1 across the object) gives the row its streak {len — px past the back edge, color, alpha,
  // erase — cut the row out instead, dash, fade — share of the streak before it fades out, width — of
  // the row height, at — where to pick the colour, share like `from`} or null to
  // leave it as drawn. pick() — where a row takes its colour when the spec has no `at` (default: `from`).
  // Returns the layer (call M.flushLayer) and the streak tips, top to bottom.
  function smearRows(ctx, sprite, q, L, { band = 3, from = 0.5, each, pick = null }) {
    const g = M.openLayer(ctx), rows = L.prof.rows, s0 = rows[0].s, s1 = rows[rows.length - 1].s;
    const scale = Math.sqrt(Math.abs(L.m.a * L.m.d - L.m.b * L.m.c)), tips = [], todo = [];
    let longest = 0, inset = 0;
    for (let s = s0; s <= s1; s += band) {
      const row = rows[Math.min(rows.length - 1, Math.round((s - s0) / (rows[1] ? rows[1].s - s0 : 1)))], u = (s - s0) / Math.max(1, s1 - s0);
      const spec = each(row, u);
      if (!spec) continue;
      // While the effect is weak (setting off, fading out after a stop), less of the object is torn.
      const t0 = row.front - (row.front - row.back) * (1 - (1 - (spec.from ?? from)) * Math.min(1, 2 * L.k));
      todo.push({ s, row, spec, t0 });
      longest = Math.max(longest, spec.len);
      inset = Math.max(inset, t0 - row.back);
    }
    // Streaks never run past the start of the path: when it is shorter than asked, all of them shrink
    // together, so the shape they make (teeth, runs) survives.
    const fit = longest > 0 ? Math.min(1, Math.max(0, L.track[L.track.length - 1].dist - inset) / longest) : 1;
    M.drawSprite(g, sprite, q);
    g.save();
    g.lineCap = 'butt'; g.lineJoin = 'round';
    for (const { s, row, spec, t0 } of todo) {
      const tc = row.front - (row.front - row.back) * (spec.at ?? (pick ? pick() : spec.from ?? from));
      const pts = M.lineFrom(L, s, t0, 0, t0 - row.back + Math.max(0, spec.len * fit), true);
      if (pts.length < 2) continue;
      tips.push(pts[pts.length - 1]);
      g.globalCompositeOperation = spec.erase ? 'destination-out' : 'source-over';
      const color = spec.color || sprite.colorAt(L.prof.px * s + L.prof.ux * tc, L.prof.py * s + L.prof.uy * tc) || sprite.colors.fill;
      if (spec.fade) {
        const a = pts[0], b = pts[pts.length - 1], gr = g.createLinearGradient(a[0], a[1], b[0], b[1]);
        gr.addColorStop(0, color); gr.addColorStop(spec.fade, color); gr.addColorStop(1, M.mixColor(color, color, 0).replace('rgb', 'rgba').replace(')', ', 0)'));
        g.strokeStyle = gr;
      } else g.strokeStyle = color;
      g.globalAlpha = spec.alpha ?? 1;
      g.lineWidth = band * scale * (spec.width ?? 1.15);
      g.setLineDash(spec.dash || []);
      polyline(g, pts); g.stroke();
    }
    g.restore();
    return { g, tips };
  }
  // Smooth noise across the object (0…1), for rows that should vary in bundles, not one by one.
  const wave = (r) => { const a = [r() * 6, r() * 6, r() * 6]; return (u) => 0.5 + 0.22 * Math.sin(u * 7 + a[0]) + 0.18 * Math.sin(u * 17 + a[1]) + 0.1 * Math.sin(u * 37 + a[2]); };
  const edgeOf = (u) => 1 - 0.55 * (2 * u - 1) ** 2;

  const E = M.EFFECTS;
  // Where the streaks take their colours: around `from`, by this distribution and spread (share of the object).
  const PICK_PARAMS = [{ key: 'pick', label: 'Colours taken by', options: ['gauss', 'laplace', 'uniform'] }, ['pickSpread', 'Colours taken around it, spread', 0, 0.5, 0.01]];
  // Where lines sit across the object: even (stratified, as drawn so far) or around the middle.
  const ACROSS_PARAMS = [{ key: 'across', label: 'Lines across', options: ['even', 'gauss', 'laplace'] }, ['acrossSpread', 'Lines across, spread', 0.05, 0.5, 0.01]];

  // ======================= 1. Deformation =======================
  E.stretched = {
    family: 'Deformation', label: 'Stretched in-between',
    note: 'Squash & stretch pushed to a smear: the shape elongates along its path (bending on curves), thinning as it does. The stretch follows the speed and never outruns the distance covered.',
    // The reference smear is about 2.1× as long and 0.36× as tall as the ball (with squash & stretch on
    // top of this): thinner than area-keeping, hence volume > 1.
    defaults: { ...COMMON, max: 0.9, frames: F(2.5), volume: 1.3, at: 0.5, bell: 1, profile: 'flat' },
    params: [
      ['max', 'Stretch max (+100 % = twice as long)', 0, 3, 0.05], ['frames', 'Stretch = travel of this many ms', 0.25, 8, 0.25], ['volume', 'Thinning (1 keeps the area)', 0, 2, 0.1],
      { key: 'profile', label: 'Stretch profile', options: ['flat', 'cosine', 'gauss'] }, ['at', 'Stretches around, share of the object from its front', 0, 1, 0.01],
      ['bell', 'Stretch spread, share of the object (0 — one slice)', 0, 1, 0.01],
    ],
    render(ctx, f, sprite, at, o) {
      const q = at(f), L = !q.flatten && M.lineSetup(f, sprite, at, o);
      if (!L) return M.drawSprite(ctx, sprite, q);
      // The shape grows by what it covers in `frames` (s) at its speed (L.k brings it down as it
      // brakes), at most `max`, and no longer than the way it has come since it set off.
      const e = extent(L), extra = Math.min(o.max * e.length, L.v.speed * o.frames, L.track[L.track.length - 1].dist) * L.k, st = 1 + extra / e.length;
      drawAlong(ctx, sprite, q, L, extra, Math.pow(st, -o.volume), o);
    },
  };
  E.elongated = {
    family: 'Deformation', label: 'Elongated in-between',
    note: 'One drawing bridges the poses: the middle of the object runs along the path it just covered, at full height — the area grows; its ends barely stretch. Move the centre to pick what stretches, narrow the spread to a single slice: through the middle of an O or a P the bowl becomes two long rails.',
    defaults: { ...COMMON, span: F(3), at: 0.5, bell: 0.3, profile: 'cosine' },
    params: [
      ['span', 'Covers this many ms of travel', 0.5, 10, 0.5],
      { key: 'profile', label: 'Stretch profile', options: ['flat', 'cosine', 'gauss'] }, ['at', 'Stretches around, share of the object from its front', 0, 1, 0.01],
      ['bell', 'Stretch spread, share of the object (0 — one slice)', 0, 1, 0.01],
    ],
    render(ctx, f, sprite, at, o) {
      const q = at(f), L = !q.flatten && M.lineSetup(f, sprite, at, o);
      if (!L) return M.drawSprite(ctx, sprite, q);
      const extra = Math.min(o.maxLength, L.v.weight * o.span) * L.k;
      drawAlong(ctx, sprite, q, L, extra, 1, o);
    },
  };
  E.geometric = {
    family: 'Deformation', label: 'Geometric abstraction',
    note: 'So fast the whole path collapses into one flat shape: a spin becomes a striped disk, a swing a fan. Try Spin or Swing.',
    defaults: { ...COMMON, threshold: V(14), span: F(3), from: 0.3, rings: 3 },
    params: [['span', 'Sweep, ms', 0.25, 4, 0.25], ['from', 'Take over above strength', 0, 1, 0.05], ['rings', 'Rings on a spin', 0, 8, 1]],
    render(ctx, f, sprite, at, o) {
      const q = at(f), path = posePath(o, at);
      if (q.flatten) return M.drawSprite(ctx, sprite, q);
      const R = Math.hypot(sprite.w, sprite.h) / 2;
      // Tangential speed of a spin and linear speed, both lingering.
      let spin = 0, best = 0;
      for (let j = 0; j <= o.linger; j++) {
        const w = Math.abs((path(f - j).rot || 0) - (path(f - j - 1).rot || 0)) * R * 0.8 * (1 - j / (o.linger + 1));
        spin = Math.max(spin, w);
      }
      best = Math.max(spin, M.recentVelocity(path, f, 1, o.linger).weight);
      const k = clamp01((best - o.threshold) / Math.max(V(4) / o.fps, o.threshold));
      if (k <= o.from) return M.drawSprite(ctx, sprite, q);
      const n = 32, poses = [];
      for (let j = 0; j <= n; j++) {
        const p = path(f - o.span * j / n);
        poses.push({ x: p.x, y: p.y, rot: p.rot || 0 });
      }
      const { outline, fill } = sprite.colors, lw = lineWidthOf(sprite);
      const g = flatUnion(ctx, sprite, poses, fill, outline, lw);
      if (spin >= best * 0.99 && o.rings > 0) {
        g.globalCompositeOperation = 'source-atop';
        g.strokeStyle = M.mixColor(fill, outline, 0.35);
        g.lineWidth = lw * 1.4;
        for (let i = 1; i <= o.rings; i++) { g.beginPath(); g.arc(q.x, q.y, R * i / (o.rings + 1), 0, Math.PI * 2); g.stroke(); }
      }
      M.flushLayer(ctx, g);
    },
  };

  // ======================= 2. Multiples =======================
  E.duplicate = {
    family: 'Multiples', label: 'Duplicate parts',
    note: 'A chain of after-images left behind along the path, smaller and smaller, fused with the object and with each other by narrow necks into one outlined shape.',
    defaults: { ...COMMON, linger: F(8), count: 3, span: F(8), shrink: 0.84, gap: 0.95, neck: 0.4, drift: 0.05 },
    params: [['count', 'Copies', 1, 10, 1], ['span', 'Spread at most, ms of travel', 0.5, 10, 0.5], ['shrink', 'Size falls off', 0.3, 1, 0.02], ['gap', 'Spacing (1 — copies touch)', 0.3, 2, 0.05], ['neck', 'Neck between copies, share of the smaller one (0 — apart)', 0, 1, 0.05], ['drift', 'Drift across', 0, 0.6, 0.01]],
    render(ctx, f, sprite, at, o) {
      const q = at(f), L = !q.flatten && M.lineSetup(f, sprite, at, o);
      if (!L) return M.drawSprite(ctx, sprite, q);
      const e = extent(L), r = seed(f, o, 3);
      // No further back than where the object set off.
      const total = Math.min(o.maxLength, L.v.weight * o.span, L.track[L.track.length - 1].dist + e.length * 0.5) * L.k;
      // The first copy overlaps the object by half; each next one sits `gap` radii past the previous.
      const drops = [{ d: 0, scale: 1, side: 0 }];
      let d = 0;
      for (let i = 1; i <= o.count; i++) {
        const scale = Math.pow(o.shrink, i ** 1.6), prev = drops[drops.length - 1].scale;
        d += i === 1 ? e.length * 0.5 : e.length / 2 * (prev + scale) * o.gap;
        if (d > total) break;
        drops.push({ d, scale, side: (r() - 0.5) * 2 * o.drift * e.height });
      }
      const pose = (dd, scale, side) => {
        const p = M.trackAt(L.track, dd);
        return { x: p.x - p.uy * side, y: p.y + p.ux * side, rot: q.rot || 0, scale };
      };
      // Necks: small copies all the way between neighbours, pinched in the middle, so the chain is one body.
      const poses = [];
      for (let i = 1; i < drops.length; i++) {
        const a = drops[i - 1], b = drops[i], n = Math.ceil((b.d - a.d) / 4);
        if (o.neck > 0) for (let j = 1; j < n; j++) {
          const t = j / n, pinch = 1 - (1 - o.neck) * Math.sin(Math.PI * t);
          poses.push(pose(a.d + (b.d - a.d) * t, Math.min(a.scale, b.scale) * pinch, a.side + (b.side - a.side) * t));
        }
        poses.push(pose(b.d, b.scale, b.side));
      }
      poses.push({ ...q, flatten: 0 });
      const g = flatUnion(ctx, sprite, poses, sprite.colors.fill, sprite.colors.outline, lineWidthOf(sprite));
      M.flushLayer(ctx, g);
      M.drawSprite(ctx, sprite, q);
    },
  };
  E.ghosting = {
    family: 'Multiples', label: 'Ghosting',
    note: 'Onion skin: see-through copies at the positions the object just passed.',
    defaults: { ...COMMON, linger: F(10), count: 4, span: F(3), spacing: 0.25, alpha: 0.5 },
    params: [['count', 'Copies', 1, 8, 1], ['span', 'Spread, ms of travel', 0.5, 10, 0.5], ['spacing', 'Spacing at most, share of the object', 0.1, 1.5, 0.05], ['alpha', 'Opacity of the nearest', 0.05, 1, 0.05]],
    render(ctx, f, sprite, at, o) {
      const q = at(f), L = !q.flatten && M.lineSetup(f, sprite, at, o);
      if (L) {
        const e = extent(L), total = Math.min(o.maxLength, L.v.weight * o.span) * L.k;
        // Tightly overlapping, as in the reference: copies a quarter of the object apart.
        const gap = Math.min(e.length * o.spacing, total / o.count);
        for (let i = o.count; i >= 1; i--) {
          const d = gap * i;
          if (d > total + e.length * 0.3) continue;
          const p = M.trackAt(L.track, d);
          M.drawSprite(ctx, sprite, { x: p.x, y: p.y, rot: q.rot || 0 }, o.alpha * (1 - (i - 1) / o.count) * L.k);
        }
      }
      M.drawSprite(ctx, sprite, q);
    },
  };

  // ======================= 3. Linework =======================
  E.jagged = {
    family: 'Linework', label: 'Jagged lines',
    note: 'The object’s back half torn into a zigzag along the path, like a seismograph: its own colours streaked, the torn edge outlined.',
    defaults: { ...COMMON, linger: F(3), teeth: 9, length: F(6), short: 0.25, from: 0.45, pick: 'gauss', pickSpread: 0.08 },
    params: [['teeth', 'Teeth', 3, 30, 1], ['length', 'Length, ms of travel', 1, 16, 0.5], ['short', 'Between teeth, share', 0, 1, 0.05], ['from', 'Tears from, share of the object from its front', 0.1, 1, 0.05], ...PICK_PARAMS],
    render(ctx, f, sprite, at, o) {
      const q = at(f), L = !q.flatten && M.lineSetup(f, sprite, at, o);
      if (!L) return M.drawSprite(ctx, sprite, q);
      const long = Math.min(o.maxLength, L.v.weight * o.length) * L.k, r = seed(f, o, 5);
      const amp = Array.from({ length: o.teeth }, () => 0.45 + 0.55 * r());
      const { g, tips } = smearRows(ctx, sprite, q, L, {
        band: 2, from: o.from, pick: () => sample(r, o.from, o.pickSpread, o.pick),
        each: (row, u) => {
          const x = u * o.teeth, i = Math.min(o.teeth - 1, Math.floor(x)), tri = 1 - Math.abs(2 * (x - i) - 1);
          return { len: long * amp[i] * edgeOf(u) * (o.short + (1 - o.short) * tri) };
        },
      });
      M.flushLayer(ctx, g);
      // The torn edge, in the object's line colour.
      ctx.save();
      ctx.strokeStyle = sprite.colors.outline; ctx.lineWidth = lineWidthOf(sprite); ctx.lineJoin = 'miter';
      polyline(ctx, tips); ctx.stroke();
      ctx.restore();
    },
  };
  E.hatched = {
    family: 'Linework', label: 'Hatched lines',
    note: 'The object breaks into parallel strokes along its motion: its body becomes lines of its own colours with paper between them, plus thin lines in its line colour behind.',
    defaults: { ...COMMON, linger: F(3), count: 26, length: F(6), width: 2, mix: 0.7, band: 4, gaps: 0.4, from: 0.85 },
    params: [['band', 'Stroke height, px', 2, 12, 1], ['gaps', 'Gaps between strokes, share', 0, 0.8, 0.05], ['from', 'Breaks from, share of the object from its front', 0.1, 1, 0.05], ['length', 'Length, ms of travel', 1, 16, 0.5], ['count', 'Thin lines behind', 0, 60, 1], ['width', 'Thin line width, px', 1, 12, 0.5], ['mix', 'Thin lines towards the fill colour', 0, 1, 0.05]],
    render(ctx, f, sprite, at, o) {
      const q = at(f), L = !q.flatten && M.lineSetup(f, sprite, at, o);
      if (!L) return M.drawSprite(ctx, sprite, q);
      const e = extent(L), long = Math.min(o.maxLength, L.v.weight * o.length) * L.k, r = seed(f, o, 11);
      const { g } = smearRows(ctx, sprite, q, L, {
        band: o.band, from: o.from,
        each: (row, u) => (r() < o.gaps ? { len: 0, erase: true, width: 0.6 } : { len: long * edgeOf(u) * (0.3 + 0.7 * r()), width: 0.75 }),
      });
      M.flushLayer(ctx, g);
      if (o.count > 0) M.speedLines(ctx, f, sprite, at, { ...o, style: 'thin', inset: e.length * 0.5, gap: 0, spread: 1, jitter: 0.3, seed: 11 });
    },
  };
  E.speedlines = {
    family: 'Linework', label: 'Speedlines',
    note: 'Comic-strip lines over the object and its path, in its outline colour; the background shows through cuts in its front.',
    defaults: { ...COMMON, ...M.SPEED_LINES, layer: 'over', cuts: 8, cutLength: F(4), cutDepth: 0.7, cutWidth: 2.5, cutOvershoot: 8 },
    params: [
      { key: 'style', label: 'Style', options: ['brush', 'thin', 'bars'] },
      { key: 'layer', label: 'Lines', options: ['over', 'behind'] },
      { key: 'color', label: 'Colour', options: ['outline', 'fill'] },
      ['count', 'Lines', 1, 40, 1], ['length', 'Length, ms of travel', 1, 20, 0.5], ['width', 'Width, px', 1, 12, 0.5],
      ['mix', 'Towards the fill colour', 0, 1, 0.05], ['gap', 'Gap behind the edge, px', -40, 60, 1], ['inset', 'Start inside the shape, px', 0, 300, 2],
      ['spread', 'Spread across the shape', 0.2, 1, 0.05], ['jitter', 'Position jitter', 0, 1, 0.05], ...ACROSS_PARAMS,
      ['cuts', 'Front cuts', 0, 20, 1], ['cutLength', 'Cut length, ms of travel', 0.5, 12, 0.5], ['cutDepth', 'Cut depth, share of the object', 0.1, 1, 0.05],
      ['cutWidth', 'Cut width, px', 1, 10, 0.5], ['cutOvershoot', 'Cuts break the outline by, px', 0, 30, 1],
    ],
    render(ctx, f, sprite, at, o) {
      const lines = { ...o, color: o.color === 'fill' ? sprite.colors.fill : 'outline' };
      if (o.layer === 'behind') M.speedLines(ctx, f, sprite, at, lines);
      if (o.cuts > 0) M.drawWithCuts(ctx, f, sprite, at, { ...o, count: o.cuts, length: o.cutLength, depth: o.cutDepth, width: o.cutWidth, overshoot: o.cutOvershoot, spread: 0.8, jitter: 0.8, seed: 7 });
      else M.drawSprite(ctx, sprite, at(f));
      if (o.layer !== 'behind') M.speedLines(ctx, f, sprite, at, lines);
    },
  };

  // ======================= 4. Motion trails =======================
  E.bleed = {
    family: 'Motion trails', label: 'Color bleeds',
    note: 'The fill escapes the outline in rounded tongues along the path and catches up with the shape after it stops.',
    defaults: { ...COMMON, linger: F(12), count: 6, length: F(5), width: 0.16, inset: 0.45 },
    params: [['count', 'Tongues', 1, 16, 1], ['length', 'Length, ms of travel', 1, 16, 0.5], ['width', 'Width, share of the height', 0.04, 0.4, 0.01], ['inset', 'Start inside, share of the object', 0, 0.9, 0.05]],
    render(ctx, f, sprite, at, o) {
      const q = at(f), L = !q.flatten && M.lineSetup(f, sprite, at, o);
      M.drawSprite(ctx, sprite, q);
      if (!L) return;
      const e = extent(L), r = seed(f, o, 9), cfg = { jitter: 0.7, spread: 0.85 }, cols = [sprite.colors.fill, sprite.colors.second];
      ctx.save();
      ctx.lineCap = ctx.lineJoin = 'round';
      for (let i = 0; i < o.count; i++) {
        const { row, edge } = M.pickRow(L, cfg, i, o.count, r);
        const len = Math.min(o.maxLength, L.v.weight * o.length) * L.k * edge * (0.45 + 0.55 * r()), inset = e.length * o.inset;
        const pts = M.lineFrom(L, row.s, row.back + inset, 0, len + inset);
        if (pts.length < 2) continue;
        ctx.strokeStyle = cols[i % 2 && r() < 0.5 ? 1 : 0];
        ctx.lineWidth = e.height * o.width * (0.6 + 0.6 * r());
        polyline(ctx, pts); ctx.stroke();
      }
      ctx.restore();
    },
  };
  E.brush = {
    family: 'Motion trails', label: 'Textured brush strokes',
    note: 'The object dragged into broad dry-brush strokes: bristles of its own colours, broken along their length, with paper showing between them.',
    defaults: { ...COMMON, length: F(6), band: 2, dry: 0.18, from: 0.7 },
    params: [['length', 'Length, ms of travel', 1, 16, 0.5], ['band', 'Bristle, px', 1, 8, 0.5], ['dry', 'Dry gaps, share', 0, 0.6, 0.02], ['from', 'Brushed from, share of the object from its front', 0.1, 1, 0.05]],
    render(ctx, f, sprite, at, o) {
      const q = at(f), L = !q.flatten && M.lineSetup(f, sprite, at, o);
      if (!L) return M.drawSprite(ctx, sprite, q);
      const long = Math.min(o.maxLength, L.v.weight * o.length) * L.k, r = seed(f, o, 13), bundle = wave(r);
      const { g } = smearRows(ctx, sprite, q, L, {
        band: o.band, from: o.from,
        each: (row, u) => {
          if (r() < o.dry) return { len: 0, erase: true, width: 0.8 };
          // Dry brush: long runs of paint broken by short skips; the tail end runs dry first.
          const dash = [];
          for (let k = 0; k < 6; k++) dash.push(40 + r() * 140, 2 + r() * 8 * k);
          return { len: long * edgeOf(u) * (0.35 + 0.65 * bundle(u)) * (0.85 + 0.3 * r()), dash, alpha: 0.75 + 0.25 * r(), at: o.from * r() };
        },
      });
      M.flushLayer(ctx, g);
    },
  };
  E.sketch = {
    family: 'Motion trails', label: 'Sketched gestures',
    note: 'Quick pencil strokes along the motion, each in the colour of the spot it starts on, laid over the object’s smeared back half and its path, a few over its front edge too; the body under them is streaked in its own colours. Redrawn on 4s like a hand-drawn layer.',
    defaults: { ...COMMON, redraw: F(4), count: 46, length: F(5), width: 3.5, front: 0.2, from: 0.55, gaps: 0.12, pick: 'laplace', pickSpread: 0.12, across: 'even', acrossSpread: 0.25 },
    params: [['count', 'Strokes', 4, 120, 1], ['length', 'Length, ms of travel', 1, 16, 0.5], ['width', 'Pencil width, px', 0.5, 8, 0.5], ['front', 'Strokes over the front, share', 0, 0.6, 0.05], ['from', 'Body smeared from, share from its front', 0, 1, 0.05], ['gaps', 'Paper between the smeared rows, share', 0, 0.6, 0.02], ...PICK_PARAMS, ...ACROSS_PARAMS],
    render(ctx, f, sprite, at, o) {
      const q = at(f), L = !q.flatten && M.lineSetup(f, sprite, at, o);
      if (!L) return M.drawSprite(ctx, sprite, q);
      const e = extent(L), r = seed(f, o, 17), long = Math.min(o.maxLength, L.v.weight * o.length) * L.k, bundle = wave(r);
      const avail = Math.max(0, L.track[L.track.length - 1].dist);
      // The body is streaked first, rows in bundles, so the strokes sit on a smear, not on a clean shape.
      const { g } = smearRows(ctx, sprite, q, L, { band: 3, from: o.from, pick: () => sample(r, o.from, o.pickSpread, o.pick), each: (row, u) => (r() < o.gaps ? { len: 0, erase: true, width: 0.7 } : { len: long * 0.7 * edgeOf(u) * (0.3 + 0.7 * bundle(u)) * (0.8 + 0.4 * r()) }) });
      M.flushLayer(ctx, g);
      ctx.save();
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (let i = 0; i < o.count; i++) {
        const { row, edge } = M.pickRow(L, { jitter: 1, spread: 0.96, across: o.across, acrossSpread: o.acrossSpread }, i, o.count, r);
        const size = row.front - row.back;
        if (size <= 0) continue;
        let start, len;
        if (r() < o.front) {
          // Short strokes on the front edge, sticking out of it a little: a rough pencil contour.
          start = row.front + size * 0.05 * r();
          len = size * (0.06 + 0.16 * r());
        } else {
          // Mostly the back half: from around 0.7 of the way back, by the colour distribution, out along the path.
          start = row.front - size * Math.max(0.3, sample(r, 0.7, o.pickSpread * 2, o.pick));
          len = (start - row.back) + Math.min(avail, long * edge * (0.25 + 0.75 * r()));
        }
        const pts = M.lineFrom(L, row.s, start, 0, len, true);
        if (pts.length < 2) continue;
        // The pencil takes the colour of the spot it starts on (front strokes: just inside the edge).
        const tc = Math.min(start, row.front - size * 0.03);
        ctx.strokeStyle = sprite.colorAt(L.prof.px * row.s + L.prof.ux * tc, L.prof.py * row.s + L.prof.uy * tc) || sprite.colors.outline;
        ctx.globalAlpha = 0.7 + 0.3 * r();
        ctx.lineWidth = o.width * (0.5 + 0.9 * r());
        polyline(ctx, pts); ctx.stroke();
      }
      ctx.restore();
    },
  };
  // Particles born along the path every `every` frames, living `life` frames (o in frames): a pure function of f —
  // each particle is defined by its birth frame and a seed.
  function eachParticle(f, path, o, fn) {
    for (let born = Math.floor(f / o.every) * o.every; born > f - o.life; born -= o.every) {
      const a = path(born - 1), b = path(born), vx = b.x - a.x, vy = b.y - a.y, speed = Math.hypot(vx, vy);
      if (speed < o.threshold) continue;
      // A fast frame covers a long stretch of path: spread its particles along all of it.
      const n = Math.max(1, Math.ceil(speed * o.every / (o.spacing || Infinity)));
      for (let j = 0; j < n; j++) {
        const back = speed * o.every * j / n;
        fn({ born, age: f - born, x: b.x - vx / speed * back, y: b.y - vy / speed * back, ux: vx / speed, uy: vy / speed, speed, r: rng(born * 2654435761 + j * 40503 + o.seed) });
      }
    }
  }
  function star(ctx, x, y, size) {
    ctx.beginPath();
    ctx.moveTo(x, y - size);
    ctx.quadraticCurveTo(x, y, x + size, y);
    ctx.quadraticCurveTo(x, y, x, y + size);
    ctx.quadraticCurveTo(x, y, x - size, y);
    ctx.quadraticCurveTo(x, y, x, y - size);
    ctx.fill();
  }
  E.light = {
    family: 'Motion trails', label: 'Particle FX: light & energy',
    note: 'Glowing streaks along the path and sparkles left behind, twinkling out after the object passes.',
    defaults: { ...COMMON, color: '#e8f54a', lines: 6, length: F(8), glow: 10, every: F(2), life: F(30), size: 0.13, seed: 3 },
    params: [{ key: 'color', label: 'Light colour', color: true }, ['lines', 'Streaks', 0, 16, 1], ['length', 'Streak length, ms of travel', 1, 16, 0.5], ['glow', 'Glow, px', 0, 30, 1], ['every', 'A sparkle every, ms', 1, 8, 1], ['life', 'Sparkle life, ms', 6, 80, 1], ['size', 'Sparkle size, share of the object', 0.02, 0.3, 0.01]],
    render(ctx, f, sprite, at, o) {
      const q = at(f), path = posePath(o, at), h = Math.min(sprite.w, sprite.h);
      M.drawSprite(ctx, sprite, q);
      ctx.save();
      ctx.shadowColor = o.color; ctx.shadowBlur = o.glow;
      if (o.lines > 0) M.speedLines(ctx, f, sprite, at, { ...o, style: 'brush', count: o.lines, width: 3.5, color: o.color, mix: 0, gap: -h * 0.1, inset: 0, spread: 0.9, seed: 19 });
      ctx.fillStyle = o.color;
      eachParticle(f, path, { ...o, spacing: h * 0.6 }, (p) => {
        const r = p.r, side = (r() - 0.5) * h * 1.1, back = r() * h * 0.4 + p.age * p.speed * 0.04;
        const life = p.age / o.life, size = h * o.size * (0.5 + r()) * Math.sin(Math.PI * Math.min(1, life * 1.4 + 0.05)) * (0.75 + 0.25 * Math.sin(p.age * V(0.9) / o.fps + r() * 6));
        if (size <= 0) return;
        const x = p.x - p.uy * side - p.ux * back, y = p.y + p.ux * side - p.uy * back;
        ctx.globalAlpha = 1 - life * life;
        star(ctx, x, y, size);
        ctx.fillStyle = '#fff'; star(ctx, x, y, size * 0.35); ctx.fillStyle = o.color;
      });
      ctx.restore();
    },
  };
  E.dust = {
    family: 'Motion trails', label: 'Particle FX: environmental', hidden: true, // too special for the lab
    note: 'A cloud of dust and smoke kicked up all along the path, growing and drifting after the object passes, with a few wind streaks.',
    defaults: { ...COMMON, color: '#b8b5ae', lineColor: '#e6d84a', every: F(2), life: F(40), size: 0.22, grow: 1.5, lines: 4, seed: 5 },
    params: [{ key: 'color', label: 'Dust colour', color: true }, { key: 'lineColor', label: 'Streak colour', color: true }, ['every', 'Puffs every, ms', 1, 10, 1], ['life', 'Puff life, ms', 8, 120, 1], ['size', 'Puff size, share of the object', 0.05, 0.6, 0.01], ['grow', 'Grows to, ×', 1, 4, 0.1], ['lines', 'Wind streaks', 0, 12, 1]],
    render(ctx, f, sprite, at, o) {
      const q = at(f), path = posePath(o, at), h = Math.min(sprite.w, sprite.h), g = M.openLayer(ctx);
      const shade = M.mixColor(o.color, '#000', 0.15), light = M.mixColor(o.color, '#fff', 0.2);
      eachParticle(f, path, { ...o, spacing: h * 0.25 }, (p) => {
        const r = p.r, life = p.age / o.life, side = (r() - 0.5) * h * 0.75, back = h * 0.1 + p.age * p.speed * 0.02;
        const x = p.x - p.uy * side - p.ux * back, y = p.y + p.ux * side - p.uy * back - p.age * h * V(0.004) / o.fps;
        const rad = h * o.size * (0.6 + 0.6 * r()) * (1 + (o.grow - 1) * Math.sqrt(life));
        g.globalAlpha = Math.pow(1 - life, 1.3);
        // Each puff a few soft lobes drawn out along the travel: shaded underneath, a little lighter on top.
        const a0 = Math.atan2(p.uy, p.ux);
        for (let k = 0; k < 4; k++) {
          const a = r() * Math.PI * 2, dd = rad * 0.55 * r(), cx = x + Math.cos(a) * dd * 1.6, cy = y + Math.sin(a) * dd, cr = rad * (0.55 + 0.45 * r());
          g.fillStyle = shade; g.beginPath(); g.ellipse(cx, cy + cr * 0.15, cr * 1.6, cr, a0, 0, Math.PI * 2); g.fill();
          g.fillStyle = o.color; g.beginPath(); g.ellipse(cx, cy, cr * 1.45, cr * 0.85, a0, 0, Math.PI * 2); g.fill();
          g.fillStyle = light; g.beginPath(); g.ellipse(cx - cr * 0.2, cy - cr * 0.35, cr * 0.8, cr * 0.35, a0, 0, Math.PI * 2); g.fill();
        }
      });
      M.flushLayer(ctx, g, 0.8);
      if (o.lines > 0) M.speedLines(ctx, f, sprite, at, { ...o, style: 'brush', count: o.lines, width: 2.5, color: o.lineColor, mix: 0, gap: -h * 0.2, inset: 0, spread: 0.8, seed: 23 });
      M.drawSprite(ctx, sprite, q);
    },
  };

  // ======================= 5. Blurs =======================
  E.blur = {
    family: 'Blurs', label: 'Photographic motion blur',
    note: 'A camera shutter: the object averaged over the path it travels while the shutter is open (follows curves).',
    defaults: { ...COMMON, shutter: 540, samples: 24 },
    params: [['shutter', 'Shutter, ° (360 = one frame of travel)', 30, 1800, 15], ['samples', 'Samples', 4, 48, 1]],
    render(ctx, f, sprite, at, o) {
      // The drawing is held on Ns, but the shutter is the frame rate's own: the tail is as long as on ones.
      const step = o.step || 1, posed = o.posed || at, f0 = Math.floor(f / step) * step, span = o.shutter / 360;
      // As many samples as the travel needs (one every 1.5 px, up to `samples`): summing many identical
      // copies at 1/n each rounds every channel the same way and shifts the colour of a still object.
      let travel = 0, prev = posed(f0);
      for (let i = 1; i <= 8; i++) {
        const q = posed(f0 - span * i / 8);
        travel += Math.hypot(q.x - prev.x, q.y - prev.y) + Math.abs((q.rot || 0) - (prev.rot || 0)) * Math.max(sprite.w, sprite.h) / 2 + Math.abs((q.stretch || 1) - (prev.stretch || 1)) * sprite.w + Math.abs((q.flatten || 0) - (prev.flatten || 0)) * sprite.w;
        prev = q;
      }
      const n = Math.max(1, Math.min(o.samples, Math.ceil(travel / 1.5)));
      if (n === 1) return M.drawSprite(ctx, sprite, posed(f0));
      const g = M.openLayer(ctx);
      g.globalCompositeOperation = 'lighter';
      for (let i = 0; i < n; i++) M.drawSprite(g, sprite, posed(f0 - span * i / (n - 1)), 1 / n);
      M.flushLayer(ctx, g);
    },
  };
  E.smudge = {
    family: 'Blurs', label: 'Smudged blurs',
    note: 'The picture dragged back by a wet brush: the front keeps its shape, the back runs along the path in soft tapering streaks of its own colours.',
    defaults: { ...COMMON, length: F(3), from: 0.55, band: 2, soft: 0.25, pick: 'gauss', pickSpread: 0.08 },
    params: [['length', 'Length, ms of travel', 0.5, 12, 0.5], ['from', 'Dragged from, share of the object from its front', 0.1, 1, 0.05], ['band', 'Streak, px', 1, 8, 0.5], ['soft', 'Solid part before it fades', 0, 0.9, 0.05], ...PICK_PARAMS],
    render(ctx, f, sprite, at, o) {
      const q = at(f), L = !q.flatten && M.lineSetup(f, sprite, at, o);
      if (!L) return M.drawSprite(ctx, sprite, q);
      const long = Math.min(o.maxLength, L.v.weight * o.length) * L.k, r = seed(f, o, 29), bundle = wave(r);
      // The paint's own streaks vary smoothly across the object, the way one brush drags it.
      const { g } = smearRows(ctx, sprite, q, L, { band: o.band, from: o.from, pick: () => sample(r, o.from, o.pickSpread, o.pick), each: (row, u) => ({ len: long * edgeOf(u) * (0.4 + 0.6 * bundle(u)), fade: o.soft, width: 1.4 }) });
      M.flushLayer(ctx, g);
    },
  };

  // ======================= 6. Glitches =======================
  E.rgb = {
    family: 'Glitches', label: 'RGB split',
    note: 'Ghosting by colour channel: see-through copies in cyan, magenta and yellow trail at different distances along the path, the object itself half see-through. Works on any colour.',
    defaults: { ...COMMON, length: F(1.5), max: 160, colors: '#2fe3f0,#f04fd0,#e4f03a', alpha: 0.55, body: 0.8 },
    params: [['length', 'Split, ms of travel', 0.2, 6, 0.1], ['max', 'Split max, px', 10, 400, 5], ['alpha', 'Copies’ opacity', 0.1, 1, 0.05], ['body', 'Object’s opacity', 0.2, 1, 0.05]],
    render(ctx, f, sprite, at, o) {
      const q = at(f), L = !q.flatten && M.lineSetup(f, sprite, at, o);
      if (!L) return M.drawSprite(ctx, sprite, q);
      const off = Math.min(o.max, L.v.weight * o.length) * L.k, cols = o.colors.split(',');
      // Furthest first: cyan the full split behind, magenta half, yellow a little ahead.
      [1, 0.5, -0.15].forEach((k, i) => {
        const p = M.trackAt(L.track, off * k), dx = p.x - L.track[0].x, dy = p.y - L.track[0].y;
        M.drawSprite(ctx, sprite, { ...q, x: q.x + dx, y: q.y + dy }, o.alpha * L.k, sprite.tint(cols[i]));
      });
      M.drawSprite(ctx, sprite, q, 1 - (1 - o.body) * L.k);
    },
  };
  E.datamosh = {
    family: 'Glitches', label: 'Digital artifacts',
    note: 'Codec breakdown: the object smears into rows of blocks along the path, each row a colour picked from somewhere else in it, with a few stray blocks in glitch colours.',
    defaults: { ...COMMON, block: 18, amount: 0.85, length: F(5), from: 0.9, stray: 0.06, strayColors: '#3bd16f,#e0407e,#7a52e0' },
    params: [['block', 'Block, px', 6, 60, 1], ['amount', 'Share of rows', 0.05, 1, 0.05], ['length', 'Length, ms of travel', 1, 16, 0.5], ['from', 'Breaks from, share of the object from its front', 0.1, 1, 0.05], ['stray', 'Stray glitch-colour blocks', 0, 0.3, 0.01]],
    render(ctx, f, sprite, at, o) {
      const q = at(f), L = !q.flatten && M.lineSetup(f, sprite, at, o);
      if (!L) return M.drawSprite(ctx, sprite, q);
      const long = Math.min(o.maxLength, L.v.weight * o.length) * L.k, r = seed(f, o, 31), stray = o.strayColors.split(',');
      const { g } = smearRows(ctx, sprite, q, L, {
        band: o.block / 2, from: o.from,
        each: (row, u) => {
          if (r() > o.amount) return null;
          const dash = [];
          for (let k = 0; k < 6; k++) dash.push(o.block * (1 + Math.floor(r() * 3)), r() < 0.3 ? o.block : 0);
          return { len: long * edgeOf(u) * (0.2 + 0.8 * r()), dash, at: r(), color: r() < o.stray ? stray[Math.floor(r() * stray.length)] : null, width: 1 };
        },
      });
      M.flushLayer(ctx, g);
    },
  };
  E.pixelsort = {
    family: 'Glitches', label: 'Pixel sorting',
    note: 'Rows of pixels pulled back into streaks of their own colours, in runs of equal length; the front keeps its shape. The rows follow the path.',
    defaults: { ...COMMON, band: 3, amount: 0.75, length: F(5), depth: 0.6 },
    params: [['band', 'Row height, px', 1, 20, 1], ['amount', 'Share of rows', 0.05, 1, 0.05], ['length', 'Length, ms of travel', 1, 16, 0.5], ['depth', 'From this share of the object', 0.1, 1, 0.05]],
    render(ctx, f, sprite, at, o) {
      const q = at(f), L = !q.flatten && M.lineSetup(f, sprite, at, o);
      if (!L) return M.drawSprite(ctx, sprite, q);
      const long = Math.min(o.maxLength, L.v.weight * o.length) * L.k, r = seed(f, o, 37);
      let run = 0, len = 0, on = true;
      const { g } = smearRows(ctx, sprite, q, L, {
        band: o.band, from: o.depth,
        each: (row, u) => {
          // Sorting moves whole runs of rows together.
          if (run-- <= 0) { run = Math.floor(r() * 4); on = r() < o.amount; len = long * edgeOf(u) * (0.15 + 0.85 * r() ** 1.5); }
          return on ? { len, width: 1.05 } : null;
        },
      });
      M.flushLayer(ctx, g);
    },
  };

  // Shared parameters every effect takes; time-based ranges from frames and px/f at 60 fps to seconds and
  // px/s. Every render takes options in seconds, over its defaults, and works in frames of o.fps.
  for (const k in E) {
    E[k].params = [...E[k].params, ...COMMON_PARAMS].map((p) => {
      const u = Array.isArray(p) && M.UNITS[p[0]];
      if (!u) return p;
      const c = u === 'speed' ? V : F;
      return [p[0], p[1], c(p[2]), c(p[3]), c(p[4]), ...p.slice(5)];
    });
    const render = E[k].render;
    E[k].render = (ctx, f, sprite, at, o = {}) => render(ctx, f, sprite, at, M.inFrames({ ...E[k].defaults, ...o }));
  }
})();
