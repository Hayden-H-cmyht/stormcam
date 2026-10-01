/* StormCam 风暴相机 — 应用逻辑
 * 相机 → WebGL 实时调色 → 拍摄(JPEG)/录制(WebM) → 本地相册(IndexedDB)
 */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const LUT = window.StormLUT, GL = window.StormGL;

  /* ---------------- 全局状态 ---------------- */
  const S = {
    running: false, demo: false,
    facing: 'user', mirror: true,
    mode: 'photo',
    lut: 'storm', log: true,
    exposure: 0, temp: 0, tint: 0, iso: 100, shutterAngle: 180, zoom: 1,
    ratio: 'native',
    res: 1080, fps: 24, mic: true,
    monitor: 0, grid: false, hist: false,
    recording: false, recStart: 0,
    w: 1280, h: 720,
  };
  let engine, videoStream = null, rec = null, recChunks = [], actx = null, anL = null, anR = null;
  let items = [];            // 相册条目 {id,type,blob,ext,ts,url,...}
  let lastHist = 0, lastMeter = 0;

  const video = $('video');
  const demoCanvas = document.createElement('canvas');
  demoCanvas.width = 1280; demoCanvas.height = 720;

  /* ---------------- 相册 (IndexedDB) ---------------- */
  function idb() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('stormcam', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('media', { keyPath: 'id' });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function loadGallery() {
    try {
      const db = await idb();
      const all = await new Promise((res, rej) => {
        const rq = db.transaction('media').objectStore('media').getAll();
        rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
      });
      items = all.sort((a, b) => b.ts - a.ts);
      items.forEach(m => m.url = URL.createObjectURL(m.blob));
    } catch (e) { items = []; }
    renderGallery(); updateThumb();
  }
  async function addMedia(m) {
    m.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    m.ts = Date.now();
    m.url = URL.createObjectURL(m.blob);
    items.unshift(m);
    try {
      const db = await idb();
      await new Promise((res, rej) => {
        const tx = db.transaction('media', 'readwrite');
        tx.objectStore('media').put({ ...m, url: undefined });
        tx.oncomplete = res; tx.onerror = () => rej(tx.error);
      });
    } catch (e) { /* 无 IDB 则仅内存 */ }
    renderGallery(); updateThumb(); toast('已保存到相册');
  }
  async function delMedia(m) {
    items = items.filter(x => x.id !== m.id);
    try {
      const db = await idb();
      const tx = db.transaction('media', 'readwrite');
      tx.objectStore('media').delete(m.id);
    } catch (e) { }
    URL.revokeObjectURL(m.url);
    renderGallery(); updateThumb(); closeViewer();
  }
  function download(m) {
    const a = document.createElement('a');
    const d = new Date(m.ts), p = n => String(n).padStart(2, '0');
    a.href = m.url;
    a.download = `StormCam_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${m.ext}`;
    a.click();
  }

  /* ---------------- 相机 ---------------- */
  async function startCamera() {
    stopStream();
    const vf = { facingMode: S.facing, width: { ideal: S.res }, height: { ideal: S.res }, frameRate: { ideal: S.fps } };
    try {
      videoStream = await navigator.mediaDevices.getUserMedia({ video: vf, audio: S.mic ? { echoCancellation: false } : false });
    } catch (e1) {
      if (S.mic) {
        try { videoStream = await navigator.mediaDevices.getUserMedia({ video: vf }); S.mic = false; }
        catch (e2) { throw e2; }
      } else throw e1;
    }
    video.srcObject = videoStream;
    await video.play().catch(() => { });
    const st = videoStream.getVideoTracks()[0].getSettings();
    S.w = st.width || video.videoWidth || 1280;
    S.h = st.height || video.videoHeight || 720;
    if (videoStream.getAudioTracks().length) setupAudio();
    S.mirror = S.facing === 'user';
    S.demo = false;
    onStreamReady();
  }
  function stopStream() {
    if (videoStream) videoStream.getTracks().forEach(t => t.stop());
    videoStream = null; anL = anR = null;
    if (actx) { try { actx.close(); } catch (e) { } actx = null; }
  }
  function setupAudio() {
    try {
      actx = new (window.AudioContext || window.webkitAudioContext)();
      const src = actx.createMediaStreamSource(videoStream);
      const split = actx.createChannelSplitter(2);
      anL = actx.createAnalyser(); anR = actx.createAnalyser();
      anL.fftSize = anR.fftSize = 512;
      src.connect(split); split.connect(anL, 0); split.connect(anR, 1);
    } catch (e) { anL = anR = null; }
  }
  function startDemo() {
    stopStream();
    S.demo = true; S.w = demoCanvas.width; S.h = demoCanvas.height;
    onStreamReady();
  }
  function onStreamReady() {
    S.running = true;
    $('gate').classList.add('hidden');
    ['hud', 'ctrl', 'leftStrip', 'rightStrip', 'lutRow'].forEach(id => $(id).classList.remove('hidden'));
    requestAnimationFrame(loop);
    keepAwake();
    updateHud();
  }

  /* ---------------- 移动端:亮屏锁 / PWA 安装 / 双指变焦 ---------------- */
  let wakeLock = null;
  async function keepAwake() {
    try {
      if ('wakeLock' in navigator && S.running && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch (e) { /* 不支持则忽略 */ }
  }
  let deferredPrompt = null;
  function setupInstallPrompt() {
    const btn = $('installBtn');
    if (window.matchMedia('(display-mode: standalone)').matches
      || (navigator.getInstalledRelatedApps && false)) return;
    window.addEventListener('beforeinstallprompt', e => {
      e.preventDefault();
      deferredPrompt = e;
      btn.classList.remove('hidden');
    });
    btn.onclick = async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      const c = await deferredPrompt.userChoice;
      if (c && c.outcome === 'accepted') toast('已安装,可从主屏幕打开');
      deferredPrompt = null;
      btn.classList.add('hidden');
    };
  }
  function setupPinchZoom() {
    const stage = $('stage');
    const ptrs = new Map();
    let pinchD = 0;
    const dist = () => {
      const [a, b] = [...ptrs.values()];
      return Math.hypot(a[0] - b[0], a[1] - b[1]);
    };
    const setZoomUI = () => {
      if (openParam === 'zoom') { $('paramRange').value = S.zoom; $('paramVal').textContent = '×' + S.zoom.toFixed(1); }
    };
    stage.addEventListener('pointerdown', e => {
      ptrs.set(e.pointerId, [e.clientX, e.clientY]);
      if (ptrs.size === 2) pinchD = dist();
    });
    stage.addEventListener('pointermove', e => {
      if (!ptrs.has(e.pointerId)) return;
      ptrs.set(e.pointerId, [e.clientX, e.clientY]);
      if (ptrs.size === 2 && pinchD) {
        const d = dist();
        S.zoom = Math.min(5, Math.max(1, S.zoom * d / pinchD));
        pinchD = d;
        setZoomUI();
        e.preventDefault();
      }
    }, { passive: false });
    const drop = e => { ptrs.delete(e.pointerId); pinchD = 0; };
    stage.addEventListener('pointerup', drop);
    stage.addEventListener('pointercancel', drop);
  }

  /* ---------------- 演示信号源 ---------------- */
  function drawDemo(t) {
    const c = demoCanvas, x = c.getContext('2d'), W = c.width, H = c.height;
    const h = (t / 12000) % 1;
    const g = x.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, `hsl(${h * 360},45%,18%)`);
    g.addColorStop(0.5, `hsl(${(h * 360 + 40) % 360},55%,38%)`);
    g.addColorStop(1, `hsl(${(h * 360 + 80) % 360},40%,12%)`);
    x.fillStyle = g; x.fillRect(0, 0, W, H);
    const sx = W * 0.5 + Math.sin(t / 3000) * W * 0.3, sy = H * 0.35;
    const rg = x.createRadialGradient(sx, sy, 10, sx, sy, H * 0.5);
    rg.addColorStop(0, 'rgba(255,220,160,.95)'); rg.addColorStop(1, 'rgba(255,180,80,0)');
    x.fillStyle = rg; x.fillRect(0, 0, W, H);
    const bars = ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0'];
    bars.forEach((col, i) => { x.fillStyle = col; x.fillRect(i * W / bars.length, H * 0.72, W / bars.length + 1, H * 0.1); });
    for (let i = 0; i < 16; i++) {
      const v = Math.round(i / 15 * 255);
      x.fillStyle = `rgb(${v},${v},${v})`;
      x.fillRect(i * W / 16, H * 0.84, W / 16 + 1, H * 0.07);
    }
    x.fillStyle = '#db9d70';
    x.beginPath(); x.ellipse(W * 0.18, H * 0.45, W * 0.07, H * 0.13, 0, 0, 7); x.fill();
    x.strokeStyle = 'rgba(255,255,255,.55)'; x.lineWidth = 3;
    for (let i = 0; i < 8; i++) {
      x.beginPath();
      x.moveTo(W * 0.55 + i * W * 0.025 + Math.sin(t / 800 + i) * 10, H * 0.12);
      x.lineTo(W * 0.58 + i * W * 0.025 + Math.sin(t / 800 + i) * 10, H * 0.5);
      x.stroke();
    }
  }

  /* ---------------- 主渲染循环 ---------------- */
  function ratioAspect() {
    // 手机竖屏时把横向画幅转为竖向(9:16 / 竖宽银幕),让画面铺满屏幕
    const portrait = window.innerHeight > window.innerWidth;
    let a;
    if (S.ratio === 'native') a = S.w / S.h;
    else if (S.ratio === '16:9') a = 16 / 9;
    else if (S.ratio === '2.35:1') a = 2.35;
    else a = 1;
    return portrait && a > 1 ? 1 / a : a;
  }
  function buildParams(t) {
    const src = S.demo ? demoCanvas : video;
    const sw = S.demo ? demoCanvas.width : (video.videoWidth || S.w);
    const sh = S.demo ? demoCanvas.height : (video.videoHeight || S.h);
    S.w = sw; S.h = sh;
    engine.setSourceSize(sw, sh);
    const a = ratioAspect();
    const cap = S.res === 1080 ? 1920 : 1280;
    const longEdge = Math.min(cap, Math.max(sw, sh));
    // 竖构图时长边是高,横构图时长边是宽
    if (a >= 1) engine.setSize(longEdge, Math.max(2, Math.round(longEdge / a)));
    else engine.setSize(Math.max(2, Math.round(longEdge * a)), longEdge);
    let us = [1, 1], uo = [0, 0];
    const sa = sw / sh;
    if (Math.abs(a - sa) > 0.001) {
      if (sa > a) { us[0] = a / sa; uo[0] = (1 - us[0]) / 2; }
      else { us[1] = sa / a; uo[1] = (1 - us[1]) / 2; }
    }
    if (S.zoom > 1.001) {
      const c = [uo[0] + us[0] / 2, uo[1] + us[1] / 2];
      us = [us[0] / S.zoom, us[1] / S.zoom];
      uo = [c[0] - us[0] / 2, c[1] - us[1] / 2];
    }
    return {
      source: src, srcW: sw, srcH: sh,
      log: S.log && S.lut !== 'bypass',
      exposure: S.exposure, temp: S.temp, tint: S.tint,
      sat: 1, con: 1,
      isoGain: S.iso / 100,
      grain: Math.max(0, S.iso - 400) / 6000 * 0.14,
      blur: (360 - S.shutterAngle) / 360 * 0.85,
      time: t / 1000,
      mirror: S.mirror, zebra: 0.95, peak: 0.16,
      mode: S.monitor, uvScale: us, uvOff: uo,
    };
  }
  function loop(t) {
    if (!S.running) return;
    requestAnimationFrame(loop);
    if (S.demo) drawDemo(t);
    if (S.demo || video.readyState >= 2) {
      engine.uploadFrame(S.demo ? demoCanvas : video);
      engine.render(buildParams(t));
    }
    if (t - lastMeter > 100) { lastMeter = t; meters(); }
    if (S.hist && t - lastHist > 250) { lastHist = t; updateHist(); }
    if (S.recording) updateTimecode();
  }

  /* ---------------- 拍摄 / 录制 ---------------- */
  function flashFx() {
    const f = $('flash');
    f.classList.remove('anim'); void f.offsetWidth; f.classList.add('anim');
  }
  async function shoot() {
    if (!S.running || S.recording) return;
    flashFx();
    const c = engine.cleanCanvas;
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.95));
    if (!blob) { toast('拍摄失败'); return; }
    await addMedia({ type: 'photo', blob, ext: 'jpg', w: c.width, h: c.height, lut: S.lut, log: S.log });
  }
  function startRec() {
    if (!S.running) return;
    const stream = engine.cleanCanvas.captureStream(S.fps);
    if (videoStream) videoStream.getAudioTracks().forEach(t => stream.addTrack(t));
    const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      .find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m));
    try {
      rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 10000000 } : undefined);
    } catch (e) { toast('此浏览器不支持录制'); return; }
    recChunks = [];
    rec.ondataavailable = e => { if (e.data && e.data.size) recChunks.push(e.data); };
    rec.onstop = async () => {
      const blob = new Blob(recChunks, { type: rec.mimeType || 'video/webm' });
      if (blob.size) await addMedia({ type: 'video', blob, ext: 'webm', w: engine.cleanCanvas.width, h: engine.cleanCanvas.height, lut: S.lut, log: S.log });
    };
    rec.start(250);
    S.recording = true; S.recStart = performance.now();
    $('shutter').classList.add('rec');
    $('recDot').classList.remove('hidden');
    updateHud();
  }
  function stopRec() {
    if (rec && rec.state !== 'inactive') rec.stop();
    S.recording = false;
    $('shutter').classList.remove('rec');
    $('recDot').classList.add('hidden');
    $('tc').textContent = 'STBY 00:00:00:00';
  }
  function toggleShutter() { S.mode === 'video' ? (S.recording ? stopRec() : startRec()) : shoot(); }
  function updateTimecode() {
    const el = Math.floor(performance.now() - S.recStart) / 1000;
    const p = n => String(n).padStart(2, '0');
    const ff = Math.floor((el % 1) * S.fps);
    $('tc').textContent = `REC ${p(Math.floor(el / 3600))}:${p(Math.floor(el / 60) % 60)}:${p(Math.floor(el) % 60)}:${p(ff)}`;
  }

  /* ---------------- 仪表 ---------------- */
  function meters() {
    const mL = $('mL'), mR = $('mR');
    if (!anL || !anR) { mL.style.width = '0%'; mR.style.width = '0%'; return; }
    const buf = new Float32Array(anL.fftSize);
    anL.getFloatTimeDomainData(buf);
    const l = rms(buf);
    anR.getFloatTimeDomainData(buf);
    const r = rms(buf);
    const db = v => Math.max(0, Math.min(100, (20 * Math.log10(v || 1e-6) + 60) / 60 * 100));
    mL.style.width = db(l) + '%'; mR.style.width = db(r) + '%';
  }
  function rms(b) {
    let s = 0; for (let i = 0; i < b.length; i++) s += b[i] * b[i];
    return Math.sqrt(s / b.length);
  }
  const histSrc = document.createElement('canvas');
  histSrc.width = 96; histSrc.height = 54;
  function updateHist() {
    const x = histSrc.getContext('2d', { willReadFrequently: true });
    try { x.drawImage(engine.cleanCanvas, 0, 0, 96, 54); } catch (e) { return; }
    let d;
    try { d = x.getImageData(0, 0, 96, 54).data; } catch (e) { return; }
    const R = new Uint32Array(32), G = new Uint32Array(32), B = new Uint32Array(32);
    for (let i = 0; i < d.length; i += 4) { R[d[i] >> 3]++; G[d[i + 1] >> 3]++; B[d[i + 2] >> 3]++; }
    const max = Math.max(...R, ...G, ...B, 1);
    max2 = max;
    const hc = $('hist').getContext('2d');
    hc.clearRect(0, 0, 128, 72);
    hc.globalCompositeOperation = 'source-over';
    hc.fillStyle = 'rgba(0,0,0,.35)'; hc.fillRect(0, 0, 128, 72);
    hc.globalCompositeOperation = 'screen';
    plot(hc, R, '#ff5555'); plot(hc, G, '#55ff77'); plot(hc, B, '#6699ff');
    hc.globalCompositeOperation = 'source-over';
  }
  function plot(hc, bins, col) {
    hc.fillStyle = col;
    hc.beginPath(); hc.moveTo(0, 72);
    for (let i = 0; i < 32; i++) hc.lineTo(i * 4 + 2, 72 - (bins[i] / max2) * 68);
    hc.lineTo(128, 72); hc.closePath(); hc.fill();
  }
  let max2 = 1;

  /* ---------------- 参数抽屉 ---------------- */
  const PARAMS = {
    ev: { label: '曝光补偿', min: -3, max: 3, step: 0.25, get: () => S.exposure, set: v => S.exposure = v, fmt: v => (v > 0 ? '+' : '') + v.toFixed(2) + ' EV', reset: 0 },
    wb: { label: '色温', min: -100, max: 100, step: 5, get: () => S.temp, set: v => S.temp = v, fmt: v => v > 0 ? `暖 +${v}` : v < 0 ? `冷 ${v}` : '0', reset: 0 },
    tint: { label: '色调', min: -50, max: 50, step: 1, get: () => S.tint, set: v => S.tint = v, fmt: v => v > 0 ? `品 +${v}` : v < 0 ? `绿 ${v}` : '0', reset: 0 },
    iso: { label: 'ISO 感光度', min: 100, max: 6400, step: 100, get: () => S.iso, set: v => S.iso = v, fmt: v => String(v), reset: 100 },
    shutter: { label: '快门角度', min: 45, max: 360, step: 45, get: () => S.shutterAngle, set: v => S.shutterAngle = v, fmt: v => v + '°', reset: 180 },
    zoom: { label: '数码变焦', min: 1, max: 5, step: 0.1, get: () => S.zoom, set: v => S.zoom = v, fmt: v => '×' + v.toFixed(1), reset: 1 },
  };
  let openParam = null;
  function openDrawer(key) {
    openParam = key;
    const p = PARAMS[key];
    $('paramTitle').textContent = p.label;
    const r = $('paramRange');
    r.min = p.min; r.max = p.max; r.step = p.step; r.value = p.get();
    $('paramVal').textContent = p.fmt(p.get());
    $('paramDrawer').classList.remove('hidden');
    document.querySelectorAll('#rightStrip .pbtn').forEach(b => b.classList.toggle('on', b.dataset.p === key));
  }
  function closeDrawer() {
    openParam = null;
    $('paramDrawer').classList.add('hidden');
    document.querySelectorAll('#rightStrip .pbtn').forEach(b => b.classList.remove('on'));
  }

  /* ---------------- UI 构建 ---------------- */
  function buildLutBar() {
    const bar = $('lutBar');
    bar.innerHTML = '';
    LUT.PRESETS.forEach(p => {
      const el = document.createElement('button');
      el.className = 'lutchip' + (p.id === S.lut ? ' on' : '');
      el.dataset.id = p.id;
      el.title = p.desc || p.name;
      el.innerHTML = `<span class="sw" style="background:${LUT.swatch(p)}"></span><span class="nm">${p.name}</span>`;
      el.onclick = () => {
        S.lut = p.id;
        engine.setLUT(p.id, p.bypass ? null : LUT.bakeLUT(p), LUT.LUT_SIZE);
        document.querySelectorAll('.lutchip').forEach(c => c.classList.toggle('on', c.dataset.id === p.id));
        updateHud();
      };
      bar.appendChild(el);
    });
  }
  function updateHud() {
    const p = LUT.PRESETS.find(x => x.id === S.lut);
    $('fmt').textContent = `${S.res === 1080 ? '1080p' : '720p'} · ${S.fps}fps${S.ratio !== 'native' ? ' · ' + S.ratio : ''}`;
    $('lutName').textContent = p ? p.name : '';
    $('logBadge').classList.toggle('hidden', !(S.log && S.lut !== 'bypass'));
    $('demoBadge').classList.toggle('hidden', !S.demo);
  }
  let toastTimer = null;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
  }
  function updateThumb() {
    const btn = $('galleryBtn');
    const photo = items.find(i => i.type === 'photo');
    const n = items.length;
    btn.innerHTML = (photo ? `<img src="${photo.url}" alt="相册">` : `<span class="icon">🖼️</span>`)
      + `<span id="galleryCount">${n || ''}</span>`;
  }
  function renderGallery() {
    const grid = $('galleryGrid');
    grid.innerHTML = '';
    if (!items.length) {
      grid.innerHTML = '<div class="empty">还没有拍摄内容<br>按快门试试吧</div>';
      return;
    }
    items.forEach(m => {
      const el = document.createElement('div');
      el.className = 'gitem';
      el.innerHTML = m.type === 'photo'
        ? `<img src="${m.url}" loading="lazy" alt="">`
        : `<video src="${m.url}#t=0.5" muted preload="metadata"></video><span class="vtag">▶</span>`;
      el.onclick = () => openViewer(m);
      grid.appendChild(el);
    });
  }
  let viewerItem = null;
  function openViewer(m) {
    viewerItem = m;
    const box = $('viewerBody');
    box.innerHTML = m.type === 'photo'
      ? `<img src="${m.url}" alt="">`
      : `<video src="${m.url}" controls autoplay loop></video>`;
    $('galleryModal').classList.add('viewer');
    $('backBtn').classList.remove('hidden');
    $('viewerBar').classList.remove('hidden');
    $('viewerBody').classList.remove('hidden');
    $('galleryGrid').classList.add('hidden');
  }
  function closeViewer() {
    viewerItem = null;
    $('galleryModal').classList.remove('viewer');
    $('backBtn').classList.add('hidden');
    $('viewerBar').classList.add('hidden');
    $('viewerBody').classList.add('hidden');
    $('viewerBody').innerHTML = '';
    $('galleryGrid').classList.remove('hidden');
  }

  /* ---------------- 事件绑定 ---------------- */
  function bind() {
    $('btnStart').onclick = () => {
      $('gateErr').classList.add('hidden');
      startCamera().catch(e => {
        $('gateErr').classList.remove('hidden');
        $('gateErr').textContent = '无法打开相机:' + (e && e.name === 'NotAllowedError'
          ? '权限被拒绝,请在浏览器地址栏允许摄像头后重试'
          : (e && e.message ? e.message : '未检测到可用摄像头')) + '。可先用「演示模式」体验调色管线。';
      });
    };
    $('btnDemo').onclick = () => startDemo();

    // 监视工具
    $('tGrid').onclick = () => { S.grid = !S.grid; $('tGrid').classList.toggle('on', S.grid); $('gridOv').classList.toggle('hidden', !S.grid); };
    $('tZebra').onclick = () => setMonitor(1);
    $('tFalse').onclick = () => setMonitor(2);
    $('tPeak').onclick = () => setMonitor(3);
    $('tHist').onclick = () => { S.hist = !S.hist; $('tHist').classList.toggle('on', S.hist); $('histBox').classList.toggle('hidden', !S.hist); };
    $('tRatio').onclick = () => {
      S.ratio = S.ratio === 'native' ? '16:9' : S.ratio === '16:9' ? '2.35:1' : S.ratio === '2.35:1' ? '1:1' : 'native';
      $('tRatio').querySelector('span.lb').textContent = S.ratio === 'native' ? '原生' : S.ratio;
      $('tRatio').classList.toggle('on', S.ratio !== 'native');
    };
    $('logChip').onclick = () => { S.log = !S.log; $('logChip').classList.toggle('on', S.log); updateHud(); };

    // 参数
    document.querySelectorAll('#rightStrip .pbtn').forEach(b => {
      b.onclick = () => (openParam === b.dataset.p ? closeDrawer() : openDrawer(b.dataset.p));
    });
    $('paramRange').oninput = e => {
      if (!openParam) return;
      const p = PARAMS[openParam];
      p.set(parseFloat(e.target.value));
      $('paramVal').textContent = p.fmt(p.get());
    };
    $('paramReset').onclick = () => {
      if (!openParam) return;
      const p = PARAMS[openParam];
      p.set(p.reset);
      $('paramRange').value = p.reset;
      $('paramVal').textContent = p.fmt(p.reset);
    };
    $('paramClose').onclick = closeDrawer;

    // 底部
    $('shutter').onclick = toggleShutter;
    $('modePhoto').onclick = () => setMode('photo');
    $('modeVideo').onclick = () => setMode('video');
    $('galleryBtn').onclick = () => { renderGallery(); $('galleryModal').classList.remove('hidden'); };
    $('flipBtn').onclick = async () => {
      if (S.demo) { toast('演示模式没有前后摄像头'); return; }
      S.facing = S.facing === 'user' ? 'environment' : 'user';
      try { await startCamera(); } catch (e) { toast('切换摄像头失败'); }
    };
    $('galleryClose').onclick = () => { closeViewer(); $('galleryModal').classList.add('hidden'); };
    $('galleryModal').addEventListener('click', e => { if (e.target === $('galleryModal')) { closeViewer(); $('galleryModal').classList.add('hidden'); } });
    $('dlBtn').onclick = () => viewerItem && download(viewerItem);
    $('delBtn').onclick = () => viewerItem && delMedia(viewerItem);
    $('backBtn').onclick = closeViewer;

    // 设置
    $('setBtn').onclick = () => { syncSettingsUI(); $('settingsModal').classList.remove('hidden'); };
    $('setClose').onclick = () => $('settingsModal').classList.add('hidden');
    document.querySelectorAll('input[name=res]').forEach(r => r.onchange = async () => {
      S.res = parseInt(r.value, 10);
      if (S.running && !S.demo) { try { await startCamera(); } catch (e) { } }
      updateHud();
    });
    document.querySelectorAll('input[name=fps]').forEach(r => r.onchange = () => { S.fps = parseInt(r.value, 10); updateHud(); });
    $('micChk').onchange = async e => {
      S.mic = e.target.checked;
      if (S.running && !S.demo) { try { await startCamera(); } catch (er) { } }
    };
    $('mirrorChk').onchange = e => { S.mirror = e.target.checked; };

    // 键盘 / 滚轮 / 双指
    window.addEventListener('keydown', e => {
      if (e.code === 'Space' && S.running && !e.target.closest('input,textarea')) { e.preventDefault(); toggleShutter(); }
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && S.running) keepAwake();
    });
    setupPinchZoom();
    setupInstallPrompt();
    $('stage').addEventListener('wheel', e => {
      if (!S.running) return;
      e.preventDefault();
      S.zoom = Math.min(5, Math.max(1, S.zoom + (e.deltaY < 0 ? 0.2 : -0.2)));
      if (openParam === 'zoom') { $('paramRange').value = S.zoom; $('paramVal').textContent = '×' + S.zoom.toFixed(1); }
      else openDrawer('zoom'), clearTimeout(openDrawer._t), openDrawer._t = setTimeout(closeDrawer, 1200);
    }, { passive: false });
  }
  function setMonitor(m) {
    S.monitor = S.monitor === m ? 0 : m;
    $('tZebra').classList.toggle('on', S.monitor === 1);
    $('tFalse').classList.toggle('on', S.monitor === 2);
    $('tPeak').classList.toggle('on', S.monitor === 3);
  }
  function setMode(m) {
    if (S.recording) { toast('录制中,无法切换模式'); return; }
    S.mode = m;
    $('modePhoto').classList.toggle('on', m === 'photo');
    $('modeVideo').classList.toggle('on', m === 'video');
  }
  function syncSettingsUI() {
    document.querySelectorAll('input[name=res]').forEach(r => r.checked = +r.value === S.res);
    document.querySelectorAll('input[name=fps]').forEach(r => r.checked = +r.value === S.fps);
    $('micChk').checked = S.mic;
    $('mirrorChk').checked = S.mirror;
  }

  /* ---------------- 启动 ---------------- */
  function boot() {
    try { engine = GL.createGL2($('clean'), $('fx')); }
    catch (e) { console.warn('WebGL2 初始化失败,进入兼容模式:', e); engine = null; }
    if (!engine) engine = GL.create2D($('clean'), $('fx'));
    if (!engine.isGL2) toast('当前浏览器不支持 WebGL2,已进入兼容模式(影调近似)');
    buildLutBar();
    const storm = LUT.PRESETS.find(p => p.id === S.lut);
    engine.setLUT(storm.id, storm.bypass ? null : LUT.bakeLUT(storm), LUT.LUT_SIZE);
    bind();
    loadGallery();
    updateHud();
    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
      navigator.serviceWorker.register('sw.js').catch(() => { });
    }
  }
  boot();
})();
