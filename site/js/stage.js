// The hero stage: three phones under a light rig, an agent's light that taps them, and trails that flow up into the
// PhoneDock window upstage, which shows the phone in play. Loaded lazily by main.js; the poster image stands in until it's ready.
import * as THREE from 'three';
import { SampleApp, SettingsApp, SignInApp, MacWindow } from './screens.js';

const LOOKS = {
  dark: {
    bg: 0x0a0a0f, floor: 0x1a1a24, floorEnv: 0.03, hemiSky: 0x34345a, hemiGround: 0x050507, hemi: 0.22, fill: 0.22,
    spot: 520, spotIdle: 0.36, beams: 0.11, glow: 0.75, shadow: 0.6, fog: [11, 30],
    agent: 0xbf5af2, you: 0x8f8cff, handoff: 0xff9f0a, packet: 0xb9b4ff,
    additive: true, envBg: 0x040406, envPanel: 5,
  },
  light: {
    bg: 0xe8e8ec, floor: 0xdcdce3, floorEnv: 0.35, hemiSky: 0xffffff, hemiGround: 0xc4c4cc, hemi: 1.08, fill: 0.45,
    spot: 60, spotIdle: 0.6, beams: 0, glow: 0, shadow: 0.24, fog: [13, 34],
    agent: 0xaf52de, you: 0x5856d6, handoff: 0xc2410c, packet: 0x5856d6,
    additive: false, envBg: 0x9a9aa4, envPanel: 3,
  },
};

const ease = {
  inOut: (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
  out: (x) => 1 - Math.pow(1 - x, 3),
};

function roundedShape(w, h, r) {
  const s = new THREE.Shape();
  const x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
  return s;
}
function flatUV(geo, w, h) {
  const p = geo.attributes.position, uv = geo.attributes.uv;
  for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) / w + 0.5, p.getY(i) / h + 0.5);
  uv.needsUpdate = true;
  return geo;
}
function canvasTexture(canvas, renderer) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return t;
}
function blobTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d').createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(0.5, 'rgba(0,0,0,.45)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  const ctx = c.getContext('2d'); ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

// ---------- Points shader for the agent's light, its trail, and the packets ----------
const pointVert = /* glsl */`
  attribute float aAlpha; attribute float aSize; varying float vA; uniform float uScale;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aSize * uScale / -mv.z;
    vA = aAlpha;
  }`;
const pointFrag = /* glsl */`
  uniform vec3 uColor; uniform float uCore; varying float vA;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    if (d > 1.0) discard;
    float a = pow(1.0 - d, 1.7);
    vec3 col = mix(uColor, vec3(1.0), uCore * pow(1.0 - d, 5.0));
    gl_FragColor = vec4(col, a * vA);
  }`;

class Trail {
  constructor(n, size, life, color, shared) {
    this.n = n; this.size = size; this.life = life; this.hist = []; this.intensity = 1;
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(n * 3); this.alpha = new Float32Array(n); this.sizes = new Float32Array(n);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.sizes, 1));
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(color) }, uScale: shared.uScale, uCore: shared.uCore },
      vertexShader: pointVert, fragmentShader: pointFrag, transparent: true, depthWrite: false,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false; this.points.renderOrder = 10;
    this._a = new THREE.Vector3(); this._prev = new THREE.Vector3();
  }
  push(p, t) {
    this.hist.unshift({ p: p.clone(), t });
    while (this.hist.length > 2 && t - this.hist[this.hist.length - 1].t > this.life + 0.05) this.hist.pop();
  }
  update(t) {
    const { n, hist, pos, alpha, sizes } = this;
    let k = 0;
    for (let i = 0; i < n; i++) {
      const f = i / (n - 1);
      const tt = t - f * this.life;
      while (k < hist.length - 2 && hist[k + 1].t > tt) k++;
      const h0 = hist[k], h1 = hist[k + 1];
      if (!h0 || !h1 || tt < h1.t - 1e-4 || tt > h0.t + 0.2) { alpha[i] = 0; continue; }
      const span = h0.t - h1.t || 1;
      const u = Math.min(1, Math.max(0, (tt - h1.t) / span));
      this._a.copy(h1.p).lerp(h0.p, u);
      pos[i * 3] = this._a.x; pos[i * 3 + 1] = this._a.y; pos[i * 3 + 2] = this._a.z;
      // Fade where the light stood still, so a resting cursor doesn't pile up into a blob.
      const step = i === 0 ? 1 : Math.min(1, this._a.distanceTo(this._prev) / 0.012);
      this._prev.copy(this._a);
      alpha[i] = Math.pow(1 - f, 1.6) * this.intensity * (i === 0 ? 0 : step);
      sizes[i] = this.size * (1 - 0.7 * f);
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.aAlpha.needsUpdate = true;
    this.points.geometry.attributes.aSize.needsUpdate = true;
  }
}

class Light {
  // A cursor: a bright head with a halo, and a trail.
  constructor(color, shared, scene) {
    this.pos = new THREE.Vector3(); this.visible = 1;
    this.trail = new Trail(56, 0.07, 0.5, color, shared);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    this.headA = new Float32Array([1, 0.22]);
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.headA, 1));
    g.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array([0.085, 0.42]), 1));
    this.head = new THREE.Points(g, this.trail.mat);
    this.head.frustumCulled = false; this.head.renderOrder = 11;
    scene.add(this.trail.points, this.head);
  }
  setColor(c) { this.trail.mat.uniforms.uColor.value.set(c); }
  update(t) {
    this.trail.push(this.pos, t); this.trail.intensity = this.visible; this.trail.update(t);
    const a = this.head.geometry.attributes.position.array;
    a[0] = a[3] = this.pos.x; a[1] = a[4] = this.pos.y; a[2] = a[5] = this.pos.z;
    this.headA[0] = this.visible; this.headA[1] = 0.22 * this.visible;
    this.head.geometry.attributes.position.needsUpdate = true;
    this.head.geometry.attributes.aAlpha.needsUpdate = true;
  }
}

function beamMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(0xdfe0ff) }, uOpacity: { value: 0.07 }, uLen: { value: 1 } },
    vertexShader: /* glsl */`
      varying float vH; varying vec3 vN; varying vec3 vV; uniform float uLen;
      void main() {
        vH = position.y / uLen + 0.5;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor; uniform float uOpacity; varying float vH; varying vec3 vN; varying vec3 vV;
      void main() {
        float facing = pow(abs(dot(normalize(vN), normalize(vV))), 2.2);
        float a = uOpacity * facing * (0.2 + 0.8 * smoothstep(0.0, 1.0, vH)) * smoothstep(0.0, 0.12, vH);
        gl_FragColor = vec4(uColor * a, a);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
}

// Building the scene is split into a few tasks, so a phone never sees one long freeze while it boots.
const breathe = () => (globalThis.scheduler?.yield ? globalThis.scheduler.yield() : new Promise((r) => setTimeout(r, 0)));

export async function start(opts) {
  const { canvas, stageEl, cue, onTheme, holdButton } = opts;
  const freeze = opts.freezeAt;
  let theme = opts.theme;
  let look = LOOKS[theme];
  const coarse = matchMedia('(pointer: coarse)').matches;

  const renderer = new THREE.WebGLRenderer({ canvas, context: opts.gl, antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: freeze != null });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  let maxDPR = Math.min(window.devicePixelRatio || 1, coarse ? 1.5 : 1.75);
  let dpr = maxDPR;
  renderer.setPixelRatio(dpr);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(look.bg);
  scene.fog = new THREE.Fog(look.bg, look.fog[0], look.fog[1]);
  const camera = new THREE.PerspectiveCamera(30, 1.6, 0.1, 80);

  // Environment: the light rig as soft boxes, for reflections on frames and glass.
  const pmrem = new THREE.PMREMGenerator(renderer);
  let envRT = null;
  function buildEnv() {
    const env = new THREE.Scene();
    env.background = new THREE.Color(look.envBg);
    const panel = (w, h, x, y, z, ry, rx, k) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffffff).multiplyScalar(k), side: THREE.DoubleSide }));
      m.position.set(x, y, z); m.rotation.set(rx, ry, 0); env.add(m);
    };
    panel(8, 3, 0, 6, 0, 0, Math.PI / 2, look.envPanel);
    panel(1.2, 6, -6, 2, 2, Math.PI / 2, 0, look.envPanel * 0.8);
    panel(1.2, 6, 6, 2, 0, -Math.PI / 2, 0, look.envPanel * 0.5);
    panel(10, 1, 0, 1, -7, 0, 0, look.envPanel * 0.25);
    envRT?.dispose();
    envRT = pmrem.fromScene(env, 0.04);
    scene.environment = envRT.texture;
  }
  buildEnv();
  await breathe();

  // Floor
  // Diffuse only: a matte stage floor shows light pools, not a specular sheen.
  const floorMat = new THREE.MeshLambertMaterial({ color: look.floor });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), floorMat);
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);
  const hemi = new THREE.HemisphereLight(look.hemiSky, look.hemiGround, look.hemi);
  scene.add(hemi);
  const fill = new THREE.DirectionalLight(0xffffff, look.fill);
  fill.position.set(-4, 5, 8);
  scene.add(fill);

  // ---------- Phones ----------
  const surfaces = { sim: new SettingsApp(1.6), pixel: new SampleApp(1.6), iphone: new SignInApp(2) };
  const shared = { uScale: { value: 600 }, uCore: { value: look.additive ? 1 : 0 } };
  const blob = blobTexture();

  function makePhone(kind, surface, place) {
    const pixel = kind === 'pixel';
    const W = 0.8, b = pixel ? 0.034 : 0.03;
    const sw = W - 2 * b, sh = sw * (surface.h / surface.w), H = sh + 2 * b;
    const r = W * (pixel ? 0.12 : 0.17), D = 0.085, bevel = 0.012;
    const group = new THREE.Group();
    const frameMat = new THREE.MeshPhysicalMaterial({
      color: pixel ? 0x2a2b30 : 0x47464c, metalness: pixel ? 0.55 : 0.9, roughness: pixel ? 0.42 : 0.28, envMapIntensity: 1.1,
    });
    const bodyGeo = new THREE.ExtrudeGeometry(roundedShape(W - 2 * bevel, H - 2 * bevel, r - bevel), { depth: D - 2 * bevel, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 4, curveSegments: 20 });
    bodyGeo.center();
    group.add(new THREE.Mesh(bodyGeo, frameMat));
    const glass = new THREE.Mesh(new THREE.ShapeGeometry(roundedShape(W - 0.008, H - 0.008, r - 0.004), 20), new THREE.MeshPhysicalMaterial({ color: 0x050507, roughness: 0.1, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.06, envMapIntensity: 1.3 }));
    glass.position.z = D / 2 + 0.0006;
    group.add(glass);
    const tex = canvasTexture(surface.canvas, renderer);
    const screen = new THREE.Mesh(flatUV(new THREE.ShapeGeometry(roundedShape(sw, sh, r - b), 20), sw, sh), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
    screen.position.z = D / 2 + 0.0016;
    group.add(screen);
    const black = new THREE.MeshBasicMaterial({ color: 0x020203 });
    if (pixel) {
      const hole = new THREE.Mesh(new THREE.CircleGeometry(0.016, 24), black);
      hole.position.set(0, sh / 2 - 0.042, D / 2 + 0.0024); group.add(hole);
    } else {
      const island = new THREE.Mesh(new THREE.ShapeGeometry(roundedShape(0.2, 0.058, 0.029), 12), black);
      island.position.set(0, sh / 2 - 0.05, D / 2 + 0.0024); group.add(island);
    }
    const btn = (len, y, side) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.012, len, 0.03), frameMat);
      m.position.set(side * (W / 2 + 0.003), y, 0); group.add(m);
    };
    if (pixel) { btn(0.12, 0.32, 1); btn(0.22, 0.05, 1); }
    else { btn(0.05, 0.5, -1); btn(0.11, 0.34, -1); btn(0.11, 0.2, -1); btn(0.17, 0.32, 1); }

    group.position.set(...place.pos);
    group.rotation.set(-0.05, place.ry, place.rz || 0);
    scene.add(group);

    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.75), new THREE.MeshBasicMaterial({ map: blob, transparent: true, depthWrite: false, opacity: look.shadow, color: 0x000000 }));
    shadow.rotation.x = -Math.PI / 2; shadow.rotation.z = -place.ry;
    shadow.position.set(place.pos[0], 0.004, place.pos[2]);
    scene.add(shadow);

    // Light from the rig above, front-left of the mark.
    const spot = new THREE.SpotLight(0xf4f2ff, look.spot, 0, 0.19, 0.85, 2);
    spot.position.set(place.pos[0] - 1.1, 7.6, place.pos[2] + 2.6);
    spot.target.position.set(place.pos[0], 0.55, place.pos[2]);
    scene.add(spot, spot.target);
    // A haze beam along the light.
    const floorHit = new THREE.Vector3(place.pos[0] + 0.12, 0, place.pos[2] - 0.25);
    const dir = new THREE.Vector3().subVectors(spot.position, floorHit);
    const len = dir.length();
    const beamMat = beamMaterial();
    beamMat.uniforms.uLen.value = len;
    const beam = new THREE.Mesh(new THREE.ConeGeometry(Math.tan(0.19) * len * 0.95, len, 40, 1, true), beamMat);
    beam.position.copy(floorHit).addScaledVector(dir, 0.5);
    beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    beam.renderOrder = 5;
    scene.add(beam);

    surface.onPaint = () => { tex.needsUpdate = true; };
    return {
      kind, surface, group, screen, tex, spot, beam, shadow, sw, sh, front: D / 2 + 0.002,
      base: new THREE.Vector3(...place.pos), bob: place.bob, lit: 0.5, status: 'running',
      point(uv, lift = 0) {
        const v = new THREE.Vector3((uv[0] - 0.5) * sw, (0.5 - uv[1]) * sh, this.front + lift);
        return group.localToWorld(v);
      },
    };
  }

  const phones = [
    makePhone('pixel', surfaces.pixel, { pos: [-1.0, 1.16, 0.05], ry: 0.2, bob: 0.0 }),
    makePhone('iphone', surfaces.sim, { pos: [0.02, 1.2, -0.75], ry: 0.03, bob: 2.1 }),
    makePhone('iphone', surfaces.iphone, { pos: [1.04, 1.12, 0.45], ry: -0.22, bob: 4.2 }),
  ];
  const [pixel, sim, iphone] = phones;
  await breathe();
  scene.updateMatrixWorld(true);

  // ---------- The PhoneDock window, upstage ----------
  const win = new MacWindow([
    { name: 'Pixel 9', sub: 'Android 16', surface: surfaces.pixel, kind: 'pixel' },
    { name: 'iPhone 17', sub: 'iOS 26.5', surface: surfaces.sim, kind: 'iphone' },
    { name: 'iPhone 17 Pro', sub: 'iOS 27 · Beta', surface: surfaces.iphone, kind: 'iphone' },
  ], 1);
  const WW = 5.2, WH = WW * (win.h / win.w);
  const winTex = canvasTexture(win.canvas, renderer);
  const winMesh = new THREE.Mesh(flatUV(new THREE.ShapeGeometry(roundedShape(WW, WH, 0.14), 12), WW, WH), new THREE.MeshBasicMaterial({ map: winTex, toneMapped: false, fog: true }));
  // Low enough that the cue panel fits between the nav and the window's top edge.
  winMesh.position.set(0.05, 2.85, -6.6);
  winMesh.rotation.x = 0.04;
  scene.add(winMesh);
  win.state.theme = theme;
  win.onPaint = () => { winTex.needsUpdate = true; };
  phones.forEach((p, i) => {
    const prev = p.surface.onPaint;
    p.surface.onPaint = () => { prev(); if (win.state.selected === i) win.paint(); };
  });
  win.paint();
  scene.updateMatrixWorld(true);
  const winPoint = (px, py) => winMesh.localToWorld(new THREE.Vector3((px / win.w - 0.5) * WW, (0.5 - py / win.h) * WH, 0.02));
  const activityPoint = () => winPoint(win.activity.x, win.activity.y);

  // ---------- Lights that move: the agent, you, and packets to the window ----------
  const agent = new Light(look.agent, shared, scene);
  const human = new Light(look.you, shared, scene);
  human.visible = 0;
  const packets = Array.from({ length: 4 }, () => {
    const tr = new Trail(44, 0.11, 0.55, look.packet, shared);
    scene.add(tr.points);
    return { tr, onLand: null, active: false, t0: 0, dur: 1, a: new THREE.Vector3(), c: new THREE.Vector3(), b: new THREE.Vector3(), p: new THREE.Vector3() };
  });
  const ripples = Array.from({ length: 4 }, () => {
    const m = new THREE.Mesh(new THREE.RingGeometry(0.78, 1, 48), new THREE.MeshBasicMaterial({ color: look.agent, transparent: true, opacity: 0, depthWrite: false, toneMapped: false }));
    m.renderOrder = 9; scene.add(m);
    return { m, t0: -10 };
  });

  // ---------- Time: a clock the timeline can wait on, which stops while paused ----------
  let t = 0;
  let waits = [];
  const tweens = new Set();
  const wait = (s) => new Promise((r) => waits.push({ until: t + s, r }));
  const tween = (dur, fn) => new Promise((r) => tweens.add({ t0: t, dur, fn, r }));

  function bezier(a, c, b, u, out) {
    const k = 1 - u;
    return out.set(k * k * a.x + 2 * k * u * c.x + u * u * b.x, k * k * a.y + 2 * k * u * c.y + u * u * b.y, k * k * a.z + 2 * k * u * c.z + u * u * b.z);
  }
  const toCam = new THREE.Vector3();
  function moveLight(light, target, dur, arc = 0.55) {
    const a = light.pos.clone();
    return tween(dur, (e) => {
      const b = typeof target === 'function' ? target() : target;
      toCam.subVectors(camera.position, a).normalize();
      const c = a.clone().lerp(b, 0.5).add(new THREE.Vector3(0, arc, 0)).addScaledVector(toCam, arc * 0.9);
      bezier(a, c, b, ease.inOut(e), light.pos);
    });
  }
  function ripple(phone, uv, color) {
    const r = ripples.find((x) => t - x.t0 > 0.7) || ripples[0];
    r.t0 = t; r.phone = phone; r.uv = uv; r.m.material.color.set(color);
  }
  function packet(from, onLand) {
    const p = packets.find((x) => !x.active) || packets[0];
    p.onLand?.();
    p.active = true; p.t0 = t; p.dur = 0.75; p.onLand = onLand; p.a.copy(from); p.b.copy(activityPoint());
    p.c.copy(p.a).lerp(p.b, 0.5); p.c.y += 1.4;
    p.tr.hist = [];
  }
  const hover = (phone, key) => () => phone.point(phone.surface.targets[key], 0.16);
  const touch = (phone, key) => () => phone.point(phone.surface.targets[key], 0.02);

  // An agent tap sends a packet into the window; `line` is logged in Activity when it lands.
  async function press(phone, key, act, line, light = agent, color = look.agent) {
    await moveLight(light, hover(phone, key), 0.95);
    await moveLight(light, touch(phone, key), 0.17, 0.02);
    ripple(phone, phone.surface.targets[key], color);
    act?.();
    if (light === agent) packet(light.pos, line && (() => win.log(line)));
    await moveLight(light, hover(phone, key), 0.26, 0.04);
  }

  // ---------- Who's in control: cue panel, window and light ----------
  let active = 0;
  function select(i) { active = i; win.state.selected = i; phones.forEach((p, n) => { p.status = n === i ? 'agent' : 'running'; }); syncStatus(); }
  function syncStatus() { win.state.status = phones.map((p) => p.status); win.paint(); }
  const callTap = (s) => `<span class="mono">tap</span> “${s}”`;
  const say = (call) => cue.set({ call });
  let handoffMark = false;

  async function actSample() {
    select(0);
    cue.set({ mode: 'agent', label: 'Claude Code is driving', call: '<span class="mono">get_ui</span>' });
    win.log('Opened dev.phonedock.sample');
    await wait(0.4);
    say('<span class="mono">fill</span> “Your name” = “Ada”');
    await press(pixel, 'field', () => surfaces.pixel.set({ focus: true }));
    for (const ch of 'Ada') { await wait(0.16); surfaces.pixel.set({ name: surfaces.pixel.state.name + ch }); }
    win.log('Typed “Ada”');
    await wait(0.25); surfaces.pixel.set({ focus: false });
    say(callTap('Greet'));
    await press(pixel, 'greet', () => surfaces.pixel.set({ greeted: true }), 'Tapped “Greet”');
    say('<span class="mono">wait_for</span> “Hello, Ada!”');
    await wait(0.55);
    say(callTap('Notifications'));
    await press(pixel, 'notif', () => surfaces.pixel.set({ notif: true }), 'Tapped “Notifications”');
    await wait(0.5);
  }
  async function actSettings() {
    select(1);
    say(callTap('Developer'));
    await press(sim, 'developer', () => surfaces.sim.set({ pressed: 'developer' }), 'Tapped “Developer”');
    await wait(0.18);
    surfaces.sim.set({ page: 'developer', pressed: null });
    say(callTap('Dark Appearance'));
    await press(sim, 'dark', () => surfaces.sim.set({ dark: true }), 'Tapped “Dark Appearance”');
    await wait(0.5);
  }
  async function actHandoff() {
    select(2);
    say(callTap('Sign in with Face ID'));
    await press(iphone, 'faceid', () => surfaces.iphone.set({ face: 'scan' }), 'Tapped “Sign in with Face ID”');
    say('<span class="mono">request_human</span>');
    await moveLight(agent, () => iphone.point([0.14, 0.16], 0.2), 0.8);
    // It waits for you: dim the agent's light until it has the phone back.
    tween(0.5, (e) => { agent.visible = 1 - 0.6 * e; });
    // Needs you.
    iphone.status = 'handoff'; win.state.control = 'handoff'; syncStatus();
    win.log('Asked for help: Face ID');
    cue.set({ mode: 'handoff', label: 'Claude Code is waiting for you', call: 'Approve the Face ID prompt, then tap Done.' });
    cue.actions('take');
    handoffMark = true;
    const took = await Promise.race([cue.whenTake(), wait(6.5)]);
    // You're in control.
    iphone.status = 'you'; win.state.control = 'you'; syncStatus();
    win.log('Took over from Claude Code', 'you');
    cue.set({ mode: 'you', label: 'You’re driving', call: 'Agents are locked out while you have it.' });
    cue.actions('done');
    const answered = cue.whenDone();
    human.pos.copy(iphone.point([1.3, 1.1], 1.4));
    human.trail.hist = [];
    human.visible = 1;
    await moveLight(human, hover(iphone, 'faceid'), 0.9, 0.3);
    await moveLight(human, () => iphone.point([0.5, 0.47], 0.03), 0.3, 0.05);
    ripple(iphone, [0.5, 0.47], look.you);
    surfaces.iphone.set({ face: 'ok' });
    await wait(0.7);
    surfaces.iphone.set({ page: 'home', face: 'none' });
    await moveLight(human, () => iphone.point([1.4, 1.2], 1.2), 0.9, 0.2);
    human.visible = 0;
    // Someone who took over gets as long as they need; an untouched demo moves on by itself.
    await (took === 'person' ? answered : Promise.race([answered, wait(2.6)]));
    // Handed back.
    iphone.status = 'agent'; win.state.control = 'agent'; syncStatus();
    agent.visible = 1;
    win.log('Answered Done', 'you');
    cue.set({ mode: 'agent', label: 'Claude Code is driving', call: '<span class="mono">get_ui</span>' });
    cue.actions('none');
    await wait(0.5);
    say(callTap('Lisbon'));
    await press(iphone, 'trip', () => surfaces.iphone.set({ row: 0 }), 'Tapped “Lisbon”');
    await wait(1.1);
  }
  async function resetAll() {
    say('<span class="mono">launch_app</span>');
    await moveLight(agent, () => phones[0].point([0.5, 0.3], 0.2), 1.1, 0.4);
    surfaces.pixel.reset(); surfaces.sim.reset(); surfaces.iphone.reset();
    win.state.log = [];
    await wait(0.35);
  }
  async function timeline() {
    agent.pos.copy(phones[0].point([0.5, 0.3], 0.2));
    for (;;) {
      await actSample();
      await actSettings();
      await actHandoff();
      await resetAll();
    }
  }

  // ---------- Theme ----------
  function applyLook() {
    look = LOOKS[theme];
    scene.background.set(look.bg); scene.fog.color.set(look.bg); [scene.fog.near, scene.fog.far] = look.fog;
    floorMat.color.set(look.floor);
    hemi.color.set(look.hemiSky); hemi.groundColor.set(look.hemiGround); hemi.intensity = look.hemi; fill.intensity = look.fill;
    shared.uCore.value = look.additive ? 1 : 0;
    const blend = look.additive ? THREE.AdditiveBlending : THREE.NormalBlending;
    for (const tr of [agent.trail, human.trail, ...packets.map((p) => p.tr)]) { tr.mat.blending = blend; tr.mat.needsUpdate = true; }
    agent.setColor(look.agent); human.setColor(look.you);
    packets.forEach((p) => p.tr.mat.uniforms.uColor.value.set(look.packet));
    phones.forEach((p) => { p.shadow.material.opacity = look.shadow; p.beam.visible = look.beams > 0; });
    buildEnv();
    win.state.theme = theme; win.paint();
  }
  onTheme((next) => { theme = next; applyLook(); if (paused || !visible) render(); });
  // The theme may have changed while the scene was being built.
  if (opts.currentTheme && opts.currentTheme() !== theme) { theme = opts.currentTheme(); applyLook(); }

  // ---------- Layout and camera ----------
  const camBase = new THREE.Vector3(), camTarget = new THREE.Vector3();
  const pointer = { x: 0, y: 0, sx: 0, sy: 0 };
  let scrollK = 0;
  function layout() {
    const w = stageEl.clientWidth, h = stageEl.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    if (w >= 1081) {
      // The copy sits on the left: fit the phones into the free space to its right, and centre them there.
      const L = 660, R = Math.max(360, w - 40 - L);
      const d = THREE.MathUtils.clamp(7.55 * h / R, 7.4, 11);
      camera.fov = 30;
      const x = -((L - 40) / w) * d * Math.tan(THREE.MathUtils.degToRad(15)) * camera.aspect;
      camBase.set(x, 2.05, d);
      camTarget.set(x, 1.95, -1.2);
    } else {
      // On its own above the copy: fit the three phones across the width and the height, the window behind them.
      camera.fov = 32;
      const t = Math.tan(THREE.MathUtils.degToRad(16));
      const d = Math.max(1.95 / (t * camera.aspect), 1.75 / t);
      camBase.set(0, 2.3, -0.2 + d);
      camTarget.set(0, 2.0, -1.2);
    }
    camera.updateProjectionMatrix();
    shared.uScale.value = (h * renderer.getPixelRatio()) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
  }
  layout();
  new ResizeObserver(() => { layout(); if (paused || !visible) render(); }).observe(stageEl);
  if (!coarse) {
    addEventListener('pointermove', (e) => { pointer.x = (e.clientX / innerWidth) * 2 - 1; pointer.y = (e.clientY / innerHeight) * 2 - 1; }, { passive: true });
  }
  addEventListener('scroll', () => { scrollK = THREE.MathUtils.clamp(scrollY / Math.max(1, stageEl.clientHeight), 0, 1); }, { passive: true });

  // ---------- Frame ----------
  const tmpQ = new THREE.Quaternion();
  function step(dt) {
    t += dt;
    if (waits.length) {
      const due = waits.filter((w) => w.until <= t);
      if (due.length) { waits = waits.filter((w) => w.until > t); due.forEach((w) => w.r()); }
    }
    for (const tw of tweens) {
      const e = Math.min(1, (t - tw.t0) / tw.dur);
      tw.fn(e);
      if (e >= 1) { tweens.delete(tw); tw.r(); }
    }
    // Phones float on their marks; the one in play is lit, the rest wait in a dimmer pool.
    phones.forEach((p, i) => {
      p.group.position.y = p.base.y + Math.sin(t * 0.9 + p.bob) * 0.018;
      p.group.rotation.z = Math.sin(t * 0.6 + p.bob) * 0.008;
      const want = i === active || p.status === 'handoff' || p.status === 'you' ? 1 : look.spotIdle;
      p.lit += (want - p.lit) * Math.min(1, dt * 3);
      p.spot.intensity = look.spot * p.lit;
      p.beam.material.uniforms.uOpacity.value = look.beams * (0.35 + 0.65 * p.lit);
    });
    for (const r of ripples) {
      const e = (t - r.t0) / 0.6;
      if (e < 0 || e > 1 || !r.phone) { r.m.material.opacity = 0; continue; }
      r.m.position.copy(r.phone.point(r.uv, 0.006));
      r.phone.group.getWorldQuaternion(tmpQ); r.m.quaternion.copy(tmpQ);
      r.m.scale.setScalar(0.025 + ease.out(e) * 0.13);
      r.m.material.opacity = 0.9 * (1 - e);
    }
    for (const p of packets) {
      if (!p.active && !p.tr.hist.length) continue;
      const e = (t - p.t0) / p.dur;
      if (p.active) {
        bezier(p.a, p.c, p.b, ease.inOut(Math.min(1, e)), p.p);
        p.tr.push(p.p, t);
        if (e >= 1) { p.active = false; const land = p.onLand; p.onLand = null; land?.(); }
      }
      p.tr.intensity = 1;
      p.tr.update(t);
      if (!p.active && t - p.t0 > p.dur + 0.6) p.tr.hist = [];
    }
    agent.update(t); human.update(t);
    // Camera: a little parallax from the pointer, and a slow rise as the page scrolls away.
    pointer.sx += (pointer.x - pointer.sx) * Math.min(1, dt * 2.5);
    pointer.sy += (pointer.y - pointer.sy) * Math.min(1, dt * 2.5);
    camera.position.set(camBase.x + pointer.sx * 0.45, camBase.y - pointer.sy * 0.22 + scrollK * 0.9, camBase.z + scrollK * 1.2);
    camera.lookAt(camTarget.x + pointer.sx * 0.12, camTarget.y + scrollK * 0.35, camTarget.z);
    placeCue();
  }
  const slot = new THREE.Vector3();
  let cueX = -1, cueY = -1;
  function placeCue() {
    if (!cue.place) return;
    camera.updateMatrixWorld();
    slot.copy(winPoint(win.w / 2, 0)).project(camera);
    const x = (slot.x + 1) / 2 * stageEl.clientWidth, y = (1 - slot.y) / 2 * stageEl.clientHeight;
    if (Math.abs(x - cueX) + Math.abs(y - cueY) < 0.5) return;
    cueX = x; cueY = y;
    cue.place(x, y);
  }
  function render() { renderer.render(scene, camera); }

  // ---------- Run ----------
  let paused = false, visible = true, raf = 0, last = 0;
  let slow = 0;
  function frame(now) {
    raf = 0;
    if (paused || !visible || document.hidden) return;
    const dt = Math.min(0.05, (now - (last || now)) / 1000);
    last = now;
    step(dt); render();
    // Keep it smooth: give up resolution before frames.
    if (dt > 1 / 42) slow++; else slow = Math.max(0, slow - 1);
    if (slow > 50 && dpr > 1) { dpr = Math.max(1, dpr - 0.25); renderer.setPixelRatio(dpr); layout(); slow = 0; }
    raf = requestAnimationFrame(frame);
  }
  function play() { if (!raf && !paused && visible && !document.hidden) { last = 0; raf = requestAnimationFrame(frame); } }

  if (holdButton) {
    holdButton.addEventListener('click', () => {
      paused = !paused;
      holdButton.toggleAttribute('data-paused', paused);
      holdButton.querySelector('[data-hold-label]').textContent = paused ? 'Play' : 'Pause';
      if (paused) { cancelAnimationFrame(raf); raf = 0; } else play();
    });
  }
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) play(); }, { threshold: 0 }).observe(stageEl);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) play(); });

  timeline();

  if (freeze != null) {
    // Poster capture: run the timeline in fixed steps to a moment, then hold that frame.
    paused = true;
    const chan = new MessageChannel();
    const tick = () => new Promise((r) => { chan.port1.onmessage = () => r(); chan.port2.postMessage(0); });
    (async () => {
      const until = freeze === 'handoff' ? null : Number(freeze);
      let extra = 0;
      for (let i = 0; i < 60 * 90; i++) {
        step(1 / 60);
        await tick();
        if (until != null && t >= until) break;
        if (until == null && handoffMark && (extra += 1 / 60) > 0.9) break;
      }
      cueX = cueY = -1; placeCue();
      render();
      stageEl.classList.add('is-live');
      window.__cueAnchor = [cueX / stageEl.clientWidth, cueY / stageEl.clientHeight];
      window.__stageFrozen = true;
    })();
    return;
  }

  // Compile the shaders before the first frame, off the main thread where the browser can.
  await breathe();
  if (renderer.extensions.has('KHR_parallel_shader_compile')) await renderer.compileAsync(scene, camera).catch(() => {});
  else renderer.compile(scene, camera);
  await breathe();
  render();
  requestAnimationFrame(() => { stageEl.classList.add('is-live'); play(); });
}
