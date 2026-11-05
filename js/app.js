(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const TAU = Math.PI * 2, DEG = Math.PI / 180, MAXV = 4200, HARD_CAP = 600;

  const SHAPE_NAMES = {3:"Triangle",4:"Square",5:"Pentagon",6:"Hexagon",7:"Heptagon",8:"Octagon",
                       9:"Nonagon",10:"Decagon",11:"Hendecagon",12:"Dodecagon"};
  const MODES = {
    classic:{icon:"⚪", name:"Classic", count:3, desc:"Balls bounce around inside the spinning shape."},
    split:  {icon:"✂️", name:"Split",   count:1, desc:"Each ball splits in two every time it bounces off a wall."},
    grow:   {icon:"🎈", name:"Grow",    count:1, desc:"A ball gets bigger every time it hits a wall, until it fills the shape."},
    escape: {icon:"🚪", name:"Escape",  count:5, desc:"One wall has a gap. Balls that slip through fall away."},
    nested: {icon:"🪆", name:"Nested",  count:4, desc:"Shapes inside shapes, each spinning its own way, each with a gap to escape through."}
  };

  // ---------- State ----------
  const S = { sides:6, spin:60, gravity:900, bounce:0.92, count:3, size:12, trail:25, zoom:1,
              sound:true, nature:true, volume:50, collide:false, mode:"classic",
              gap:0.4, respawn:true, maxBalls:250, growth:1.5 };

  const canvas = $("c"), ctx = canvas.getContext("2d"), stage = $("stage");
  let W = 0, H = 0, DPR = 1, center = {x:0, y:0}, R = 200;
  let shapes = [], balls = [], pending = [];
  let paused = false, ballSeq = 0;
  const stats = { bounces:0, escaped:0 };
  let filledShown = false, allEscapedShown = false;

  // ---------- Geometry ----------
  const inradius = s => s.r * Math.cos(Math.PI / s.sides);

  function buildShapes(){
    const old = shapes, list = [];
    if (S.mode === "nested"){
      const fr = [1, 0.77, 0.55, 0.34];
      fr.forEach((f, i) => list.push({ sides:S.sides, r:R*f, dir: i % 2 ? -1 : 1,
        speedMul: 1 + i*0.4, gap: i === 0 ? 0 : S.gap, hue: (185 + i*55) % 360 }));
    } else {
      list.push({ sides:S.sides, r:R, dir:1, speedMul:1, gap: S.mode === "escape" ? S.gap : 0, hue:185 });
    }
    list.forEach((s, i) => { s.angle = old[i] ? old[i].angle : -Math.PI/2; s.flash = 0; s.omega = 0; });
    shapes = list;
  }

  function shapeSegments(s){
    const pts = [];
    for (let i = 0; i < s.sides; i++){
      const a = s.angle + i * TAU / s.sides;
      pts.push({ x: center.x + Math.cos(a)*s.r, y: center.y + Math.sin(a)*s.r });
    }
    const segs = [];
    for (let i = 0; i < s.sides; i++){
      const p1 = pts[i], p2 = pts[(i+1) % s.sides];
      if (i === 0 && s.gap > 0){
        const t1 = 0.5 - s.gap/2, t2 = 0.5 + s.gap/2;
        segs.push([p1, {x:p1.x+(p2.x-p1.x)*t1, y:p1.y+(p2.y-p1.y)*t1}]);
        segs.push([{x:p1.x+(p2.x-p1.x)*t2, y:p1.y+(p2.y-p1.y)*t2}, p2]);
      } else segs.push([p1, p2]);
    }
    return segs;
  }

  // ---------- Balls ----------
  function makeBall(x, y, vx, vy, r, hue, note){
    ballSeq++;
    return { x, y, vx, vy, r, hue, note: note ?? Math.floor(Math.random()*SCALE.length),
             trail:[], cool:0, flash:0, escaped:false, filled:false };
  }

  function spawnBall(x, y){
    const inner = shapes[shapes.length - 1];
    if (x === undefined){
      const lim = Math.max(0, inradius(inner) - S.size - 4) * 0.6;
      const a = Math.random()*TAU, d = Math.random()*lim;
      x = center.x + Math.cos(a)*d; y = center.y + Math.sin(a)*d;
    }
    const va = Math.random()*TAU, sp = 200 + Math.random()*300;
    return makeBall(x, y, Math.cos(va)*sp, Math.sin(va)*sp, S.size, (ballSeq*47 + 180) % 360);
  }

  function reset(){
    balls = []; pending = [];
    stats.bounces = 0; stats.escaped = 0;
    filledShown = false; allEscapedShown = false;
    buildShapes();
    for (let i = 0; i < S.count; i++) balls.push(spawnBall());
  }

  // ---------- Physics ----------
  function collideSeg(b, a, c, s){
    const ex = c.x - a.x, ey = c.y - a.y, len2 = ex*ex + ey*ey;
    if (len2 < 1e-6) return;
    let t = ((b.x - a.x)*ex + (b.y - a.y)*ey) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = a.x + ex*t, qy = a.y + ey*t;
    const dx = b.x - qx, dy = b.y - qy, d2 = dx*dx + dy*dy;
    if (d2 >= b.r*b.r) return;

    let nx, ny;
    const d = Math.sqrt(d2);
    if (d < 1e-6){ nx = center.x - qx; ny = center.y - qy; const l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l; }
    else { nx = dx/d; ny = dy/d; }

    // velocity of the wall at the contact point (it's spinning)
    const wvx = -s.omega * (qy - center.y), wvy = s.omega * (qx - center.x);
    const rvx = b.vx - wvx, rvy = b.vy - wvy;
    const vn = rvx*nx + rvy*ny;

    b.x = qx + nx*b.r; b.y = qy + ny*b.r;

    if (vn < 0){
      const tx = -ny, ty = nx, vt = rvx*tx + rvy*ty;
      const newVn = -vn * S.bounce, newVt = vt * 0.98;   // slight friction lets spinning walls "throw" balls
      b.vx = wvx + nx*newVn + tx*newVt;
      b.vy = wvy + ny*newVn + ty*newVt;
      onBounce(b, s, -vn);
    }
  }

  // Safety net so nothing leaks out of a closed outer shape
  function contain(b, s){
    const ap = inradius(s);
    for (let i = 0; i < s.sides; i++){
      const a = s.angle + (i + 0.5) * TAU / s.sides;
      const nx = Math.cos(a), ny = Math.sin(a);
      const d = (b.x - center.x)*nx + (b.y - center.y)*ny;
      if (d > ap){
        b.x -= nx*(d - ap + b.r); b.y -= ny*(d - ap + b.r);
        const vn = b.vx*nx + b.vy*ny;
        if (vn > 0){ b.vx -= (1 + S.bounce)*vn*nx; b.vy -= (1 + S.bounce)*vn*ny; }
      }
    }
  }

  function onBounce(b, s, impact){
    if (impact < 35) return;                 // ignore resting contact
    stats.bounces++; s.flash = 1; b.flash = 1;
    playBounce(b, impact);
    if (stats.bounces % 3 === 0) playNatureDrop();
    if (b.cool > 0) return;
    b.cool = 0.12;

    if (S.mode === "split"){
      if (balls.length + pending.length < Math.min(S.maxBalls, HARD_CAP)){
        const ang = 0.35, c = Math.cos(ang), sn = Math.sin(ang), vx = b.vx, vy = b.vy;
        b.vx = vx*c - vy*sn; b.vy = vx*sn + vy*c;
        const k = makeBall(b.x + (Math.random()-.5), b.y + (Math.random()-.5),
                           vx*c + vy*sn, -vx*sn + vy*c, b.r, (b.hue + 30) % 360, (b.note + 1) % SCALE.length);
        k.cool = 0.12; pending.push(k);
      }
    } else if (S.mode === "grow"){
      const cap = inradius(shapes[0]) * 0.96;
      b.r = Math.min(cap, b.r + S.growth);
      if (b.r >= cap && !filledShown){ filledShown = true; toast("🎉 The ball filled the whole shape! Press R to go again."); }
    }
  }

  function onEscape(){
    if (S.mode === "escape" && S.respawn && balls.length + pending.length < HARD_CAP) pending.push(spawnBall());
  }

  function ballCollisions(){
    const n = balls.length;
    for (let i = 0; i < n; i++){
      const a = balls[i]; if (a.escaped) continue;
      for (let j = i + 1; j < n; j++){
        const b = balls[j]; if (b.escaped) continue;
        const dx = b.x - a.x, dy = b.y - a.y, rr = a.r + b.r, d2 = dx*dx + dy*dy;
        if (d2 >= rr*rr || d2 < 1e-6) continue;
        const d = Math.sqrt(d2), nx = dx/d, ny = dy/d;
        const ma = a.r*a.r, mb = b.r*b.r, tot = ma + mb, ov = rr - d;
        a.x -= nx*ov*(mb/tot); a.y -= ny*ov*(mb/tot);
        b.x += nx*ov*(ma/tot); b.y += ny*ov*(ma/tot);
        const vrel = (b.vx - a.vx)*nx + (b.vy - a.vy)*ny;
        if (vrel < 0){
          const jimp = -(1 + Math.min(S.bounce, 1)) * vrel / (1/ma + 1/mb);
          a.vx -= jimp*nx/ma; a.vy -= jimp*ny/ma;
          b.vx += jimp*nx/mb; b.vy += jimp*ny/mb;
        }
      }
    }
  }

  function step(h){
    for (const s of shapes){ s.omega = S.spin * DEG * s.dir * s.speedMul; s.angle += s.omega * h; }
    const geo = shapes.map(shapeSegments);
    const outer = shapes[0];

    for (const b of balls){
      b.vy += S.gravity * h;
      b.x += b.vx * h; b.y += b.vy * h;
      b.cool -= h;
      if (b.escaped) continue;

      for (let si = 0; si < shapes.length; si++){
        const segs = geo[si];
        for (let k = 0; k < segs.length; k++) collideSeg(b, segs[k][0], segs[k][1], shapes[si]);
      }
      if (outer.gap === 0) contain(b, outer);
      else if (Math.hypot(b.x - center.x, b.y - center.y) > outer.r + b.r + 2){
        b.escaped = true; stats.escaped++; onEscape();
      }
      const sp = Math.hypot(b.vx, b.vy);
      if (sp > MAXV){ b.vx *= MAXV/sp; b.vy *= MAXV/sp; }
    }
    if (S.collide) ballCollisions();
    if (pending.length){ balls.push(...pending); pending.length = 0; }
  }

  function postFrame(){
    for (const s of shapes) s.flash = Math.max(0, s.flash - 0.06);
    for (const b of balls){
      b.flash = Math.max(0, b.flash - 0.08);
      if (S.trail > 0){
        b.trail.push({x:b.x, y:b.y});
        while (b.trail.length > S.trail) b.trail.shift();
      } else if (b.trail.length) b.trail.length = 0;
    }
    balls = balls.filter(b => !(b.escaped && (b.y > H + 80 || b.x < -80 || b.x > W + 80)));
    if (S.mode === "escape" && balls.length === 0 && !allEscapedShown){
      allEscapedShown = true; toast("🚪 Every ball escaped! Press R to reset.");
    }
  }

  // ---------- Rendering ----------
  function drawBackground(){
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#05060f";
    ctx.fillRect(0, 0, W, H);
    const g = ctx.createRadialGradient(center.x, center.y, 0, center.x, center.y, Math.max(W, H)*0.7);
    g.addColorStop(0, "rgba(40,55,140,0.22)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }

  function drawShape(s){
    const segs = shapeSegments(s), L = 58 + s.flash*30;
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    for (const [w, a] of [[16, .10], [7, .28], [2.6, 1]]){
      ctx.strokeStyle = `hsla(${s.hue},100%,${L}%,${a})`;
      ctx.lineWidth = w;
      ctx.beginPath();
      for (const [p, q] of segs){ ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); }
      ctx.stroke();
    }
  }

  function drawBall(b){
    const t = b.trail, n = t.length;
    if (n > 1){
      ctx.lineCap = "round";
      const wmax = Math.min(b.r*2, 50);
      for (let i = 1; i < n; i++){
        const k = i / n;
        ctx.strokeStyle = `hsla(${b.hue},100%,60%,${k*0.55})`;
        ctx.lineWidth = Math.max(1, wmax*k*0.85);
        ctx.beginPath(); ctx.moveTo(t[i-1].x, t[i-1].y); ctx.lineTo(t[i].x, t[i].y); ctx.stroke();
      }
    }
    const gr = b.r * 3;
    const g = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, gr);
    g.addColorStop(0, `hsla(${b.hue},100%,65%,${0.5 + 0.35*b.flash})`);
    g.addColorStop(1, `hsla(${b.hue},100%,50%,0)`);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(b.x, b.y, gr, 0, TAU); ctx.fill();

    ctx.fillStyle = `hsl(${b.hue},100%,${60 + b.flash*20}%)`;
    ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, TAU); ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.8)";
    ctx.beginPath(); ctx.arc(b.x, b.y, b.r*0.45, 0, TAU); ctx.fill();
  }

  function render(){
    ctx.save();
    ctx.translate(center.x, center.y);
    ctx.scale(S.zoom, S.zoom);
    ctx.translate(-center.x, -center.y);
    drawBackground();
    ctx.globalCompositeOperation = "lighter";
    for (const s of shapes) drawShape(s);
    for (const b of balls) drawBall(b);
    ctx.globalCompositeOperation = "source-over";
    ctx.restore();
  }

  // ---------- Sound ----------
  const SCALE = [0, 3, 5, 7, 10, 12, 15, 17, 19, 22]; // minor pentatonic
  let actx = null, master = null, recDest = null, lastSound = 0;

  function ensureAudio(){
    try{
      if (!actx){
        actx = new (window.AudioContext || window.webkitAudioContext)();
        master = actx.createGain();
        master.gain.value = S.volume / 100;
        master.connect(actx.destination);
      }
      if (actx.state === "suspended") actx.resume();
      if (S.nature) startNature();
    }catch(e){ /* audio not available */ }
  }

  function playBounce(b, impact){
    if (!S.sound || !actx || actx.state !== "running") return;
    const now = actx.currentTime;
    if (now - lastSound < 0.035) return;
    lastSound = now;
    const base = 260 * Math.pow(12 / Math.max(4, b.r), 0.5);       // bigger ball = lower pitch
    const f = Math.min(2200, Math.max(55, base * Math.pow(2, SCALE[b.note % SCALE.length] / 12)));
    const v = 0.06 + 0.3 * Math.min(1, impact / 900);
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = "triangle"; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(v, now + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);
    o.connect(g); g.connect(master);
    o.start(now); o.stop(now + 0.3);
  }

  // A quiet, dependency-free nature bed: filtered rain-like noise with a slow wind swell.
  let natureBed = null;
  function startNature(){
    if (!S.nature || !actx || natureBed) return;
    const noise = actx.createBufferSource(), buf = actx.createBuffer(1, actx.sampleRate * 2, actx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    noise.buffer = buf; noise.loop = true;
    const rain = actx.createBiquadFilter(), wind = actx.createBiquadFilter(), gain = actx.createGain();
    rain.type = "bandpass"; rain.frequency.value = 1450; rain.Q.value = 0.7;
    wind.type = "lowpass"; wind.frequency.value = 360;
    gain.gain.value = 0.018 * (S.volume / 100);
    const lfo = actx.createOscillator(), lfoGain = actx.createGain();
    lfo.frequency.value = 0.075; lfoGain.gain.value = 0.012;
    lfo.connect(lfoGain); lfoGain.connect(gain.gain);
    noise.connect(rain); noise.connect(wind); rain.connect(gain); wind.connect(gain); gain.connect(master);
    noise.start(); lfo.start(); natureBed = {noise, lfo, gain};
  }
  function stopNature(){
    if (!natureBed) return;
    natureBed.noise.stop(); natureBed.lfo.stop(); natureBed = null;
  }
  function playNatureDrop(){
    if (!S.nature || !actx || actx.state !== "running") return;
    const now = actx.currentTime, o = actx.createOscillator(), g = actx.createGain();
    o.type = "sine"; o.frequency.setValueAtTime(900 + Math.random()*500, now);
    o.frequency.exponentialRampToValueAtTime(420, now + 0.16);
    g.gain.setValueAtTime(0.0001, now); g.gain.exponentialRampToValueAtTime(0.045, now + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.18); o.connect(g); g.connect(master);
    o.start(now); o.stop(now + 0.2);
  }

  // ---------- Main loop ----------
  let last = performance.now(), frames = 0, fpsT = 0, hudT = 0;
  function frame(now){
    let dt = (now - last) / 1000; last = now;
    if (dt > 1/30) dt = 1/30;

    if (!paused){
      let maxV = 0, minR = 1e9, wall = 0;
      for (const b of balls){ const v = Math.hypot(b.vx, b.vy); if (v > maxV) maxV = v; if (b.r < minR) minR = b.r; }
      for (const s of shapes) wall = Math.max(wall, Math.abs(S.spin*DEG*s.speedMul) * s.r);
      if (minR === 1e9) minR = S.size;
      const travel = (maxV + wall) * dt;
      const sub = Math.min(40, Math.max(4, Math.ceil(travel / (minR * 0.5))));
      const h = dt / sub;
      for (let i = 0; i < sub; i++) step(h);
      postFrame();
    }
    render();

    frames++; fpsT += dt; hudT += dt;
    if (hudT > 0.25){
      hudT = 0;
      $("hBalls").textContent = balls.length;
      $("hBounces").textContent = stats.bounces.toLocaleString();
      $("hEsc").textContent = stats.escaped;
      if (fpsT > 0) $("hFps").textContent = Math.round(frames / fpsT);
      frames = 0; fpsT = 0;
    }
    requestAnimationFrame(frame);
  }

  function resize(){
    const r = stage.getBoundingClientRect();
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = r.width; H = r.height;
    canvas.width = Math.max(1, Math.round(W*DPR)); canvas.height = Math.max(1, Math.round(H*DPR));
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    center = { x: W/2, y: H/2 };
    R = Math.min(W, H) * 0.42;
    buildShapes();
    balls.forEach(b => b.trail.length = 0);
  }

  // ---------- UI ----------
  const RANGES = [
    ["sides",    v => `${SHAPE_NAMES[v]} (${v})`, () => {
        buildShapes(); updateBadge();
        if (S.mode === "grow"){ const cap = inradius(shapes[0])*0.96; balls.forEach(b => b.r = Math.min(b.r, cap)); }
      }],
    ["spin",     v => `${v > 0 ? "+" : ""}${v}°/s`],
    ["gravity",  v => v === 0 ? "Zero-G" : `${v}`],
    ["bounce",   v => v.toFixed(2)],
    ["count",    v => v, () => reset()],
    ["size",     v => `${v}px`, () => { if (S.mode !== "grow") balls.forEach(b => b.r = S.size); }],
    ["trail",    v => v === 0 ? "Off" : v],
    ["volume",   v => `${v}%`, () => { if (master) master.gain.value = S.volume/100; }],
    ["gap",      v => `${Math.round(v*100)}%`, () => buildShapes()],
    ["maxBalls", v => v],
    ["growth",   v => `+${v.toFixed(1)}px`]
  ];
  const TOGGLES = ["sound", "nature", "collide", "respawn"];

  RANGES.forEach(([k, fmt, cb]) => {
    const el = $(k);
    el.addEventListener("input", () => {
      S[k] = parseFloat(el.value);
      $(k + "Val").textContent = fmt(S[k]);
      cb && cb();
    });
  });
  TOGGLES.forEach(k => $(k).addEventListener("change", e => {
    S[k] = e.target.checked;
    if ((k === "sound" || k === "nature") && e.target.checked){ ensureAudio(); startNature(); }
    if (k === "nature" && !S.nature) stopNature();
  }));

  function syncUI(){
    RANGES.forEach(([k, fmt]) => { $(k).value = S[k]; $(k + "Val").textContent = fmt(S[k]); });
    TOGGLES.forEach(k => $(k).checked = S[k]);
    document.querySelectorAll(".chip").forEach(c => c.classList.toggle("active", c.dataset.mode === S.mode));
    $("modeDesc").textContent = MODES[S.mode].desc;
    document.querySelectorAll("[data-modes]").forEach(el =>
      el.style.display = el.dataset.modes.split(" ").includes(S.mode) ? "" : "none");
    $("hEscWrap").style.display = S.mode === "escape" ? "" : "none";
    updateBadge();
  }

  function updateBadge(){
    $("badge").textContent = `${MODES[S.mode].icon} ${SHAPE_NAMES[S.sides]} · ${MODES[S.mode].name}`;
  }

  // mode chips
  const modesEl = $("modes");
  Object.entries(MODES).forEach(([key, m]) => {
    const b = document.createElement("button");
    b.className = "chip"; b.dataset.mode = key;
    b.innerHTML = `<span class="ic">${m.icon}</span>${m.name}`;
    b.addEventListener("click", () => setMode(key));
    modesEl.appendChild(b);
  });

  function setMode(m){
    S.mode = m;
    S.count = MODES[m].count;
    if (m === "nested" && S.size > 10) S.size = 9;
    syncUI(); reset();
  }

  let toastTimer = null;
  function toast(msg){
    const t = $("toast");
    t.textContent = msg; t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 2800);
  }

  function togglePause(){
    paused = !paused;
    $("btnPause").textContent = paused ? "▶ Play" : "⏸ Pause";
    $("pausedTag").style.display = paused ? "flex" : "none";
    last = performance.now();
  }
  function addBall(){
    if (balls.length >= HARD_CAP) return toast("That's the maximum number of balls.");
    balls.push(spawnBall());
  }
  function shake(){
    balls.forEach(b => { if (!b.escaped){ b.vx += (Math.random()-.5)*1400; b.vy += (Math.random()-.5)*1400; } });
  }
  function reverse(){ S.spin = -S.spin; syncUI(); }
  function randomize(){
    const rnd = (a, b, st) => Math.round((a + Math.random()*(b - a)) / st) * st;
    S.sides = rnd(3, 12, 1);
    S.spin = rnd(-240, 240, 5) || 60;
    S.gravity = rnd(200, 1600, 50);
    S.bounce = +(0.8 + Math.random()*0.22).toFixed(2);
    S.trail = rnd(8, 60, 1);
    S.size = rnd(6, 16, 1);
    const keys = Object.keys(MODES);
    setMode(keys[Math.floor(Math.random()*keys.length)]);
    toast(`🎲 ${SHAPE_NAMES[S.sides]} · ${MODES[S.mode].name}`);
  }

  $("btnPause").onclick = togglePause;
  $("btnReset").onclick = reset;
  $("btnAdd").onclick = addBall;
  $("btnShake").onclick = shake;
  $("btnReverse").onclick = reverse;
  $("btnRandom").onclick = randomize;

  canvas.addEventListener("pointerdown", e => {
    if (e.pointerType === "touch") return;
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    if (Math.hypot(x - center.x, y - center.y) < shapes[0].r && balls.length < HARD_CAP){
      balls.push(spawnBall(x, y));
    }
  });

  let pinchStart = 0, pinchZoom = S.zoom;
  const touchDistance = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  canvas.addEventListener("touchstart", e => {
    if (e.touches.length === 2){ pinchStart = touchDistance(e.touches[0], e.touches[1]); pinchZoom = S.zoom; e.preventDefault(); }
  }, {passive:false});
  canvas.addEventListener("touchmove", e => {
    if (e.touches.length === 2 && pinchStart){
      S.zoom = Math.max(0.55, Math.min(2.5, pinchZoom * touchDistance(e.touches[0], e.touches[1]) / pinchStart));
      e.preventDefault();
    }
  }, {passive:false});
  canvas.addEventListener("touchend", e => { if (e.touches.length < 2) pinchStart = 0; }, {passive:false});

  document.addEventListener("pointerdown", ensureAudio);
  document.addEventListener("keydown", e => {
    ensureAudio();
    const tag = (e.target.tagName || "").toUpperCase();
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    switch (e.key){
      case " ": e.preventDefault(); togglePause(); break;
      case "r": case "R": reset(); break;
      case "b": case "B": addBall(); break;
      case "s": case "S": shake(); break;
      case "m": case "M": S.sound = !S.sound; syncUI(); toast(S.sound ? "🔊 Sound on" : "🔇 Sound off"); break;
      case "ArrowLeft":  e.preventDefault(); S.sides = Math.max(3, S.sides - 1); syncUI(); buildShapes(); break;
      case "ArrowRight": e.preventDefault(); S.sides = Math.min(12, S.sides + 1); syncUI(); buildShapes(); break;
      case "ArrowUp":    e.preventDefault(); S.spin = Math.min(360, S.spin + 10); syncUI(); break;
      case "ArrowDown":  e.preventDefault(); S.spin = Math.max(-360, S.spin - 10); syncUI(); break;
    }
  });

  // ---------- Recording ----------
  let recorder = null, chunks = [], recStart = 0, recTimer = null;
  const stamp = () => new Date().toISOString().slice(0,19).replace(/[:T]/g, "-");
  function download(url, name){
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function startRec(){
    if (!window.MediaRecorder || !canvas.captureStream) return toast("Recording isn't supported in this browser.");
    const stream = canvas.captureStream(60);
    if ($("recAudio").checked){
      ensureAudio();
      if (actx){
        if (!recDest){ recDest = actx.createMediaStreamDestination(); master.connect(recDest); }
        recDest.stream.getAudioTracks().forEach(t => stream.addTrack(t));
      }
    }
    const types = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"];
    const mime = types.find(t => MediaRecorder.isTypeSupported(t)) || "";
    try{
      recorder = new MediaRecorder(stream, mime ? { mimeType:mime, videoBitsPerSecond:8e6 } : undefined);
    }catch(e){ return toast("Couldn't start recording."); }
    chunks = [];
    recorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = () => {
      const type = recorder.mimeType || "video/webm";
      const blob = new Blob(chunks, { type });
      download(URL.createObjectURL(blob), `bounce-${stamp()}.${type.includes("mp4") ? "mp4" : "webm"}`);
      toast("💾 Video saved");
    };
    recorder.start(200);
    recStart = performance.now();
    $("btnRec").textContent = "⏹ Stop Recording"; $("btnRec").classList.add("on");
    $("recDot").classList.add("on");
    recTimer = setInterval(() => {
      const s = Math.floor((performance.now() - recStart) / 1000);
      $("recTime").textContent = `Recording ${String(Math.floor(s/60)).padStart(2,"0")}:${String(s%60).padStart(2,"0")}`;
    }, 250);
  }
  function stopRec(){
    if (recorder && recorder.state !== "inactive") recorder.stop();
    clearInterval(recTimer);
    $("btnRec").textContent = "⏺ Start Recording"; $("btnRec").classList.remove("on");
    $("recDot").classList.remove("on");
    $("recTime").textContent = "Not recording";
  }
  $("btnRec").onclick = () => (recorder && recorder.state === "recording") ? stopRec() : startRec();
  $("btnShot").onclick = () => canvas.toBlob(b => { download(URL.createObjectURL(b), `bounce-${stamp()}.png`); toast("📸 Screenshot saved"); });

  // ---------- Boot ----------
  new ResizeObserver(resize).observe(stage);
  resize();
  syncUI();
  reset();
  requestAnimationFrame(frame);
})();
