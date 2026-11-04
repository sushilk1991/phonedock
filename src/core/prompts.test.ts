// Unit tests for the system-prompt detector (src/core/prompts.ts). Run: npm test
// Fixtures are trimmed from real captures (iPhone 17 Pro simulator 1206x2622, Pixel emulator 1080x2424) plus
// synthetic screens for prompts that can't be raised on demand (Allow Paste, Face ID, passcode, sign-in sheets).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseButton, describePrompt, detectPrompt, HUMAN_KINDS, normText } from './prompts.ts';
import type { SystemPrompt } from './prompts.ts';
import type { UiElement, UiTree } from './types.ts';

type Box = [x: number, y: number, w: number, h: number];
let n = 0;
function el(type: string, text: string | undefined, b: Box, extra: Partial<UiElement> = {}): UiElement {
  const e: UiElement = { ref: `e${++n}`, type, bounds: { x: b[0], y: b[1], width: b[2], height: b[3] }, ...extra };
  if (text !== undefined) { e.text = text; if (!type.includes('.') && !/View$|Layout$/.test(type)) e.label = text; }
  return e;
}
const tree = (source: UiTree['source'], width: number, height: number, root: UiElement[]): UiTree =>
  ({ source, screen: { width, height }, root, capturedAt: '2026-11-03T00:00:00.000Z' });
const ocr = (width: number, height: number, rows: [string, ...Box][]): UiTree =>
  tree('ocr', width, height, rows.map(([t, ...b]) => el('Text', t, b as Box)));
const IOS = [1206, 2622] as const;
const AND = [1080, 2424] as const;
const texts = (p: SystemPrompt | null) => p?.buttons.map((b) => b.text) ?? [];
const pick = (p: SystemPrompt | null, a: Parameters<typeof chooseButton>[1]) => { assert.ok(p); return chooseButton(p, a); };

// ── fixtures: permission dialogs ─────────────────────────────────────────────
const iosMapsLocation = () => tree('accessibility', ...IOS, [
  el('Application', ' ', [0, 0, 1206, 2622], { children: [
    el('Group', 'Maps', [0, 0, 1206, 2622], { id: 'card:com.apple.Maps:sceneID:com.apple.Maps-1', children: [
      el('StaticText', '9:12 PM', [171, 67, 103, 61]),
      el('GenericElement', '100% battery power', [1018, 78, 82, 39]),
    ] }),
  ] }),
  el('Sheet', 'Allow “Maps” to use your location?', [123, 804, 960, 1098], { children: [
    el('StaticText', 'Allow “Maps” to use your location?', [213, 870, 780, 127]),
    el('StaticText', 'Your location is used to show your position on the map, get directions, estimate travel times, improve search results and display relevant ads where available in Maps.', [213, 1019, 780, 294]),
    el('Slider', 'Vertical scroll bar, 2 pages', [984, 804, 90, 522], { clickable: true, value: '0%' }),
    el('Other', undefined, [123, 1326, 960, 576], { children: [
      el('Button', 'Allow Once', [171, 1374, 864, 144], { clickable: true }),
      el('Button', 'Allow While Using App', [171, 1542, 864, 144], { clickable: true }),
      el('Button', 'Don’t Allow', [171, 1710, 864, 144], { clickable: true }),
    ] }),
  ] }),
]);

const iosMapsLocationOcr = () => ocr(...IOS, [
  ['9:13', 167, 76, 110, 46], ['• Urumq', 814, 144, 130, 39],
  ['Allow "Maps" to use', 213, 873, 483, 61], ['your location?', 209, 948, 340, 51],
  ['Your location is used to show your', 209, 1026, 708, 49], ['position on the map, get directions,', 213, 1090, 727, 53],
  ['where available in Maps.', 213, 1262, 503, 53],
  ['Allow Once', 472, 1429, 263, 42], ['Allow While Using App', 339, 1593, 529, 53], ["Don't Allow", 468, 1765, 266, 42],
  // the app's own onboarding card behind the dim layer: must not become a prompt button
  ['about your photos and reports.', 247, 1944, 711, 50], ['Enable Notifications', 361, 2256, 483, 53], ['Not Now', 498, 2412, 206, 43],
]);

const PC = 'com.android.permissioncontroller:id/';
const androidCameraGrant = () => tree('accessibility', ...AND, [
  el('FrameLayout', undefined, [28, 757, 1024, 988], { id: 'android:id/content', children: [
    el('LinearLayout', undefined, [28, 757, 1024, 988], { id: `${PC}grant_singleton`, clickable: true, children: [
      el('LinearLayout', undefined, [28, 757, 1024, 988], { id: `${PC}grant_dialog`, clickable: true, children: [
        el('LinearLayout', undefined, [70, 799, 940, 375], { id: `${PC}content_container`, children: [
          el('ImageView', undefined, [498, 862, 84, 84], { id: `${PC}permission_icon` }),
          el('TextView', 'Allow Camera to take pictures and record video?', [133, 978, 814, 133], { id: `${PC}permission_message` }),
        ] }),
        el('Button', 'While using the app', [133, 1179, 814, 147], { id: `${PC}permission_allow_foreground_only_button`, clickable: true }),
        el('Button', 'Only this time', [133, 1336, 814, 147], { id: `${PC}permission_allow_one_time_button`, clickable: true }),
        el('Button', 'Don’t allow', [133, 1493, 814, 147], { id: `${PC}permission_deny_button`, clickable: true }),
      ] }),
    ] }),
  ] }),
]);

const androidCameraGrantOcr = () => ocr(...AND, [
  ['Allow Camera to take pictures and', 137, 994, 806, 56], ['record video?', 373, 1049, 331, 61],
  ['While using the app', 376, 1234, 325, 49], ['Only this time', 425, 1398, 229, 41], ["Don't allow", 447, 1553, 187, 37],
]);

// ── fixtures: prompts that need a human ──────────────────────────────────────
const iosAllowPaste = () => tree('accessibility', ...IOS, [
  el('Application', 'Safari', [0, 0, 1206, 2622]),
  el('Alert', '“Safari” would like to paste from “Notes”', [168, 1080, 870, 462], { children: [
    el('StaticText', '“Safari” would like to paste from “Notes”', [216, 1128, 774, 120]),
    el('StaticText', 'Do you want to allow this?', [216, 1260, 774, 60]),
    el('Button', 'Don’t Allow Paste', [168, 1392, 435, 150], { clickable: true }),
    el('Button', 'Allow Paste', [603, 1392, 435, 150], { clickable: true }),
  ] }),
]);

const iosFaceId = () => tree('accessibility', ...IOS, [
  el('Application', 'App Store', [0, 0, 1206, 2622]),
  el('Other', undefined, [403, 1011, 400, 400], { children: [el('StaticText', 'Face ID', [453, 1300, 300, 60])] }),
]);

const androidBiometricPrompt = () => tree('accessibility', ...AND, [
  el('FrameLayout', undefined, [0, 1300, 1080, 1124], { id: 'com.android.systemui:id/biometric_prompt_layout', children: [
    el('TextView', 'Confirm it’s you', [80, 1380, 920, 80], { id: 'com.android.systemui:id/title' }),
    el('TextView', 'Touch the fingerprint sensor', [80, 1900, 920, 60], { id: 'com.android.systemui:id/indicator' }),
    el('Button', 'Use PIN', [60, 2200, 300, 120], { id: 'com.android.systemui:id/button_use_credential', clickable: true }),
    el('Button', 'Cancel', [720, 2200, 300, 120], { id: 'com.android.systemui:id/button_negative', clickable: true }),
  ] }),
]);

const iosPasscode = () => tree('accessibility', ...IOS, [
  el('Other', undefined, [0, 0, 1206, 2622], { children: [
    el('StaticText', 'Enter iPhone Passcode', [300, 600, 606, 80]),
    el('SecureTextField', undefined, [300, 760, 606, 60], { value: '' }),
    el('Button', 'Cancel', [900, 2400, 240, 120], { clickable: true }),
  ] }),
]);

const iosAppStoreSignIn = () => tree('accessibility', ...IOS, [
  el('Alert', 'Sign In to the App Store', [168, 900, 870, 760], { children: [
    el('StaticText', 'Sign In to the App Store', [216, 950, 774, 70]),
    el('StaticText', 'Enter the password for user@example.com.', [216, 1030, 774, 110]),
    el('SecureTextField', 'Password', [216, 1180, 774, 110], { value: '' }),
    el('Button', 'Cancel', [168, 1510, 435, 150], { clickable: true }),
    el('Button', 'Sign In', [603, 1510, 435, 150], { clickable: true }),
  ] }),
]);

const iosProfileDownloaded = () => tree('accessibility', ...IOS, [
  el('Alert', 'Profile Downloaded', [168, 1000, 870, 520], { children: [
    el('StaticText', 'Profile Downloaded', [216, 1040, 774, 70]),
    el('StaticText', 'Review the profile in Settings app if you want to install it.', [216, 1120, 774, 120]),
    el('Button', 'Close', [168, 1370, 870, 150], { clickable: true }),
  ] }),
]);

// ── fixtures: generic alerts ─────────────────────────────────────────────────
const androidForceStop = () => tree('accessibility', ...AND, [
  el('FrameLayout', undefined, [77, 950, 926, 520], { id: 'android:id/parentPanel', children: [
    el('TextView', 'Force stop?', [140, 1010, 800, 80], { id: 'android:id/alertTitle' }),
    el('TextView', 'If you force stop an app, it may misbehave.', [140, 1110, 800, 120], { id: 'android:id/message' }),
    el('Button', 'Cancel', [560, 1330, 200, 110], { id: 'android:id/button2', clickable: true }),
    el('Button', 'OK', [780, 1330, 160, 110], { id: 'android:id/button1', clickable: true }),
  ] }),
]);

const iosDeleteAlertOcr = () => ocr(...IOS, [
  ['Settings', 60, 160, 300, 80], ['General', 120, 600, 260, 70],
  ['Delete this shortcut?', 300, 1150, 606, 60], ['Delete', 520, 1330, 166, 50], ['Cancel', 520, 1480, 166, 50],
]);

// ── fixtures: normal screens (must stay null) ────────────────────────────────
const androidSettingsRoot = () => tree('accessibility', ...AND, [
  el('FrameLayout', undefined, [0, 0, 1080, 2424], { children: [
    el('TextView', 'Search Settings', [189, 222, 389, 71], { id: 'com.android.settings:id/search_bar_title' }),
    el('TextView', 'Google', [210, 436, 167, 71], { id: 'android:id/title' }),
    el('TextView', 'Services & preferences', [210, 507, 379, 51], { id: 'android:id/summary' }),
    el('TextView', 'Network & internet', [210, 684, 436, 71], { id: 'android:id/title' }),
    el('TextView', 'Apps', [210, 1138, 122, 71], { id: 'android:id/title' }),
    el('TextView', 'Notifications', [210, 1344, 300, 71], { id: 'android:id/title' }),
    el('TextView', 'Security & privacy', [210, 1756, 420, 71], { id: 'android:id/title' }),
    el('TextView', 'App security, device lock, permissions', [210, 1827, 600, 51], { id: 'android:id/summary' }),
    el('TextView', 'Passwords, passkeys & accounts', [210, 1962, 700, 71], { id: 'android:id/title' }),
    el('TextView', 'Suggestions for sign-in & autofill', [210, 2033, 560, 51], { id: 'android:id/summary' }),
  ] }),
]);

const iosSettingsRoot = () => tree('accessibility', ...IOS, [
  el('Application', 'Settings', [0, 0, 1206, 2622], { children: [
    el('StaticText', 'Settings', [48, 260, 400, 120]),
    el('Button', 'Apple Account, Sign in to access your iCloud data, the App Store, Apple services and more.', [48, 505, 1110, 271],
      { id: 'com.apple.settings.primaryAppleAccount', clickable: true }),
    el('StaticText', 'Apple Account', [300, 549, 404, 72]),
    el('StaticText', 'Sign in to access your iCloud data, the App Store, Apple services and more.', [300, 630, 708, 101]),
    el('Button', 'General', [48, 1141, 1110, 156], { id: 'com.apple.settings.general', clickable: true }),
    el('Button', 'Face ID & Passcode', [48, 1297, 1110, 156], { id: 'com.apple.settings.faceIDPasscode', clickable: true }),
    el('Button', 'Privacy & Security', [48, 1453, 1110, 156], { id: 'com.apple.settings.privacyAndSecurity', clickable: true }),
    el('Button', 'Use Screen Time Passcode', [48, 1609, 1110, 156], { clickable: true }),
    el('Switch', 'Use Face ID for iPhone Unlock', [48, 1765, 1110, 156], { checked: true, value: '1' }),
  ] }),
]);

const androidLauncher = () => tree('accessibility', ...AND, [
  el('FrameLayout', undefined, [0, 0, 1080, 2424], { id: 'com.google.android.apps.nexuslauncher:id/launcher', children: [
    el('TextView', 'Phone', [80, 1900, 200, 220], { clickable: true }),
    el('TextView', 'Messages', [300, 1900, 200, 220], { clickable: true }),
    el('TextView', 'Chrome', [520, 1900, 200, 220], { clickable: true }),
    el('TextView', 'Camera', [740, 1900, 200, 220], { clickable: true }),
    el('FrameLayout', 'Search', [60, 2160, 960, 140], { id: 'com.google.android.apps.nexuslauncher:id/search_container_hotseat', clickable: true }),
  ] }),
]);

const androidGoogleSignInOcr = () => ocr(...AND, [
  ['9:16', 39, 56, 120, 36], ['Google', 439, 290, 205, 66], ['Sign in with ease', 303, 409, 478, 63],
  ['We can search for accounts connected to this phone', 60, 1084, 859, 40], ['SKIP', 60, 2248, 84, 39], ['NEXT', 858, 2248, 102, 39],
]);

// ── tests ────────────────────────────────────────────────────────────────────
test('iOS location permission sheet (accessibility tree)', () => {
  const p = detectPrompt(iosMapsLocation());
  assert.ok(p);
  assert.equal(p.kind, 'permission');
  assert.equal(p.needsHuman, false);
  assert.equal(p.source, 'accessibility');
  assert.equal(p.title, 'Allow “Maps” to use your location?');
  assert.deepEqual(texts(p), ['Allow Once', 'Allow While Using App', 'Don’t Allow']);
  assert.ok(p.buttons.every((b) => b.ref && b.bounds.width > 0));
  assert.equal(pick(p, 'accept').text, 'Allow While Using App');
  assert.equal(pick(p, 'dismiss').text, 'Don’t Allow');
  assert.equal(pick(p, { button: 'allow once' }).text, 'Allow Once');
  assert.equal(pick(p, { button: "Don't Allow" }).text, 'Don’t Allow', 'straight quote matches curly');
});

test('iOS location permission sheet (OCR): ignores the app behind the dim layer', () => {
  const p = detectPrompt(iosMapsLocationOcr());
  assert.ok(p);
  assert.equal(p.kind, 'permission');
  assert.equal(p.title, 'Allow "Maps" to use your location?', 'title joined across OCR lines');
  assert.deepEqual(texts(p), ['Allow Once', 'Allow While Using App', "Don't Allow"]);
  assert.ok(p.buttons.every((b) => b.ref === undefined), 'OCR refs are not tappable handles');
  assert.equal(pick(p, 'accept').text, 'Allow While Using App');
  assert.equal(pick(p, 'dismiss').text, "Don't Allow");
});

test('Android runtime permission grant dialog (accessibility tree)', () => {
  const p = detectPrompt(androidCameraGrant());
  assert.ok(p);
  assert.equal(p.kind, 'permission');
  assert.equal(p.needsHuman, false);
  assert.match(p.reason, /Allow Camera to take pictures and record video\?/);
  assert.deepEqual(texts(p), ['While using the app', 'Only this time', 'Don’t allow']);
  const accept = pick(p, 'accept');
  assert.equal(accept.text, 'While using the app');
  assert.equal(accept.role, 'accept');
  assert.ok(accept.ref);
  assert.equal(pick(p, 'dismiss').text, 'Don’t allow');
  assert.equal(pick(p, { button: 'only this time' }).text, 'Only this time');
});

test('Android runtime permission grant dialog (OCR)', () => {
  const p = detectPrompt(androidCameraGrantOcr());
  assert.ok(p);
  assert.equal(p.kind, 'permission');
  assert.equal(p.title, 'Allow Camera to take pictures and record video?');
  assert.equal(p.source, 'ocr');
  assert.equal(pick(p, 'accept').text, 'While using the app');
  assert.equal(pick(p, 'dismiss').text, "Don't allow");
});

test('Allow Paste needs a human', () => {
  const p = detectPrompt(iosAllowPaste());
  assert.ok(p);
  assert.equal(p.kind, 'allow_paste');
  assert.equal(p.needsHuman, true);
  assert.deepEqual(texts(p), ['Don’t Allow Paste', 'Allow Paste']);
});

test('Face ID (iOS) and BiometricPrompt (Android) need a human', () => {
  const ios = detectPrompt(iosFaceId());
  assert.equal(ios?.kind, 'biometric');
  assert.equal(ios?.needsHuman, true);
  const android = detectPrompt(androidBiometricPrompt());
  assert.equal(android?.kind, 'biometric');
  assert.equal(android?.needsHuman, true);
});

test('passcode, App Store password sheet and profile install need a human', () => {
  assert.equal(detectPrompt(iosPasscode())?.kind, 'passcode');
  const signIn = detectPrompt(iosAppStoreSignIn());
  assert.equal(signIn?.kind, 'credentials');
  assert.match(signIn?.reason ?? '', /Apple Account/);
  assert.equal(detectPrompt(iosProfileDownloaded())?.kind, 'install_profile');
  for (const f of [iosPasscode, iosAppStoreSignIn, iosProfileDownloaded]) assert.equal(detectPrompt(f())?.needsHuman, true, f.name);
  assert.deepEqual([...HUMAN_KINDS].sort(), ['allow_paste', 'biometric', 'credentials', 'install_profile', 'passcode']);
});

test('generic Android AlertDialog: button ids carry the roles', () => {
  const p = detectPrompt(androidForceStop());
  assert.ok(p);
  assert.equal(p.kind, 'alert');
  assert.equal(p.needsHuman, false);
  assert.equal(p.title, 'Force stop?');
  assert.deepEqual(texts(p), ['Cancel', 'OK']);
  assert.equal(pick(p, 'accept').text, 'OK');
  assert.equal(pick(p, 'dismiss').text, 'Cancel');
});

test('generic alert from OCR: two stacked labels under a question', () => {
  const p = detectPrompt(iosDeleteAlertOcr());
  assert.ok(p);
  assert.equal(p.kind, 'alert');
  assert.equal(p.title, 'Delete this shortcut?');
  assert.deepEqual(texts(p), ['Delete', 'Cancel']);
  assert.equal(pick(p, 'dismiss').text, 'Cancel');
  assert.throws(() => pick(p, 'accept'), (e: Error & { code?: string }) => e.code === 'ambiguous_button', '"Delete" is not a safe default accept');
  assert.equal(pick(p, { button: 'Delete' }).text, 'Delete');
});

test('normal screens are not prompts', () => {
  for (const f of [androidSettingsRoot, iosSettingsRoot, androidLauncher, androidGoogleSignInOcr]) {
    assert.equal(detectPrompt(f()), null, f.name);
  }
  assert.equal(detectPrompt([]), null);
  assert.equal(detectPrompt(tree('accessibility', ...AND, [])), null);
});

test('accepts a bare element list', () => {
  const p = detectPrompt(androidCameraGrant().root, { width: AND[0], height: AND[1] });
  assert.equal(p?.kind, 'permission');
  assert.equal(p?.source, undefined);
});

test('chooseButton errors carry codes', () => {
  const p = detectPrompt(androidForceStop());
  assert.ok(p);
  assert.throws(() => chooseButton(p, { button: 'Uninstall' }), (e: Error & { code?: string }) => e.code === 'no_button');
  const empty: SystemPrompt = { kind: 'alert', reason: 'alert', buttons: [], needsHuman: false };
  assert.throws(() => chooseButton(empty, 'accept'), (e: Error & { code?: string }) => e.code === 'no_button');
  const one: SystemPrompt = { ...empty, buttons: [{ text: 'Got it, thanks', bounds: { x: 0, y: 0, width: 10, height: 10 } }] };
  assert.equal(chooseButton(one, 'dismiss').text, 'Got it, thanks', 'a lone button answers either action');
});

// ── regressions from the blind agent test (runs 4 / 4b): real iPhone 17 Pro simulator trees, iOS 26.5 ──────────
/** Settings home screen (cleaned /ui tree, trimmed): the "Apple Account, Sign in to access your iCloud data…" row is a
 *  link to the sign-in flow, not a credential prompt. Both blind agents were told "NEEDS A HUMAN?" here and ignored it. */
const iosSettingsHome = () => tree('accessibility', ...IOS, [
  el('Application', 'Settings', [0, 0, 1206, 2622], { enabled: true, children: [
    el('Group', undefined, [0, 186, 1206, 318], { id: 'Settings', children: [el('Heading', 'Settings', [48, 359, 399, 122])] }),
    el('Group', undefined, [-48, -4740, 1302, 5568]),
    el('Group', undefined, [48, 504, 1110, 271], { children: [
      el('Button', 'Apple Account, Sign in to access your iCloud data, the App Store, Apple services and more.', [48, 504, 1110, 271], { id: 'com.apple.settings.primaryAppleAccount', clickable: true, children: [
        el('Image', 'apple.id', [96, 549, 180, 181], { id: 'apple.id', clickable: true }),
        el('StaticText', 'Apple Account', [300, 549, 404, 72]),
        el('StaticText', 'Sign in to access your iCloud data, the App Store, Apple services and more.', [300, 629, 708, 101]),
        el('Image', undefined, [1082, 621, 21, 36], { id: 'chevron.forward', clickable: true }),
      ] }),
    ] }),
    el('Group', undefined, [48, 880, 1110, 156], { children: [
      el('Button', 'Ready for Apple Intelligence', [48, 880, 1110, 156], { id: 'com.apple.settings.followUpItem.com.apple.icloud.gm', clickable: true, children: [
        el('StaticText', 'Ready for Apple Intelligence', [96, 927, 638, 61]),
      ] }),
    ] }),
    el('Group', undefined, [48, 1141, 1110, 156], { children: [
      el('Button', 'General', [48, 1141, 1110, 156], { id: 'com.apple.settings.general', clickable: true, children: [el('StaticText', 'General', [89, 1176, 305, 87])] }),
    ] }),
    el('Group', undefined, [48, 1297, 1110, 156], { children: [el('Button', 'Accessibility', [48, 1297, 1110, 156], { id: 'com.apple.settings.accessibility', clickable: true })] }),
    el('Group', undefined, [48, 2077, 1110, 156], { children: [el('Button', 'Search', [48, 2077, 1110, 156], { id: 'com.apple.settings.search', clickable: true })] }),
    el('Slider', 'Vertical scroll bar, 2 pages', [1107, 348, 90, 2016], { value: '0%', clickable: true }),
    el('Group', 'Toolbar', [0, 2364, 1206, 258], { id: 'Toolbar', children: [
      el('TextField', 'Search', [99, 2409, 1008, 114], { value: 'Search', clickable: true, children: [
        el('Image', 'Search', [138, 2437, 61, 56], { id: 'magnifyingglass', clickable: true }),
        el('Button', 'Dictate', [1007, 2433, 52, 66], { id: 'Dictate', clickable: true }),
      ] }),
    ] }),
  ] }),
]);
/** Settings › Apple Account › Sign in Manually (trimmed; the home screen stays in the tree behind the sheet). */
const iosAppleSignInForm = () => {
  const t = iosSettingsHome();
  t.root[0].children!.push(
    el('Group', undefined, [0, 234, 1206, 162], { id: 'sign-in-nav-bar', children: [el('Button', 'Back', [60, 246, 108, 108], { id: 'back-button', clickable: true })] }),
    el('TextField', 'Email or Phone Number', [156, 1269, 894, 96], { id: 'username-field', value: 'Email or Phone Number', clickable: true }),
    el('Heading', undefined, [108, 396, 990, 843], { id: 'header-view', children: [
      el('Heading', 'Apple Account', [108, 762, 990, 79]),
      el('Heading', 'Sign in with an email or phone number to use iCloud, the App Store, Messages or other Apple services.', [108, 845, 990, 335]),
    ] }),
    el('Button', 'Forgot your password?', [108, 1440, 605, 61], { id: 'footer-button', clickable: true }),
    el('Button', 'Continue', [108, 2021, 990, 156], { id: 'continue-button', clickable: true, enabled: false }),
    el('Button', 'Sign in a Child in My Family', [108, 2207, 990, 151], { id: 'child-sign-in-button', clickable: true }),
  );
  return t;
};
/** An app's own login form: email field, no Apple / Google account context. An agent given credentials may fill it. */
const appLogin = () => tree('accessibility', ...IOS, [
  el('Application', 'Shop', [0, 0, 1206, 2622], { children: [
    el('StaticText', 'Welcome back', [60, 400, 800, 100]),
    el('TextField', 'Email', [60, 700, 1086, 140], { clickable: true }),
    el('Button', 'Sign in', [60, 1100, 1086, 150], { clickable: true }),
    el('Button', 'Forgot your password?', [60, 1300, 600, 60], { clickable: true }),
  ] }),
]);

test('Settings home: the Apple Account row is not a prompt (blind runs 4/4b false "NEEDS A HUMAN?")', () => {
  assert.equal(detectPrompt(iosSettingsHome()), null);
});

test('Apple Account sign-in form (email first) needs a human', () => {
  const p = detectPrompt(iosAppleSignInForm());
  assert.ok(p);
  assert.equal(p.kind, 'credentials');
  assert.equal(p.needsHuman, true);
  assert.match(p.reason, /Apple Account sign-in form/);
});

test('an app\'s own email login without account context is not flagged', () => {
  assert.equal(detectPrompt(appLogin()), null);
});

test('MCP humanNeeded: no text-only credential / Face ID flags, CAPTCHA still flagged', async () => {
  const { humanNeeded } = await import('../mcp/server.ts');
  const texts = (t: UiTree) => {
    const out: string[] = [];
    const walk = (els: UiElement[]) => { for (const e of els) { if (e.text || e.label) out.push(`${e.text ?? ''} ${e.label ?? ''}`); walk(e.children ?? []); } };
    walk(t.root); return out;
  };
  assert.equal(humanNeeded(texts(iosSettingsHome())), undefined);
  assert.equal(humanNeeded(['Face ID & Passcode', 'Use Face ID for iPhone Unlock']), undefined);
  assert.equal(humanNeeded(['Please verify you are human', "I'm not a robot"]), 'a CAPTCHA');
});

test('describePrompt and normText', () => {
  const p = detectPrompt(androidCameraGrant());
  assert.ok(p);
  assert.equal(describePrompt(p), 'permission dialog: Allow Camera to take pictures and record video? — buttons [While using the app] [Only this time] [Don’t allow]');
  assert.equal(normText('  Don’t  Allow “Maps”… '), 'Don\'t Allow "Maps"...');
});
