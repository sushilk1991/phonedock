// System-prompt detector: a pure function over UI elements (accessibility tree or OCR boxes) that recognises
// permission dialogs, generic alerts and the screens an agent must hand to a human (passcode, Face ID / Touch ID,
// "Allow Paste", profile installs, Apple Account / Google password sheets). No I/O: the daemon feeds it /ui trees.
import type { Bounds, PromptButton, PromptKind, ScreenInfo, SystemPrompt, UiElement, UiTree } from './types.ts';

export type { PromptButton, PromptKind, SystemPrompt };

/** Kinds an agent must never answer itself (handle_alert refuses them). */
export const HUMAN_KINDS: ReadonlySet<PromptKind> = new Set(['passcode', 'biometric', 'allow_paste', 'install_profile', 'credentials']);

// ── text helpers ────────────────────────────────────────────────────────────
/** Straight quotes, single spaces, "..." for "…": OCR and the accessibility tree disagree on these. */
export function normText(s: string): string {
  return s.replace(/[‘’ʼ`´]/g, "'").replace(/[“”„]/g, '"').replace(/…/g, '...')
    .replace(/[   ]/g, ' ').replace(/\s+/g, ' ').trim();
}
const lc = (s: string) => normText(s).toLowerCase();
const shortType = (t: string | undefined) => (t ?? '').split('.').pop() ?? '';
const textOf = (e: UiElement) => normText(e.text ?? e.label ?? e.value ?? '');
/** Display text: as on screen (curly quotes kept), whitespace collapsed. */
const rawOf = (e: UiElement) => (e.text ?? e.label ?? e.value ?? '').replace(/\s+/g, ' ').trim();

function flatten(els: UiElement[], out: UiElement[] = []): UiElement[] {
  for (const e of els) { out.push(e); if (e.children) flatten(e.children, out); }
  return out;
}
const area = (b: Bounds) => Math.max(0, b.width) * Math.max(0, b.height);
const cx = (b: Bounds) => b.x + b.width / 2;
const cy = (b: Bounds) => b.y + b.height / 2;
const inside = (inner: Bounds, outer: Bounds) => cx(inner) >= outer.x && cx(inner) <= outer.x + outer.width && cy(inner) >= outer.y && cy(inner) <= outer.y + outer.height;

// ── button vocabulary ──────────────────────────────────────────────────────
// Ranked: handle_alert(accept) picks the first label present, so the persistent grant beats the one-time one.
const ACCEPT = [
  'allow while using app', 'while using the app', 'allow', 'allow all', 'allow full access', 'allow access to all photos',
  'ok', 'okay', 'continue', 'yes', 'open', 'confirm', 'turn on', 'enable', 'got it', 'done', 'allow once', 'only this time',
  'allow paste', 'install', 'trust', 'try again', 'retry', 'keep only while using', 'change to always allow', 'agree', 'accept',
];
const DISMISS = [
  "don't allow", 'deny', "don't allow paste", 'not now', 'cancel', 'no', 'no thanks', 'close', 'dismiss', 'later',
  'ask app not to track', 'skip', "deny & don't ask again", "don't ask again", 'not allow', 'decline', 'wait',
];
const OTHER = ['settings', 'open settings', 'go to settings', 'limit access...', 'select photos...', 'allow limited access',
  'use passcode', 'enter passcode', 'try face id again', 'use pin', 'use password', 'emergency', 'more info', 'learn more', 'delete', 'remove', 'close app', 'report'];
const KNOWN = new Set([...ACCEPT, ...DISMISS, ...OTHER]);
const isKnownLabel = (t: string) => KNOWN.has(lc(t).replace(/[.!]+$/, (m) => (m === '...' ? m : '')));

/** Android: dialog button ids carry their role. */
function idRole(id: string | undefined): { role?: 'accept' | 'dismiss'; rank: number } | undefined {
  if (!id) return undefined;
  const s = id.replace(/^.*:id\//, '');
  if (/^permission_allow_(foreground_only|always|all|selected)?_?button$/.test(s) || s === 'permission_allow_button') return { role: 'accept', rank: s.includes('foreground') ? 0 : 1 };
  if (s === 'permission_allow_one_time_button') return { role: 'accept', rank: 5 };
  if (/^permission_deny(_and_dont_ask_again)?_button$/.test(s)) return { role: 'dismiss', rank: s.includes('dont_ask') ? 3 : 0 };
  if (/^android:id\/button1$/.test(id)) return { role: 'accept', rank: 2 };
  if (/^android:id\/button2$/.test(id)) return { role: 'dismiss', rank: 2 };
  if (/^android:id\/button3$/.test(id)) return { rank: 9 };
  return undefined;
}
function textRole(t: string): { role?: 'accept' | 'dismiss'; rank: number } {
  const k = lc(t);
  const a = ACCEPT.indexOf(k); if (a >= 0) return { role: 'accept', rank: a };
  const d = DISMISS.indexOf(k); if (d >= 0) return { role: 'dismiss', rank: d };
  return { rank: 99 };
}

// ── classification rules ───────────────────────────────────────────────────
const RE = {
  allowPaste: /\ballow paste\b|\bwould like to paste\b|\bwants to paste\b/i,
  passcode: /\b(enter|type|confirm|create|re-?enter|verify)( your| a| the| device| iphone| ipad| new| old)* passcode\b|\bpasscode required\b|\b(enter|confirm|draw|re-?enter)( your)?( device)? (pin|pattern)\b|\b(enter|confirm)( your)? (device|screen lock) password\b/i,
  biometric: /\b(face|touch|optic) id\b(?! (&|and) passcode)/i,
  biometricAndroid: /\b(use|touch|scan) (your )?fingerprint\b|\bfingerprint sensor\b|\bverify it'?s you\b|\bconfirm it'?s you\b|\bbiometric(s)? (unlock|authentication|prompt)\b/i,
  profile: /\binstall (configuration )?profile\b|\bprofile downloaded\b|\bconfiguration profile\b|\btrying to download a (configuration )?profile\b|\binstall (a |this )?(ca |user )?certificate\b|\bactivate (this )?device admin( app)?\b/i,
  accountCtx: /\bapple (account|id)\b|\bicloud\b|\bitunes( store)?\b|\bapp store\b|\bgoogle account\b|(^|\n) google (\n|$)/i,
  socialButton: /\b(continue|sign in|log in|sign up|login) with (google|apple)\b/i,
  accountStrong: /\bsign in to (the )?(itunes|app) store\b|\benter (the |your )?(apple (account|id) )?password for\b|\b(apple (account|id)|google account) password\b|\bsign in with your apple (account|id)\b/i,
  // the first step of an account sign-in form (email / phone first, password on the next page)
  signInForm: /\bforgot (your )?password\b|\bsign in with an email\b|\b(email|phone) or (phone|email)\b|\bsign in\b.{0,40}\b(email|phone number)\b/i,
  accountIdField: /\b(e-?mail|phone number|username|user name|user[-_ ]?id|apple (account|id)|identifierid)\b|^username[-_]field$/i,
  permission: /\ballow\b.{1,80}?\bto (access|use|take|record|send|find|connect|discover|track|make|manage|view|read|add|see|share|turn on|change|modify|control|interact|post|scan)\b|\b(would like|wants) to (access|use|send|find|track|add|connect|record|join|interact)\b|\bwould like permission\b|\bwould like to send you notifications\b/i,
  permButton: /^(allow while using app|allow once|don't allow|while using the app|only this time|allow all|allow limited access|ask app not to track|allow full access|select photos\.\.\.|limit access\.\.\.|keep only while using|change to always allow|deny|deny & don't ask again|allow access to all photos)$/i,
};

interface Scope {
  container?: UiElement;          // the dialog element (iOS Alert/Sheet, Android dialog root), when known
  els: UiElement[];               // elements in scope (the container's subtree, or the whole screen)
  buttons?: UiElement[];          // structural buttons (Android ids, iOS Button descendants of the container)
}

function isPasswordField(e: UiElement): boolean {
  const t = shortType(e.type);
  if (/^SecureTextField$/i.test(t)) return true;
  const editable = /^(TextField|EditText|TextInputEditText|AppCompatEditText|AutoCompleteTextView|SecureTextField|TextView)$/i.test(t) && (t !== 'TextView' || !!e.clickable);
  const hay = `${e.id ?? ''} ${e.label ?? ''} ${e.text ?? ''} ${e.value ?? ''}`;
  if (editable && /password|passwort|mot de passe|contraseña/i.test(hay)) return true;
  return /^(enter )?(your )?password$/i.test(textOf(e));
}
/** An editable field asking for an account name: email, phone number, username (id, label, hint or shown text). */
function isAccountIdField(e: UiElement): boolean {
  if (!/^(TextField|EditText|TextInputEditText|AppCompatEditText|AutoCompleteTextView)$/i.test(shortType(e.type))) return false;
  return RE.accountIdField.test(`${e.id ?? ''} ${e.label ?? ''} ${e.placeholder ?? ''} ${e.text ?? ''} ${e.value ?? ''}`.replace(/^.*:id\//, ''));
}
const isToggle = (e: UiElement) => e.checked !== undefined || /^(Switch|Toggle|CheckBox|SwitchCompat|SwitchMaterial|MaterialSwitch)$/i.test(shortType(e.type));

/** iOS/Android dialog containers: an Alert/Sheet/Dialog element, an Android permission grant dialog, or an
 *  AlertDialog (android:id/button1..3, alertTitle). */
function findScope(all: UiElement[], screenArea: number): Scope | undefined {
  // Android permission grant dialog (permissioncontroller ids)
  const grant = all.filter((e) => /permissioncontroller:id\/permission_(allow|deny)[a-z_]*button$/.test(e.id ?? ''));
  if (grant.length) {
    const root = all.find((e) => /permissioncontroller:id\/(grant_dialog|grant_singleton)$/.test(e.id ?? ''));
    const msg = all.filter((e) => /permissioncontroller:id\/(permission_message|detail_message|permission_location_accuracy[a-z_]*)$/.test(e.id ?? ''));
    return { container: root, els: root ? flatten([root]) : [...msg, ...grant], buttons: grant };
  }
  // Android AlertDialog
  const dlgButtons = all.filter((e) => /^android:id\/button[123]$/.test(e.id ?? '') && area(e.bounds) > 0);
  const titled = all.filter((e) => /^android:id\/(alertTitle|message)$/.test(e.id ?? ''));
  if (dlgButtons.length || titled.length) {
    const root = all.find((e) => /^android:id\/parentPanel$/.test(e.id ?? ''));
    return { container: root, els: root ? flatten([root]) : [...titled, ...dlgButtons], buttons: dlgButtons };
  }
  // iOS (and anything else that labels its dialogs): the smallest Alert/Sheet/Dialog that isn't full-screen
  const boxes = all.filter((e) => /^(Alert|Sheet|Dialog|AlertDialog)$/i.test(shortType(e.type)) && area(e.bounds) > 0 && (!screenArea || area(e.bounds) < screenArea * 0.92));
  if (boxes.length) {
    const box = boxes.sort((a, b) => area(a.bounds) - area(b.bounds))[0];
    const els = flatten([box]);
    const buttons = els.filter((e) => e !== box && /Button$/i.test(shortType(e.type)) && textOf(e));
    return { container: box, els, buttons };
  }
  return undefined;
}

/** Label-matched buttons near an anchor (title) element, for screens without structure (OCR, unlabelled trees):
 *  below the anchor, within half a screen, contiguous (cut at the first big vertical gap). */
function clusterButtons(cands: UiElement[], anchor: UiElement | undefined, H: number, max = 4): UiElement[] {
  let list = cands.filter((e) => !anchor || (cy(e.bounds) > cy(anchor.bounds) && (!H || cy(e.bounds) - cy(anchor.bounds) < H * 0.5)));
  list = list.sort((a, b) => cy(a.bounds) - cy(b.bounds) || cx(a.bounds) - cx(b.bounds));
  const out: UiElement[] = [];
  for (const e of list) {
    const prev = out[out.length - 1];
    if (prev && H && cy(e.bounds) - cy(prev.bounds) > H * 0.12) break;
    out.push(e);
    if (out.length >= max) break;
  }
  return out;
}

function toButtons(els: UiElement[], source?: 'accessibility' | 'ocr'): PromptButton[] {
  const seen = new Set<string>(); const out: { b: PromptButton; y: number; x: number }[] = [];
  for (const e of els) {
    const text = textOf(e); if (!text) continue;
    const key = `${lc(text)}@${Math.round(cy(e.bounds) / 20)}`;
    if (seen.has(key)) continue; seen.add(key);
    const r = idRole(e.id) ?? textRole(text);
    const b: PromptButton = { text: e.text ?? e.label ?? text, bounds: e.bounds };
    if (e.ref && source !== 'ocr') b.ref = e.ref;
    if (r.role) b.role = r.role;
    out.push({ b, y: cy(e.bounds), x: cx(e.bounds) });
  }
  return out.sort((a, b) => (Math.abs(a.y - b.y) > 8 ? a.y - b.y : a.x - b.x)).map((x) => x.b);
}

const clip = (s: string, n = 90) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** Detect a system prompt in a UI tree (or a plain element list; pass `screen` then for OCR-style clustering).
 *  Returns null for a normal screen. Pure: no I/O, no globals. */
export function detectPrompt(input: UiTree | UiElement[], screen?: ScreenInfo): SystemPrompt | null {
  const tree = Array.isArray(input) ? undefined : input;
  const roots = Array.isArray(input) ? input : input.root;
  const source = tree?.source;
  const all = flatten(roots);
  if (!all.length) return null;
  let W = screen?.width ?? tree?.screen.width ?? 0, H = screen?.height ?? tree?.screen.height ?? 0;
  if (!W || !H) for (const e of all) { W = Math.max(W, e.bounds.x + e.bounds.width); H = Math.max(H, e.bounds.y + e.bounds.height); }
  const ocr = source === 'ocr' || all.every((e) => shortType(e.type) === 'Text' && !e.children);

  const scope = findScope(all, W * H);
  const els = scope?.els ?? all;
  const texts = els.map(textOf).filter(Boolean);
  const joined = texts.join(' \n ');
  const flat = texts.join(' '); // OCR splits sentences over lines
  const scopeButtons = scope?.buttons?.length ? scope.buttons : undefined;
  const labelled = (pool: UiElement[]) => pool.filter((e) => textOf(e) && textOf(e).length <= 40 && isKnownLabel(textOf(e)) && (!H || e.bounds.height < H * 0.3));
  const anchorFor = (re: RegExp) => els.find((e) => re.test(textOf(e)));
  const buttonsNear = (re: RegExp) => scopeButtons ?? clusterButtons(labelled(els), anchorFor(re), H);
  const title = (re?: RegExp) => {
    const a = re ? anchorFor(re) : undefined;
    if (a) return rawOf(a);
    const t = scope?.container ? rawOf(scope.container) : '';
    return t || els.map(rawOf).find((s) => s && !isKnownLabel(s));
  };
  const make = (kind: PromptKind, reason: string, buttons: UiElement[], ttl?: string): SystemPrompt => {
    const p: SystemPrompt = { kind, reason, buttons: toButtons(buttons, ocr ? 'ocr' : source), needsHuman: HUMAN_KINDS.has(kind) };
    if (ttl) p.title = ttl;
    const msg = els.map(rawOf).filter((s) => s && s !== ttl && !isKnownLabel(s) && !/scroll bar/i.test(s)).slice(0, 3).join(' ');
    if (msg && scope) p.message = clip(msg, 300);
    if (source) p.source = source; else if (ocr) p.source = 'ocr';
    return p;
  };

  // 1. needs a human
  if (RE.allowPaste.test(joined)) return make('allow_paste', '"Allow Paste" prompt (an app wants to read the clipboard)', buttonsNear(RE.allowPaste), title(/would like to paste|wants to paste/i));
  const bioEl = els.find((e) => { const t = textOf(e); return t.length <= 120 && !isToggle(e) && (RE.biometric.test(t) || RE.biometricAndroid.test(t)); })
    ?? els.find((e) => /systemui:id\/biometric/.test(e.id ?? ''));
  if (bioEl) return make('biometric', 'Face ID / Touch ID / fingerprint prompt', scopeButtons ?? clusterButtons(labelled(els), bioEl, H), rawOf(bioEl) || undefined);
  if (RE.passcode.test(joined)) return make('passcode', 'passcode / PIN entry', scopeButtons ?? labelled(els), title(RE.passcode));
  if (RE.profile.test(flat)) return make('install_profile', 'configuration profile / certificate install', buttonsNear(RE.profile), title(RE.profile));
  const ctxText = ` \n ${texts.filter((t) => !RE.socialButton.test(t)).join(' \n ')} \n `;
  // Account context alone is not a prompt (the Settings home screen's "Apple Account, Sign in to access your iCloud
  // data…" row is a link): it takes a password field, or an email/phone field on a sign-in form.
  const accountCtx = RE.accountCtx.test(ctxText);
  if (RE.accountStrong.test(flat) || (accountCtx && els.some(isPasswordField)) || (accountCtx && RE.signInForm.test(flat) && els.some(isAccountIdField))) {
    const which = /\bgoogle\b/i.test(ctxText) && !/\bapple\b|\bicloud\b|\bitunes\b|\bapp store\b/i.test(ctxText) ? 'Google' : 'Apple Account';
    const sheet = RE.accountStrong.test(flat) || els.some(isPasswordField);
    return make('credentials', `${which} sign-in ${sheet ? 'password sheet' : 'form (email / phone, then password)'}`, scopeButtons ?? labelled(els), title(RE.accountStrong) ?? title());
  }

  // 2. permission dialogs
  const androidGrant = !!scope?.buttons?.some((e) => /permissioncontroller:id\//.test(e.id ?? ''));
  const permAnchor = anchorFor(RE.permission) ?? (RE.permission.test(flat) ? els.find((e) => /\ballow\b|\bwould like\b|\bwants to\b/i.test(textOf(e))) : undefined);
  if (androidGrant || permAnchor) {
    const btns = scopeButtons ?? clusterButtons(labelled(els), permAnchor, H);
    const hasPermButton = btns.some((e) => RE.permButton.test(lc(textOf(e))) || /^(allow|ok)$/i.test(lc(textOf(e))));
    if (androidGrant || (btns.length && (hasPermButton || !!scope))) {
      let ttl = permAnchor ? rawOf(permAnchor) : title();
      if (ocr && permAnchor) { // OCR: the title wraps over lines; join it with the next line(s) up to the "?"
        const i = els.indexOf(permAnchor); let t = rawOf(permAnchor); let j = i + 1;
        while (!/[?.!]$/.test(t) && j < els.length && j < i + 3 && !isKnownLabel(textOf(els[j]))) t += ' ' + rawOf(els[j++]);
        ttl = t;
      }
      return make('permission', `permission dialog${ttl ? `: ${clip(ttl)}` : ''}`, btns, ttl);
    }
  }

  // 3. generic alerts (1–3 buttons)
  if (scope && scopeButtons && scopeButtons.length >= 1 && scopeButtons.length <= 3) {
    const ttl = title();
    return make('alert', `alert${ttl ? `: ${clip(ttl)}` : ''} (${scopeButtons.length} button${scopeButtons.length > 1 ? 's' : ''})`, scopeButtons, ttl);
  }
  if (ocr && H) {
    // OCR has no structure: ≥2 known alert labels stacked or side by side in the middle band, with a
    // question / title line just above them.
    const ALERTY = /^(ok|okay|cancel|allow|don't allow|not now|close|yes|no|continue|delete|settings|later|dismiss|retry|try again|done)$/i;
    const cands = labelled(all).filter((e) => ALERTY.test(lc(textOf(e))) && cy(e.bounds) > H * 0.2 && cy(e.bounds) < H * 0.85)
      .sort((a, b) => cy(a.bounds) - cy(b.bounds));
    for (let i = 0; i < cands.length; i++) {
      const group = clusterButtons(cands.slice(i), undefined, H, 3);
      if (group.length < 2) continue;
      const top = Math.min(...group.map((e) => e.bounds.y));
      const heading = all.filter((e) => cy(e.bounds) < top && top - cy(e.bounds) < H * 0.3 && /\?$/.test(textOf(e)) && !isKnownLabel(textOf(e)))
        .sort((a, b) => cy(b.bounds) - cy(a.bounds))[0];
      if (!heading) continue;
      const ttl = rawOf(heading);
      return make('alert', `alert: ${clip(ttl)} (${group.length} buttons, OCR)`, group, ttl);
    }
  }
  return null;
}

export type AlertAction = 'accept' | 'dismiss' | { button: string };
/** Which button handle_alert taps. Throws (Error with .code) when it can't decide. Pure. */
export function chooseButton(p: SystemPrompt, action: AlertAction): PromptButton {
  const btns = p.buttons;
  if (!btns.length) throw Object.assign(new Error(`The ${p.kind} prompt has no buttons PhoneDock can see`), { code: 'no_button' });
  if (typeof action === 'object') {
    const want = lc(action.button);
    const hit = btns.find((b) => lc(b.text) === want) ?? btns.filter((b) => lc(b.text).includes(want)).sort((a, b) => a.text.length - b.text.length)[0];
    if (!hit) throw Object.assign(new Error(`No button ${JSON.stringify(action.button)} on the ${p.kind} prompt`), { code: 'no_button' });
    return hit;
  }
  const rankOf = (b: PromptButton) => (action === 'accept' ? ACCEPT : DISMISS).indexOf(lc(b.text));
  const roled = btns.filter((b) => b.role === action);
  if (roled.length) {
    // explicit Android ids win over text ranks (button1/2, permission_allow_foreground_only_button …)
    return roled.map((b) => ({ b, r: rankOf(b) < 0 ? 50 : rankOf(b) })).sort((a, b) => a.r - b.r)[0].b;
  }
  if (btns.length === 1) return btns[0];
  throw Object.assign(new Error(`Can't tell which button means "${action}" on this ${p.kind} prompt`), { code: 'ambiguous_button' });
}

/** One line for humans / agents: `permission dialog: "Allow “Maps” …" — buttons [Allow Once] [Don’t Allow]`. */
export function describePrompt(p: SystemPrompt): string {
  const b = p.buttons.length ? ` — buttons ${p.buttons.map((x) => `[${x.text}]`).join(' ')}` : '';
  return `${p.reason}${b}`;
}
