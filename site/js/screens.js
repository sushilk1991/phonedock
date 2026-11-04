// Phone screens and the PhoneDock window, painted on 2D canvases and used as live textures by the hero stage.
// The sample app, Settings and the window are drawn from captures of the real thing; the sign-in app is made up.

const SYS = '-apple-system, "SF Pro Text", system-ui, "Segoe UI", Roboto, sans-serif';
const DROID = 'Roboto, "Google Sans", -apple-system, system-ui, sans-serif';

export function rr(ctx, x, y, w, h, r) {
  const k = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + k, y);
  ctx.arcTo(x + w, y, x + w, y + h, k);
  ctx.arcTo(x + w, y + h, x, y + h, k);
  ctx.arcTo(x, y + h, x, y, k);
  ctx.arcTo(x, y, x + w, y, k);
  ctx.closePath();
}
function text(ctx, s, x, y, font, color, align = 'left') {
  ctx.font = font; ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = 'alphabetic';
  ctx.fillText(s, x, y);
}
export function sparkle(ctx, cx, cy, a, color) {
  const k = a * 0.18;
  ctx.beginPath();
  ctx.moveTo(cx, cy - a);
  ctx.quadraticCurveTo(cx + k, cy - k, cx + a, cy);
  ctx.quadraticCurveTo(cx + k, cy + k, cx, cy + a);
  ctx.quadraticCurveTo(cx - k, cy + k, cx - a, cy);
  ctx.quadraticCurveTo(cx - k, cy - k, cx, cy - a);
  ctx.fillStyle = color; ctx.fill();
}
function statusBar(ctx, w, color, android = false) {
  text(ctx, android ? '9:41' : '9:41', android ? 26 : 50, android ? 34 : 38, `600 ${android ? 15 : 16}px ${android ? DROID : SYS}`, color, android ? 'left' : 'center');
  // signal, wifi, battery
  ctx.fillStyle = color;
  const bx = w - (android ? 30 : 34);
  const by = android ? 25 : 28;
  for (let i = 0; i < 4; i++) ctx.fillRect(bx - 62 + i * 5, by + 6 - i * 2.4, 3.2, 4 + i * 2.4);
  ctx.beginPath(); ctx.arc(bx - 29, by + 9, 9, -2.4, -0.74); ctx.lineWidth = 2.4; ctx.strokeStyle = color; ctx.stroke();
  ctx.beginPath(); ctx.arc(bx - 29, by + 9, 4.5, -2.4, -0.74); ctx.stroke();
  rr(ctx, bx - 14, by - 1, 24, 12, 3.5); ctx.lineWidth = 1.2; ctx.globalAlpha = 0.45; ctx.stroke(); ctx.globalAlpha = 1;
  rr(ctx, bx - 12, by + 1, 17, 8, 2); ctx.fill();
}

class Surface {
  constructor(w, h, scale) {
    this.w = w; this.h = h; this.scale = scale;
    this.canvas = document.createElement('canvas');
    this.canvas.width = Math.round(w * scale); this.canvas.height = Math.round(h * scale);
    this.ctx = this.canvas.getContext('2d');
    this.version = 0;
  }
  paint() {
    const { ctx } = this;
    ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    this.draw(ctx, this.w, this.h);
    this.version++;
    this.onPaint?.();
  }
  set(patch) { Object.assign(this.state, patch); this.paint(); }
}

// Android emulator: the PhoneDock Sample app (fixtures/android-sample), drawn from a capture of the real app.
export class SampleApp extends Surface {
  constructor(scale = 2) {
    super(360, 808, scale);
    this.state = { name: '', focus: false, greeted: false, notif: false };
    this.targets = { field: [0.5, 0.164], greet: [0.164, 0.228], notif: [0.875, 0.348] };
    this.paint();
  }
  reset() { this.state = { name: '', focus: false, greeted: false, notif: false }; this.paint(); }
  draw(c, w, h) {
    const s = this.state;
    const ink = '#1b1b1f', sub = '#6e6e76', accent = '#465b8f';
    c.fillStyle = '#eeedf4'; c.fillRect(0, 0, w, h);
    statusBar(c, w, '#45454c', true);
    text(c, 'PhoneDock Sample', 21, 92, `700 23px ${DROID}`, ink);
    // Name field: an underlined EditText.
    if (s.name) text(c, s.name, 25, 139, `400 17px ${DROID}`, ink);
    else text(c, 'Your name', 25, 139, `400 17px ${DROID}`, '#77777f');
    if (s.focus) { c.font = `400 17px ${DROID}`; c.fillStyle = accent; c.fillRect(26 + c.measureText(s.name).width, 122, 2, 22); }
    c.fillStyle = s.focus || s.name ? accent : '#77777f'; c.fillRect(24, 146, 312, s.focus ? 2 : 1.2);
    // Greet: a plain grey Button.
    c.save(); c.shadowColor = 'rgba(0,0,0,.22)'; c.shadowBlur = 3; c.shadowOffsetY = 1.5;
    rr(c, 24, 168, 71, 32, 3); c.fillStyle = '#d6d6d8'; c.fill(); c.restore();
    text(c, 'Greet', 59.5, 189, `500 13px ${DROID}`, '#2b2b30', 'center');
    if (s.greeted) text(c, `Hello, ${s.name || 'Ada'}!`, 21, 234, `400 18px ${DROID}`, '#5f5f66');
    text(c, 'Notifications', 21, 287, `400 16.5px ${DROID}`, ink);
    // Switch
    const sx = 302, sy = 281;
    rr(c, sx - 14, sy - 7, 28, 14, 7); c.fillStyle = s.notif ? '#b3bcd6' : '#c4c4c9'; c.fill();
    c.save(); c.shadowColor = 'rgba(0,0,0,.25)'; c.shadowBlur = 3; c.shadowOffsetY = 1;
    c.beginPath(); c.arc(s.notif ? sx + 12 : sx - 12, sy, 9, 0, 7); c.fillStyle = s.notif ? accent : '#f7f7f9'; c.fill(); c.restore();
    text(c, s.notif ? 'Notifications on' : 'Notifications off', 21, 322, `400 13px ${DROID}`, sub);
    c.save(); c.shadowColor = 'rgba(0,0,0,.22)'; c.shadowBlur = 3; c.shadowOffsetY = 1.5;
    rr(c, 24, 359, 71, 32, 3); c.fillStyle = '#d6d6d8'; c.fill(); c.restore();
    text(c, 'Crash', 59.5, 380, `500 13px ${DROID}`, '#2b2b30', 'center');
    rr(c, w / 2 - 54, h - 14, 108, 4.5, 3); c.fillStyle = '#1b1b1f'; c.globalAlpha = 0.7; c.fill(); c.globalAlpha = 1;
  }
}

// iOS simulator: Settings › Developer › Dark Appearance, drawn from a capture of iOS 26.5.
export class SettingsApp extends Surface {
  constructor(scale = 2) {
    super(360, 782, scale);
    this.state = { page: 'root', dark: false, pressed: null };
    this.targets = { developer: [0.5, 0.79], dark: [0.835, 0.226] };
    this.paint();
  }
  reset() { this.state = { page: 'root', dark: false, pressed: null }; this.paint(); }
  draw(c, w, h) {
    const d = this.state.dark;
    const bg = d ? '#000000' : '#f2f2f7', card = d ? '#1c1c1e' : '#ffffff', ink = d ? '#ffffff' : '#000000';
    const sub = d ? '#8d8d93' : '#6d6d72', sep = d ? '#38383a' : '#dcdce0', blue = d ? '#0a84ff' : '#007aff', green = d ? '#30d158' : '#34c759';
    c.fillStyle = bg; c.fillRect(0, 0, w, h);
    statusBar(c, w, ink);
    const chev = (x, y) => { c.strokeStyle = d ? '#5a5a5f' : '#c4c4c7'; c.lineWidth = 2.2; c.lineCap = 'round'; c.beginPath(); c.moveTo(x, y - 6); c.lineTo(x + 6, y); c.lineTo(x, y + 6); c.stroke(); };
    const sw = (x, y, on) => {
      rr(c, x, y - 15, 56, 30, 15); c.fillStyle = on ? green : (d ? '#39393d' : '#e9e9eb'); c.fill();
      c.save(); c.shadowColor = 'rgba(0,0,0,.18)'; c.shadowBlur = 4; c.shadowOffsetY = 1;
      rr(c, on ? x + 20 : x + 3, y - 12, 33, 24, 12); c.fillStyle = '#fff'; c.fill(); c.restore();
    };
    const group = (y, rows, rh = 47) => {
      rr(c, 18, y, w - 36, rows.length * rh, Math.min(24, rows.length * rh / 2)); c.fillStyle = card; c.fill();
      rows.forEach((r, i) => {
        const ry = y + i * rh;
        if (this.state.pressed && this.state.pressed === r.key) { c.save(); rr(c, 18, ry, w - 36, rh, 24); c.clip(); c.fillStyle = d ? 'rgba(255,255,255,.1)' : 'rgba(0,0,0,.07)'; c.fillRect(18, ry, w - 36, rh); c.restore(); }
        let tx = 32;
        if (r.icon) { rr(c, 30, ry + 9, 29, 29, 7.5); c.fillStyle = r.icon; c.fill(); tx = 72; }
        text(c, r.label, tx, ry + 29, `400 16.5px ${SYS}`, r.blue ? blue : ink);
        if (r.value) text(c, r.value, w - 52, ry + 29, `400 16.5px ${SYS}`, sub, 'right');
        if (r.sw != null) sw(w - 92, ry + rh / 2, r.sw); else if (!r.blue) chev(w - 42, ry + rh / 2);
        if (i < rows.length - 1) { c.fillStyle = sep; c.fillRect(tx, ry + rh - 0.5, w - 18 - tx, 1); }
      });
    };
    if (this.state.page === 'root') {
      text(c, 'Settings', 20, 104, `700 32px ${SYS}`, ink);
      group(126, [{ label: 'General', icon: '#8e8e93' }, { label: 'Accessibility', icon: '#0a84ff' }, { label: 'Camera', icon: '#636366' }, { label: 'Home Screen & App Library', icon: '#5e5ce6' }]);
      group(330, [{ label: 'Screen Time', icon: '#5e5ce6' }]);
      group(395, [{ label: 'Passcode', icon: '#ff3b30' }, { label: 'Privacy & Security', icon: '#0a84ff' }]);
      group(507, [{ label: 'Apps', icon: '#7d4dff' }]);
      group(572, [{ label: 'Developer', icon: '#8e8e93', key: 'developer' }]);
      rr(c, 30, 714, w - 60, 42, 21); c.fillStyle = d ? '#1c1c1e' : '#e4e4e9'; c.fill();
      text(c, 'Search', 66, 741, `400 16.5px ${SYS}`, sub);
      c.strokeStyle = sub; c.lineWidth = 2; c.beginPath(); c.arc(50, 733, 6, 0, 7); c.moveTo(54.5, 737.5); c.lineTo(59, 742); c.stroke();
    } else {
      c.save(); c.shadowColor = 'rgba(0,0,0,.12)'; c.shadowBlur = 10; c.shadowOffsetY = 2;
      c.beginPath(); c.arc(34, 76, 21, 0, 7); c.fillStyle = d ? '#2c2c2e' : '#ffffff'; c.fill(); c.restore();
      c.strokeStyle = ink; c.lineWidth = 2.6; c.lineCap = 'round'; c.beginPath(); c.moveTo(38, 67); c.lineTo(29, 76); c.lineTo(38, 85); c.stroke();
      text(c, 'Developer', w / 2, 82, `600 16.5px ${SYS}`, ink, 'center');
      const head = (s, y) => text(c, s, 32, y, `600 16px ${SYS}`, sub);
      const foot = (lines, y) => lines.forEach((s, i) => text(c, s, 32, y + i * 15, `400 12px ${SYS}`, sub));
      head('Appearance', 145); group(154, [{ label: 'Dark Appearance', sw: d }], 47);
      head('Display Zoom', 248); group(258, [{ label: 'View', value: 'Default' }]);
      foot(['Choose a view for iPhone. Zoomed shows larger', 'controls. Standard shows more content.'], 323);
      head('Paired Devices', 377); group(386, [{ label: 'Clear Trusted Computers', blue: true }]);
      head('UI Automation', 500); group(509, [{ label: 'Enable UI Automation', sw: true }]);
      head('Performance', 598); group(606, [{ label: 'L4S' }]);
    }
    rr(c, w / 2 - 68, h - 12, 136, 5, 3); c.fillStyle = ink; c.fill();
  }
}

function faceGlyph(c, cx, cy, s, color, ok) {
  c.save(); c.translate(cx - s / 2, cy - s / 2); c.scale(s / 48, s / 48);
  c.strokeStyle = color; c.lineWidth = 2.6; c.lineCap = 'round'; c.lineJoin = 'round';
  if (ok) {
    c.beginPath(); c.arc(24, 24, 20, 0, 7); c.stroke();
    c.beginPath(); c.moveTo(15, 25); c.lineTo(21.5, 31); c.lineTo(33, 18); c.stroke();
  } else {
    const p = new Path2D('M4 15V9a5 5 0 0 1 5-5h6M33 4h6a5 5 0 0 1 5 5v6M44 33v6a5 5 0 0 1-5 5h-6M15 44H9a5 5 0 0 1-5-5v-6M16 18v3M32 18v3M24 18v9h-2M18 33c3.5 3 8.5 3 12 0');
    c.stroke(p);
  }
  c.restore();
}

// The real iPhone in the foreground: a sign-in that needs Face ID, so the agent asks for a person.
export class SignInApp extends Surface {
  constructor(scale = 2) {
    super(360, 780, scale);
    this.state = { page: 'signin', face: 'none', row: -1 };
    this.targets = { faceid: [0.5, 0.802], trip: [0.5, 0.36] };
    this.paint();
  }
  reset() { this.state = { page: 'signin', face: 'none', row: -1 }; this.paint(); }
  draw(c, w, h) {
    const s = this.state;
    const g = c.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#eef4f3'); g.addColorStop(1, '#ffffff');
    c.fillStyle = g; c.fillRect(0, 0, w, h);
    statusBar(c, w, '#0b1514');
    if (s.page === 'signin') {
      rr(c, w / 2 - 38, 168, 76, 76, 20); c.fillStyle = '#0f766e'; c.fill();
      c.strokeStyle = '#ffffff'; c.lineWidth = 4; c.lineCap = 'round';
      c.beginPath(); c.moveTo(w / 2 - 16, 218); c.lineTo(w / 2, 186); c.lineTo(w / 2 + 16, 218); c.stroke();
      c.beginPath(); c.moveTo(w / 2 - 9, 206); c.lineTo(w / 2 + 9, 206); c.stroke();
      text(c, 'Welcome back', w / 2, 300, `700 30px ${SYS}`, '#0b1514', 'center');
      text(c, 'Sign in to see your trips.', w / 2, 330, `400 17px ${SYS}`, '#4a5654', 'center');
      rr(c, 24, 600, w - 48, 54, 27); c.fillStyle = '#0b1514'; c.fill();
      faceGlyph(c, 92, 627, 22, '#ffffff', false);
      text(c, 'Sign in with Face ID', w / 2 + 14, 633, `600 17px ${SYS}`, '#ffffff', 'center');
      text(c, 'Use password', w / 2, 690, `500 16px ${SYS}`, '#0f766e', 'center');
      if (s.face !== 'none') {
        c.fillStyle = 'rgba(0,0,0,0.28)'; c.fillRect(0, 0, w, h);
        rr(c, w / 2 - 82, 300, 164, 164, 30); c.fillStyle = 'rgba(28,28,30,0.94)'; c.fill();
        faceGlyph(c, w / 2, 368, 70, s.face === 'ok' ? '#30d158' : '#ffffff', s.face === 'ok');
        text(c, 'Face ID', w / 2, 440, `600 16px ${SYS}`, '#ffffff', 'center');
      }
    } else {
      text(c, 'Your trips', 22, 112, `700 33px ${SYS}`, '#0b1514');
      const trips = [['Lisbon', '14 – 18 Nov', '#0f766e'], ['Kyoto', '8 – 15 Dec', '#b45309'], ['Reykjavík', '2 – 6 Feb', '#1d4ed8']];
      trips.forEach(([city, when, col], i) => {
        const y = 148 + i * 104;
        rr(c, 16, y, w - 32, 90, 22); c.fillStyle = s.row === i ? '#dfeceb' : '#ffffff'; c.fill();
        c.lineWidth = 1; c.strokeStyle = 'rgba(11,21,20,0.08)'; c.stroke();
        rr(c, 30, y + 16, 58, 58, 14); c.fillStyle = col; c.fill();
        text(c, city, 104, y + 42, `600 19px ${SYS}`, '#0b1514');
        text(c, when, 104, y + 66, `400 15px ${SYS}`, '#4a5654');
      });
      rr(c, 16, 470, w - 32, 54, 27); c.fillStyle = '#0f766e'; c.fill();
      text(c, 'Plan a trip', w / 2, 503, `600 17px ${SYS}`, '#ffffff', 'center');
    }
    rr(c, w / 2 - 68, h - 14, 136, 5, 3); c.fillStyle = '#0b1514'; c.fill();
  }
}

// The PhoneDock window, drawn from captures of the real app: the Devices sidebar, the toolbar, the selected device
// with its top bar, and the Activity inspector grouped by who acted.
export class MacWindow extends Surface {
  constructor(phones, scale = 1) {
    super(1280, 800, scale);
    this.phones = phones; // [{ name, sub, surface, kind }]
    this.state = { selected: 0, control: 'agent', theme: 'dark', log: [], status: ['running', 'running', 'running'] };
    this.mirror = { cx: 630, cy: 431, h: 640 };
    this.activity = { x: 1070, y: 156 }; // where the newest Activity line lands
    this.paint();
  }
  log(line, who = 'agent') { this.state.log.unshift({ line, who }); this.state.log.length = Math.min(this.state.log.length, 12); this.paint(); }
  draw(c, w, h) {
    const s = this.state; const dark = s.theme === 'dark';
    const P = dark
      ? { side: '#2d2d30', content: '#1f1f21', stage: '#151517', insp: '#2a2a2d', ink: '#f2f2f5', ink2: '#a1a1a8', sep: 'rgba(255,255,255,.09)', card: '#2c2c2f', handoffTint: '#4b3f2d', youTint: '#2c2b52', handoffInk: '#ff9f0a', youInk: '#a5a3ff', agent: '#bf5af2' }
      : { side: '#e6e6ea', content: '#f6f6f8', stage: '#ececf0', insp: '#efeff2', ink: '#1d1d1f', ink2: '#5f5f66', sep: 'rgba(0,0,0,.1)', card: '#ffffff', handoffTint: '#f3e2d6', youTint: '#e1e1f8', handoffInk: '#9a3d00', youInk: '#5856d6', agent: '#af52de' };
    const accent = '#5856d6';
    const SB = 300, IN = 960, TB = 62;
    c.fillStyle = P.content; c.fillRect(0, 0, w, h);
    // Sidebar
    c.fillStyle = P.side; c.fillRect(0, 0, SB, h);
    ['#ff5f57', '#febc2e', '#28c840'].forEach((col, i) => { c.beginPath(); c.arc(26 + i * 22, 30, 7, 0, 7); c.fillStyle = col; c.fill(); });
    text(c, 'Devices', 22, 84, `600 13px ${SYS}`, P.ink2);
    const dotFor = (st) => (st === 'handoff' ? '#ff9f0a' : st === 'you' ? '#8f8cff' : st === 'agent' ? P.agent : '#30d158');
    this.phones.forEach((p, i) => {
      const y = 98 + i * 58; const on = i === s.selected;
      if (on) { rr(c, 12, y, SB - 24, 52, 10); c.fillStyle = accent; c.fill(); }
      const ic = on ? '#ffffff' : P.ink2;
      c.strokeStyle = ic; c.lineWidth = 1.6; rr(c, 30, y + 15, 12, 22, 3); c.stroke();
      text(c, p.name, 56, y + 23, `600 15.5px ${SYS}`, on ? '#ffffff' : P.ink);
      text(c, p.sub, 56, y + 42, `400 13px ${SYS}`, on ? 'rgba(255,255,255,.82)' : P.ink2);
      c.beginPath(); c.arc(SB - 34, y + 26, 5.5, 0, 7); c.fillStyle = dotFor(s.status[i]); c.fill();
      if (on) { c.lineWidth = 1.5; c.strokeStyle = 'rgba(255,255,255,.9)'; c.stroke(); }
    });
    c.fillStyle = P.sep; c.fillRect(SB, 0, 1, h);
    // Toolbar
    const sel = this.phones[s.selected];
    text(c, sel.name, SB + 22, 28, `700 16px ${SYS}`, P.ink);
    text(c, sel.sub, SB + 22, 47, `400 13px ${SYS}`, P.ink2);
    c.strokeStyle = P.ink2; c.lineWidth = 1.7;
    [IN - 220, IN - 170, IN - 120, IN - 70].forEach((x, i) => {
      c.beginPath();
      if (i === 0) { c.arc(x, 31, 8, -1.1, 4.25); c.moveTo(x, 21); c.lineTo(x, 30); }
      else if (i === 1) { rr(c, x - 10, 24, 20, 14, 3); c.moveTo(x + 3.5, 31); c.arc(x, 31, 3.5, 0, 7); }
      else if (i === 2) { c.arc(x, 31, 9, 0, 7); c.stroke(); c.beginPath(); c.arc(x, 31, 4, 0, 7); c.fillStyle = P.ink2; c.fill(); return; }
      else { c.moveTo(x - 8, 31); c.lineTo(x + 8, 31); c.moveTo(x, 23); c.lineTo(x, 39); }
      c.stroke();
    });
    c.fillStyle = P.sep; c.fillRect(SB, TB, IN - SB, 1);
    c.fillStyle = P.stage; c.fillRect(SB + 1, TB + 1, IN - SB - 1, h - TB);
    // Inspector: Activity, newest first, grouped by who acted
    c.fillStyle = P.insp; c.fillRect(IN, 0, w - IN, h);
    c.fillStyle = P.sep; c.fillRect(IN, 0, 1, h); c.fillRect(IN, TB, w - IN, 1);
    text(c, 'Activity', IN + 20, 100, `700 16px ${SYS}`, P.ink);
    let y = 136; let prev = null;
    for (const e of s.log) {
      if (y > h - 30) break;
      if (e.who !== prev) {
        if (prev) y += 10;
        if (e.who === 'agent') sparkle(c, IN + 30, y - 5, 8, P.agent);
        else { c.fillStyle = P.youInk; c.beginPath(); c.arc(IN + 30, y - 10, 3.6, 0, 7); c.fill(); c.beginPath(); c.arc(IN + 30, y + 1, 6.4, Math.PI, 0); c.fill(); }
        text(c, e.who === 'agent' ? 'Claude Code' : 'You', IN + 46, y, `600 15px ${SYS}`, P.ink);
        y += 26; prev = e.who;
      }
      c.save(); c.beginPath(); c.rect(IN + 46, y - 18, 186, 26); c.clip();
      text(c, e.line, IN + 46, y, `400 14px ${SYS}`, P.ink);
      c.restore();
      text(c, '9:41 AM', w - 18, y, `400 13px ${SYS}`, P.ink2, 'right');
      y += 25;
    }
    // The selected device, live
    const m = this.mirror; const sur = sel.surface;
    const mh = m.h, mw = mh * (sur.w / sur.h);
    const x = m.cx - mw / 2, my = m.cy - mh / 2;
    c.save(); c.shadowColor = 'rgba(0,0,0,.35)'; c.shadowBlur = 30; c.shadowOffsetY = 12;
    rr(c, x - 9, my - 9, mw + 18, mh + 18, (mw + 18) * (sel.kind === 'pixel' ? 0.09 : 0.14)); c.fillStyle = '#0b0b0c'; c.fill(); c.restore();
    c.save(); rr(c, x, my, mw, mh, mw * (sel.kind === 'pixel' ? 0.07 : 0.12)); c.clip();
    c.drawImage(sur.canvas, x, my, mw, mh); c.restore();
  }
}
