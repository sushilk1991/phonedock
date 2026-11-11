// Simulator/emulator-only environment primitives. All host commands use argv; every adb call has one serial.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { run, type RunOptions } from '../core/exec.ts';
import { stateDir, toolEnv } from '../core/paths.ts';
import { parseEnvironmentAction, type EnvironmentAction, type EnvironmentCapabilities, type EnvironmentResult } from '../core/environment.ts';
import { PhoneDockError, type Backend, type ExecResult } from '../core/types.ts';
import { adb } from './android-common.ts';

const IOS_PERMISSIONS = ['all', 'calendar', 'contacts-limited', 'contacts', 'location', 'location-always', 'photos-add', 'photos', 'media-library', 'microphone', 'motion', 'reminders', 'siri'];
const ANDROID_PERMISSIONS: Record<string, string> = { camera: 'CAMERA', microphone: 'RECORD_AUDIO', notifications: 'POST_NOTIFICATIONS', location: 'ACCESS_FINE_LOCATION', 'location-coarse': 'ACCESS_COARSE_LOCATION', contacts: 'READ_CONTACTS', 'contacts-write': 'WRITE_CONTACTS', calendar: 'READ_CALENDAR', 'calendar-write': 'WRITE_CALENDAR', photos: 'READ_MEDIA_IMAGES', video: 'READ_MEDIA_VIDEO', audio: 'READ_MEDIA_AUDIO' };
const MEDIA_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.heic', '.heif', '.webp', '.mp4', '.mov', '.m4v', '.3gp']);
export interface DemoState { allowed: string }
export interface EnvironmentDeps {
  command(cmd: string, args: string[], opts?: RunOptions): Promise<ExecResult>;
  adb(serial: string, args: string[], opts?: RunOptions): Promise<ExecResult>;
  serial(backend: Backend, nativeId: string): Promise<string | undefined>;
  beforeMutation?(): void;
  demoState?: { read(key: string): DemoState | undefined; write(key: string, value: DemoState): void; remove(key: string): void };
}
const memoryDemo = new Map<string, DemoState>();
const fileFor = (key: string) => join(stateDir('environment'), `demo-${createHash('sha256').update(key).digest('hex')}.json`);
const defaults: EnvironmentDeps = {
  command: run, adb,
  serial: (b, id) => (b as Backend & { runningSerial?: (id: string) => Promise<string | undefined> }).runningSerial?.(id) ?? Promise.resolve(undefined),
  demoState: {
    read(key) { try { const s = JSON.parse(readFileSync(fileFor(key), 'utf8')); return ['null', '0', '1'].includes(s.allowed) ? s : undefined; } catch { return undefined; } },
    write(key, value) { const path = fileFor(key), tmp = `${path}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 }); renameSync(tmp, path); },
    remove(key) { rmSync(fileFor(key), { force: true }); },
  },
};
export const defaultEnvironmentDeps = (): EnvironmentDeps => defaults;
export function environmentCapabilities(b: Pick<Backend, 'id' | 'kind'>): EnvironmentCapabilities {
  const ios = b.id === 'ios-simulator' && b.kind === 'virtual', android = b.id === 'android-emulator' && b.kind === 'virtual';
  const supported = ios || android;
  return {
    supported, actions: supported ? ['permissions', 'biometric', 'statusBar', 'media'] : [],
    permissions: { services: ios ? IOS_PERMISSIONS : android ? Object.keys(ANDROID_PERMISSIONS) : [], states: supported ? ['grant', 'revoke', 'reset'] : [], ...(android ? { acceptsAndroidPermissionNames: true } : {}) },
    biometric: { events: ios ? ['enroll', 'unenroll', 'match', 'fail'] : android ? ['match', 'fail'] : [], modalities: ios ? ['face', 'fingerprint'] : android ? ['fingerprint'] : [], experimental: ios,
      prerequisites: ios ? ['Requires a simulator model with Face ID or Touch ID. Darwin notification names are private and can change with Xcode.'] : android ? ['Enroll a fingerprint in emulator Settings first. Match uses an enrolled fingerId; failure uses a fingerId that is not enrolled.'] : ['Physical authentication is handled by the person.'] },
    statusBar: { fields: supported ? ['time', 'batteryLevel', 'wifiBars', 'cellularBars'] : [], ...(supported ? { wifiBarsMax: ios ? 3 : 4 } : {}), clear: supported },
    media: { import: supported, virtualCamera: false },
    limitations: supported ? [
      'Permission pre-grants can hide missing app permission-request behavior. Test the actual prompt flow separately.',
      ...(ios ? ['Only the listed simctl privacy services are supported; camera, notifications and pasteboard are not advertised.'] : ['Android permissions must be runtime permissions declared by the app and supported by its API level. Reset revokes and clears user flags only for the requested permissions.']),
      'Media import adds files to the library; it does not inject a camera feed.',
    ] : ['Environment controls are limited to iOS Simulator and Android Emulator; no physical-device authentication bypass is provided.'],
  };
}

export async function applyEnvironment(b: Backend, nativeId: string, raw: unknown, deps: EnvironmentDeps = defaults): Promise<EnvironmentResult> {
  const a = parseEnvironmentAction(raw);
  const caps = environmentCapabilities(b);
  if (!caps.supported) throw new PhoneDockError('Environment controls require a simulator or emulator', 'not_supported', 501, caps.limitations, undefined, 'not_sent');
  const ios = b.id === 'ios-simulator';
  const unsupported = (message: string): never => { throw new PhoneDockError(message, 'not_supported', 501, undefined, undefined, 'not_sent'); };
  // Validate all platform-specific arguments before any operation can partially mutate the device.
  let permissions: string[] = [];
  if (a.action === 'permissions') permissions = a.permissions.map((p) => {
    if (ios) { if (!IOS_PERMISSIONS.includes(p)) return unsupported(`simctl privacy does not support service ${p}`); return p; }
    if (ANDROID_PERMISSIONS[p]) return `android.permission.${ANDROID_PERMISSIONS[p]}`;
    if (!/^android\.permission\.[A-Z][A-Z0-9_]{0,99}$/.test(p)) return unsupported(`Unknown Android runtime permission ${p}`);
    return p;
  });
  if (a.action === 'statusBar' && ios && (a.wifiBars ?? 0) > 3) unsupported('iOS Simulator Wi-Fi bars range from 0 to 3');
  if (a.action === 'biometric' && !ios) {
    if (a.event === 'enroll' || a.event === 'unenroll' || a.modality === 'face') unsupported('Android Emulator supports fingerprint match/fail; enroll a fingerprint in Settings first');
    if (a.event === 'fail' && a.fingerId === undefined) unsupported('For Android failure, pass a fingerId that is not enrolled');
  }
  let mediaPath: string | undefined, extension: string | undefined;
  if (a.action === 'media') {
    mediaPath = resolve(a.path); extension = extname(mediaPath).toLowerCase();
    let file;
    try { file = statSync(mediaPath); } catch { throw new PhoneDockError('Media file does not exist', 'bad_request', 400, undefined, undefined, 'not_sent'); }
    if (!file.isFile() || !MEDIA_EXTENSIONS.has(extension) || file.size > 512 * 1024 * 1024) throw new PhoneDockError('Media must be a supported image or video file no larger than 512 MiB', 'bad_request', 400, undefined, undefined, 'not_sent');
    if (ios && !b.pushFile) unsupported('This simulator backend cannot import media');
  }
  const serial = ios ? undefined : await deps.serial(b, nativeId);
  if (!ios && !serial) throw new PhoneDockError('The emulator is not running', 'not_running', 409, undefined, undefined, 'not_sent');
  let sent = false;
  const warnings: string[] = [];
  const execute = async (args: string[], mutate = true) => {
    if (mutate) deps.beforeMutation?.();
    try {
      const result = ios ? await deps.command('xcrun', ['simctl', ...args], { env: toolEnv(), timeoutMs: 30_000, maxBuffer: 1024 * 1024, allowFail: true })
        : await deps.adb(serial!, args, { timeoutMs: 30_000, maxBuffer: 1024 * 1024, allowFail: true });
      if (result.code !== 0 || /(?:^|\n)(?:Error:|Exception occurred|java\.[\w.]+Exception:|Security exception:)/i.test(result.stdout + '\n' + result.stderr)) {
        throw new PhoneDockError('The environment command did not complete', 'environment_failed', 502,
          ['Check the target API/runtime and app permission declarations.'], `${result.stdout}\n${result.stderr}`.trim().slice(0, 1600), mutate ? 'unknown' : 'not_sent');
      }
      if (mutate) sent = true;
      return result.stdout.trim();
    } catch (e) {
      if (e instanceof PhoneDockError) throw e;
      throw new PhoneDockError('The environment command failed', 'environment_failed', 502, undefined, undefined, mutate ? 'unknown' : 'not_sent');
    }
  };
  let importedPath: string | undefined;
  try {
    if (a.action === 'permissions') {
      for (const permission of permissions) {
        if (ios) await execute(['privacy', nativeId, a.state, permission, a.appId]);
        else {
          await execute(['shell', 'pm', a.state === 'reset' ? 'revoke' : a.state, '--user', 'current', a.appId, permission]);
          if (a.state === 'reset') await execute(['shell', 'pm', 'clear-permission-flags', '--user', 'current', a.appId, permission, 'user-set', 'user-fixed']);
        }
      }
      warnings.push('Pre-grants do not validate the app’s own permission request flow.');
    } else if (a.action === 'biometric') {
      if (ios) {
        if (a.event === 'enroll' || a.event === 'unenroll') await execute(['spawn', nativeId, 'notifyutil', '-s', 'com.apple.BiometricKit.enrollmentChanged', a.event === 'enroll' ? '1' : '0', '-p', 'com.apple.BiometricKit.enrollmentChanged']);
        else await execute(['notify_post', nativeId, `com.apple.BiometricKit_Sim.${a.modality === 'fingerprint' ? 'fingerTouch' : 'pearl'}.${a.event === 'match' ? 'match' : 'nomatch'}`]);
        warnings.push('Simulator biometric notifications are private runtime behavior; verify the app’s response.');
      } else { await execute(['emu', 'finger', 'touch', String(a.fingerId ?? 1)]); warnings.push(a.event === 'fail' ? 'Failure requires that this fingerId is not enrolled.' : 'Match requires that this fingerId is enrolled.'); }
    } else if (a.action === 'statusBar') {
      if (ios) {
        if (a.mode === 'clear') await execute(['status_bar', nativeId, 'clear']);
        else {
          const args = ['status_bar', nativeId, 'override', '--time', a.time ?? '09:41', '--batteryState', 'charged', '--batteryLevel', String(a.batteryLevel ?? 100), '--wifiMode', 'active', '--wifiBars', String(a.wifiBars ?? 3), '--cellularMode', 'active', '--cellularBars', String(a.cellularBars ?? 4)];
          await execute(args);
        }
      } else {
        const key = `${b.id}:${nativeId}`;
        const state = deps.demoState ?? { read: (k: string) => memoryDemo.get(k), write: (k: string, v: DemoState) => { memoryDemo.set(k, v); }, remove: (k: string) => { memoryDemo.delete(k); } };
        const demo = async (command: string, extras: string[] = []) => execute(['shell', 'am', 'broadcast', '-a', 'com.android.systemui.demo', '-p', 'com.android.systemui', '-e', 'command', command, ...extras]);
        if (a.mode === 'clear') {
          await demo('exit');
          const old = state.read(key);
          if (old) {
            const current = await execute(['shell', 'settings', 'get', 'global', 'sysui_demo_allowed'], false);
            if (current === '1') await execute(['shell', 'settings', old.allowed === 'null' ? 'delete' : 'put', 'global', 'sysui_demo_allowed', ...(old.allowed === 'null' ? [] : [old.allowed])]);
            else warnings.push('The demo enable setting changed externally; its newer value was retained.');
            state.remove(key);
          } else warnings.push('The live status bar was restored; no previous PhoneDock demo-enable setting was retained.');
        } else {
          if (!state.read(key)) {
            const allowed = await execute(['shell', 'settings', 'get', 'global', 'sysui_demo_allowed'], false);
            const active = await execute(['shell', 'settings', 'get', 'global', 'sysui_demo_on'], false);
            if (active === '1') throw new PhoneDockError('Another demo-mode session is active', 'busy', 409, ['Clear it explicitly or use a fresh emulator.'], undefined, 'not_sent');
            if (!['null', '0', '1'].includes(allowed)) unsupported('The emulator demo-enable setting could not be read safely');
            state.write(key, { allowed });
          }
          await execute(['shell', 'settings', 'put', 'global', 'sysui_demo_allowed', '1']);
          await demo('enter'); await demo('clock', ['-e', 'hhmm', (a.time ?? '09:41').replace(':', '')]);
          await demo('battery', ['-e', 'level', String(a.batteryLevel ?? 100), '-e', 'plugged', 'false']);
          await demo('network', ['-e', 'wifi', 'show', '-e', 'level', String(a.wifiBars ?? 4)]);
          await demo('network', ['-e', 'mobile', 'show', '-e', 'datatype', 'lte', '-e', 'level', String(a.cellularBars ?? 4)]);
          await demo('notifications', ['-e', 'visible', 'false']);
        }
      }
    } else if (a.action === 'media') {
      deps.beforeMutation?.();
      if (ios) { await b.pushFile!(nativeId, mediaPath!, 'photos:'); sent = true; }
      else {
        const root = extension === '.mp4' || extension === '.mov' || extension === '.m4v' || extension === '.3gp' ? '/sdcard/Movies/PhoneDock' : '/sdcard/Pictures/PhoneDock';
        importedPath = `${root}/${randomUUID()}${extension}`;
        await execute(['shell', 'mkdir', '-p', root]); await execute(['push', mediaPath!, importedPath]);
        await execute(['shell', 'am', 'broadcast', '-a', 'android.intent.action.MEDIA_SCANNER_SCAN_FILE', '-d', `file://${importedPath}`]);
      }
      warnings.push('Import commands completed; check the app’s media picker for platform-specific formats. No camera feed was injected.');
    }
  } catch (e) {
    if (e instanceof PhoneDockError) { if (sent && e.delivery !== 'unknown') e.delivery = 'sent'; throw e; }
    throw new PhoneDockError('Environment setup stopped', 'environment_failed', 502, undefined, undefined, sent ? 'sent' : 'not_sent');
  }
  return { ok: true, action: a.action, warnings, ...(importedPath ? { path: importedPath } : {}), delivery: sent ? 'sent' : 'not_sent' };
}
