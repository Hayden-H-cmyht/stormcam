/* StormCam — 影调(LUT)预设与 3D LUT 烘焙
 * 预设的调色数学作用在「Log 域」上(与真实流程一致:Log → LUT → 直出)。
 * 本文件不依赖浏览器,可在 Node 中做冒烟测试。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.StormLUT = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LUT_SIZE = 32;

  /* 每个预设:con 对比 / sat 饱和 / lift 阴影染色 / gain 高光染色 / fade 黑位抬升 / dark 整体压暗 */
  const PRESETS = [
    { id: 'bypass',   name: '原色 709',   bypass: true, desc: '无影调 · 直出' },
    { id: 'storm',    name: '风暴 Standard', con: 1.12, sat: 1.06, lift: [ 0.010, 0.015, 0.030], gain: [ 0.020, 0.010,-0.020], desc: '均衡电影感 · 冷调阴影' },
    { id: 'teal',     name: '青橙 T&O',   con: 1.18, sat: 1.15, lift: [-0.020, 0.010, 0.050], gain: [ 0.060, 0.000,-0.040], desc: '好莱坞大片经典' },
    { id: 'film250d', name: '胶片 250D',  con: 1.08, sat: 0.92, lift: [ 0.020, 0.020, 0.010], gain: [ 0.050, 0.030,-0.020], fade: 0.035, desc: '日光胶片 · 柔和高光' },
    { id: 'night',    name: '夜幕 Night', con: 1.20, sat: 0.85, lift: [ 0.000, 0.010, 0.060], gain: [ 0.000, 0.010, 0.050], dark: 0.92, desc: '夜景冷蓝 · 低饱和' },
    { id: 'golden',   name: '落日 Golden', con: 1.10, sat: 1.18, lift: [ 0.030, 0.010,-0.020], gain: [ 0.070, 0.030,-0.030], desc: '黄金时刻 · 暖调' },
    { id: 'noir',     name: '黑白 Noir',  con: 1.25, sat: 0.00, lift: [-0.010, 0.000, 0.020], gain: [ 0.000, 0.000, 0.000], desc: '高对比黑白' },
    { id: 'cyber',    name: '赛博 Cyber', con: 1.20, sat: 1.30, lift: [ 0.030, 0.000, 0.060], gain: [ 0.020,-0.010, 0.070], desc: '霓虹夜城' },
    { id: 'faded',    name: '褪色 Faded', con: 0.92, sat: 0.80, lift: [ 0.050, 0.045, 0.040], gain: [ 0.020, 0.020, 0.000], desc: '低对比 · 文艺褪色' },
    { id: 'punch',    name: '通透 Punch', con: 1.28, sat: 1.08, lift: [ 0.000, 0.000, 0.010], gain: [ 0.010, 0.010, 0.000], desc: '高对比 · 干净通透' },
  ];

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function smoothstep(a, b, x) {
    const t = clamp01((x - a) / (b - a));
    return t * t * (3 - 2 * t);
  }

  /* 对 LOG 域颜色 [r,g,b](0..1)应用预设调色 */
  function applyGrade(c, p) {
    const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    const pivot = 0.42;
    const out = [0, 0, 0];
    for (let i = 0; i < 3; i++) out[i] = (c[i] - pivot) * p.con + pivot;
    const sh = 1 - smoothstep(0, 0.62, l);
    const hi = smoothstep(0.45, 1.0, l);
    for (let i = 0; i < 3; i++) out[i] += p.lift[i] * sh + p.gain[i] * hi;
    const g = 0.2126 * out[0] + 0.7152 * out[1] + 0.0722 * out[2];
    for (let i = 0; i < 3; i++) out[i] = g + (out[i] - g) * p.sat;
    if (p.fade) for (let i = 0; i < 3; i++) out[i] = p.fade + out[i] * (1 - p.fade);
    if (p.dark) for (let i = 0; i < 3; i++) out[i] *= p.dark;
    return out.map(clamp01);
  }

  /* 烘焙为 32³ RGBA8 3D LUT 数据(WebGL2 texImage3D 布局:x=R 最快变化) */
  function bakeLUT(p) {
    const N = LUT_SIZE;
    const data = new Uint8Array(N * N * N * 4);
    if (p.bypass) { // 恒等映射保护
      let i = 0;
      for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++) {
        data[i++] = r / (N - 1) * 255; data[i++] = g / (N - 1) * 255; data[i++] = b / (N - 1) * 255; data[i++] = 255;
      }
      return data;
    }
    let idx = 0;
    for (let b = 0; b < N; b++) {
      for (let g = 0; g < N; g++) {
        for (let r = 0; r < N; r++) {
          const out = applyGrade([r / (N - 1), g / (N - 1), b / (N - 1)], p);
          data[idx++] = out[0] * 255;
          data[idx++] = out[1] * 255;
          data[idx++] = out[2] * 255;
          data[idx++] = 255;
        }
      }
    }
    return data;
  }

  /* 用于影调色卡的 CSS 渐变(阴影色 → 中间 → 高光色) */
  function swatch(p) {
    if (p.bypass) return 'linear-gradient(135deg,#b9bec6,#e8eaee 55%,#9aa0a8)';
    const sc = p.lift.map(v => Math.round(clamp01(0.16 + v * 2.4) * 255));
    const gc = p.gain.map(v => Math.round(clamp01(0.86 + v * 2.2) * 255));
    const mid = p.sat === 0 ? '#9a9a9a' : '#c9a37a';
    const hex = c => '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
    return `linear-gradient(135deg,${hex(sc)},${mid} 55%,${hex(gc)})`;
  }

  return { LUT_SIZE, PRESETS, applyGrade, bakeLUT, swatch };
});
