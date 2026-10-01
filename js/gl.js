/* StormCam — WebGL2 实时调色引擎
 * 管线:视频帧 → [模拟 Log] → 色温/色调 → 3D LUT → 曝光/ISO → 对比/饱和 → 胶片颗粒
 *       + 快门角度动态模糊(前一帧反馈混合)
 * 监视器通道(独立画布,不进录制):斑马纹 / 假色 / 峰值对焦
 * 无 WebGL2 时自动降级为 2D canvas 兼容模式(ctx.filter 近似)。
 */
(function (root) {
  'use strict';

  const VERT = `#version 300 es
  in vec2 aPos;
  out vec2 vUv;
  void main(){ vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

  const FRAG_COMMON = `
  precision highp float;
  precision highp sampler3D;
  in vec2 vUv;
  out vec4 fragColor;
  uniform sampler2D uVideo;
  uniform sampler3D uLut;
  uniform float uHasLut, uLog, uExposure, uTemp, uTint, uSat, uCon;
  uniform float uIsoGain, uGrain, uBlur, uTime, uFlipX, uZebra, uPeak;
  uniform vec2 uUvScale, uUvOff, uTexel;
  uniform int uMode;

  float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
  float hash(vec2 p){ return fract(sin(dot(p + fract(uTime) * 61.7, vec2(127.1, 311.7))) * 43758.5453); }

  vec3 fakeLog(vec3 c){
    c = pow(clamp(c, 0.0, 1.0), vec3(0.62));
    c = c * 0.86 + 0.09;
    float l = luma(c);
    return mix(vec3(l), c, 0.72);
  }

  vec3 grade(vec3 c){
    if (uLog > 0.5) c = fakeLog(c);
    c *= vec3(1.0 + uTemp * 0.0006, 1.0 + uTint * 0.0004, 1.0 - uTemp * 0.0006);
    if (uHasLut > 0.5) c = texture(uLut, clamp(c, 0.0, 1.0) * (31.0 / 32.0) + 0.5 / 32.0).rgb;
    c *= pow(2.0, uExposure);
    c *= uIsoGain;
    c = (c - 0.5) * uCon + 0.5;
    float l = luma(c);
    c = mix(vec3(l), c, uSat);
    return clamp(c, 0.0, 1.0);
  }

  vec3 falseColor(float L){
    if (L < 0.08) return vec3(0.10, 0.10, 0.60);
    if (L < 0.22) return vec3(0.10, 0.30, 0.80);
    if (L < 0.36) return vec3(0.10, 0.65, 0.75);
    if (L < 0.48) return vec3(0.10, 0.80, 0.30);
    if (L < 0.58) return vec3(0.55, 0.85, 0.10);
    if (L < 0.66) return vec3(0.95, 0.85, 0.10);
    if (L < 0.80) return vec3(0.98, 0.55, 0.10);
    if (L < 0.92) return vec3(0.95, 0.15, 0.10);
    return vec3(1.00, 0.30, 0.55);
  }
  `;

  const FRAG_CLEAN = `#version 300 es
  ${FRAG_COMMON}
  uniform sampler2D uPrev;
  void main(){
    vec2 suv = uUvOff + vec2(mix(vUv.x, 1.0 - vUv.x, uFlipX), 1.0 - vUv.y) * uUvScale;
    vec3 cur = grade(texture(uVideo, suv).rgb);
    vec3 prev = texture(uPrev, vUv).rgb;
    vec3 col = mix(cur, prev, uBlur);
    col += (hash(gl_FragCoord.xy) - 0.5) * uGrain;
    fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
  }`;

  const FRAG_FX = `#version 300 es
  ${FRAG_COMMON}
  void main(){
    vec2 suv = uUvOff + vec2(mix(vUv.x, 1.0 - vUv.x, uFlipX), 1.0 - vUv.y) * uUvScale;
    vec3 col = grade(texture(uVideo, suv).rgb);
    float L = luma(col);
    if (uMode == 1) {                       /* 斑马纹 */
      col *= 0.45;
      if (L > uZebra) {
        float s = step(0.5, fract((gl_FragCoord.x + gl_FragCoord.y) / 12.0));
        col = mix(col, vec3(1.0, 0.9, 0.1), s);
      }
    } else if (uMode == 2) {                /* 假色 */
      col = falseColor(L);
    } else if (uMode == 3) {                /* 峰值对焦 */
      float lx = luma(texture(uVideo, suv + vec2(uTexel.x, 0.0)).rgb) - luma(texture(uVideo, suv - vec2(uTexel.x, 0.0)).rgb);
      float ly = luma(texture(uVideo, suv + vec2(0.0, uTexel.y)).rgb) - luma(texture(uVideo, suv - vec2(0.0, uTexel.y)).rgb);
      col *= 0.5;
      if (sqrt(lx * lx + ly * ly) > uPeak) col = vec3(1.0, 0.15, 0.10);
    }
    fragColor = vec4(col, 1.0);
  }`;

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error('shader: ' + gl.getShaderInfoLog(s));
    }
    return s;
  }
  function program(gl, fragSrc) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fragSrc));
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error('link: ' + gl.getProgramInfoLog(p));
    }
    return p;
  }
  function uniforms(gl, prog) {
    const u = {};
    const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const name = gl.getActiveUniform(prog, i).name;
      u[name] = gl.getUniformLocation(prog, name);
    }
    return u;
  }
  function makeVideoTexture(gl) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([16, 16, 16, 255]));
    return t;
  }

  /* ---------------- WebGL2 引擎 ---------------- */
  function createGL2(cleanCanvas, fxCanvas) {
    const gl = cleanCanvas.getContext('webgl2', { preserveDrawingBuffer: true, alpha: false, antialias: false });
    if (!gl) return null;
    const gl2 = fxCanvas.getContext('webgl2', { preserveDrawingBuffer: true, alpha: false, antialias: false });
    if (!gl2) return null;

    const progC = program(gl, FRAG_CLEAN), uC = uniforms(gl, progC);
    const progF = program(gl2, FRAG_FX), uF = uniforms(gl2, progF);

    for (const [g, prog] of [[gl, progC], [gl2, progF]]) {
      const buf = g.createBuffer();
      g.bindBuffer(g.ARRAY_BUFFER, buf);
      g.bufferData(g.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), g.STATIC_DRAW);
      g.enableVertexAttribArray(0);
      g.vertexAttribPointer(0, 2, g.FLOAT, false, 0, 0);
      g.useProgram(prog);
    }

    const videoTex = makeVideoTexture(gl);
    const videoTex2 = makeVideoTexture(gl2); // 两个 context 不能共享纹理,各传一份
    const prevTex = makeVideoTexture(gl);
    gl.uniform1i(uC.uVideo, 0);
    gl.uniform1i(uC.uPrev, 1);
    gl.uniform1i(uC.uLut, 2);
    gl2.uniform1i(uF.uVideo, 0);
    gl2.uniform1i(uF.uLut, 2);

    const lutTex = {};   // gl (干净通道)
    const lutTex2 = {};  // gl2 (监视通道)
    let curLut = 'bypass';

    function uploadLUT(g, map, id, data, N) {
      const t = g.createTexture();
      g.bindTexture(g.TEXTURE_3D, t);
      g.texParameteri(g.TEXTURE_3D, g.TEXTURE_MIN_FILTER, g.LINEAR);
      g.texParameteri(g.TEXTURE_3D, g.TEXTURE_MAG_FILTER, g.LINEAR);
      g.texParameteri(g.TEXTURE_3D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
      g.texParameteri(g.TEXTURE_3D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
      g.texParameteri(g.TEXTURE_3D, g.TEXTURE_WRAP_R, g.CLAMP_TO_EDGE);
      g.texImage3D(g.TEXTURE_3D, 0, g.RGBA8, N, N, N, 0, g.RGBA, g.UNSIGNED_BYTE, data);
      map[id] = t;
    }

    function setLUT(id, data, N) {
      if (id === 'bypass') { curLut = id; return; }
      if (!lutTex[id]) { uploadLUT(gl, lutTex, id, data, N); uploadLUT(gl2, lutTex2, id, data, N); }
      curLut = id;
    }

    let cw = 0, ch = 0, srcW = 1280, srcH = 720;

    function draw(g, prog, u, mode, p) {
      g.viewport(0, 0, cw, ch);
      g.useProgram(prog);
      g.activeTexture(g.TEXTURE0);
      g.bindTexture(g.TEXTURE_2D, g === gl ? videoTex : videoTex2);
      if (g === gl) {
        g.activeTexture(g.TEXTURE1);
        g.bindTexture(g.TEXTURE_2D, prevTex);
      }
      g.activeTexture(g.TEXTURE2);
      const lmap = g === gl ? lutTex : lutTex2;
      if (curLut === 'bypass' || !lmap[curLut]) {
        g.bindTexture(g.TEXTURE_3D, lmap._stub || (lmap._stub = makeLutStub(g)));
        g.uniform1f(u.uHasLut, 0);
      } else {
        g.bindTexture(g.TEXTURE_3D, lmap[curLut]);
        g.uniform1f(u.uHasLut, 1);
      }
      g.uniform1f(u.uLog, p.log ? 1 : 0);
      g.uniform1f(u.uExposure, p.exposure);
      g.uniform1f(u.uTemp, p.temp);
      g.uniform1f(u.uTint, p.tint);
      g.uniform1f(u.uSat, p.sat);
      g.uniform1f(u.uCon, p.con);
      g.uniform1f(u.uIsoGain, p.isoGain);
      g.uniform1f(u.uGrain, p.grain);
      g.uniform1f(u.uTime, p.time);
      g.uniform1f(u.uFlipX, p.mirror ? 1 : 0);
      g.uniform1f(u.uZebra, p.zebra);
      g.uniform1f(u.uPeak, p.peak);
      g.uniform1i(u.uMode, mode);
      g.uniform2f(u.uUvScale, p.uvScale[0], p.uvScale[1]);
      g.uniform2f(u.uUvOff, p.uvOff[0], p.uvOff[1]);
      g.uniform2f(u.uTexel, 1 / srcW, 1 / srcH);
      if (g === gl) g.uniform1f(u.uBlur, p.blur);
      g.drawArrays(g.TRIANGLES, 0, 3);
    }

    function makeLutStub(g) {
      const t = g.createTexture();
      g.bindTexture(g.TEXTURE_3D, t);
      g.texParameteri(g.TEXTURE_3D, g.TEXTURE_MIN_FILTER, g.NEAREST);
      g.texParameteri(g.TEXTURE_3D, g.TEXTURE_MAG_FILTER, g.NEAREST);
      g.texParameteri(g.TEXTURE_3D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
      g.texParameteri(g.TEXTURE_3D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
      g.texParameteri(g.TEXTURE_3D, g.TEXTURE_WRAP_R, g.CLAMP_TO_EDGE);
      g.texImage3D(g.TEXTURE_3D, 0, g.RGBA8, 2, 2, 2, 0, g.RGBA, g.UNSIGNED_BYTE,
        new Uint8Array(2 * 2 * 2 * 4).fill(128));
      return t;
    }

    return {
      isGL2: true,
      setSourceSize(w, h) { srcW = w || 1280; srcH = h || 720; },
      setSize(w, h) {
        if (cw === w && ch === h) return;
        cw = w; ch = h;
        cleanCanvas.width = w; cleanCanvas.height = h;
        fxCanvas.width = w; fxCanvas.height = h;
      },
      uploadFrame(src) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, videoTex);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src); }
        catch (e) { /* 帧尚未就绪 */ }
      },
      setLUT,
      render(p) {
        if (!cw) return;
        draw(gl, progC, uC, 0, p);
        if (p.mode > 0) {
          // 监视通道按需上传(仅在开启斑马纹/假色/峰值时才有开销)
          gl2.activeTexture(gl2.TEXTURE0);
          gl2.bindTexture(gl2.TEXTURE_2D, videoTex2);
          gl2.pixelStorei(gl2.UNPACK_ALIGNMENT, 1);
          try { gl2.texImage2D(gl2.TEXTURE_2D, 0, gl2.RGBA, gl2.RGBA, gl2.UNSIGNED_BYTE, p.source); }
          catch (e) { }
          fxCanvas.style.display = 'block';
          draw(gl2, progF, uF, p.mode, p);
        } else {
          fxCanvas.style.display = 'none';
        }
        // 快门角度:把本帧输出回读为前一帧纹理,下一帧混合
        if (p.blur > 0.01) {
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, prevTex);
          try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cleanCanvas); }
          catch (e) { }
        } else {
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, prevTex);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
        }
      },
      cleanCanvas,
    };
  }

  /* ---------------- 2D 兼容降级 ---------------- */
  function create2D(cleanCanvas, fxCanvas) {
    const ctx = cleanCanvas.getContext('2d');
    fxCanvas.style.display = 'none';
    let cw = 0, ch = 0;
    return {
      isGL2: false,
      setSourceSize() { },
      setSize(w, h) {
        if (cw === w && ch === h) return;
        cw = w; ch = h; cleanCanvas.width = w; cleanCanvas.height = h;
      },
      uploadFrame() { },
      setLUT() { },
      render(p) {
        if (!cw) return;
        const f = [];
        f.push(`brightness(${(p.isoGain * Math.pow(2, p.exposure)).toFixed(3)})`);
        f.push(`contrast(${p.con.toFixed(3)})`);
        f.push(`saturate(${p.sat.toFixed(3)})`);
        if (p.temp > 0) f.push(`sepia(${Math.min(0.4, p.temp * 0.00025).toFixed(3)})`);
        if (p.sat === 0) f.push('grayscale(1)');
        ctx.filter = f.join(' ');
        const sx = p.uvOff[0] * p.srcW, sy = p.uvOff[1] * p.srcH;
        const sw = p.uvScale[0] * p.srcW, sh = p.uvScale[1] * p.srcH;
        ctx.save();
        if (p.mirror) { ctx.translate(cw, 0); ctx.scale(-1, 1); }
        ctx.drawImage(p.source, sx, sy, sw, sh, 0, 0, cw, ch);
        ctx.restore();
        ctx.filter = 'none';
        fxCanvas.style.display = 'none';
      },
      cleanCanvas,
    };
  }

  root.StormGL = { createGL2, create2D };
})(typeof self !== 'undefined' ? self : this);
