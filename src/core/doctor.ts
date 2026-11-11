// Host prerequisites only: never discover, pair, boot or probe a device while diagnosing this Mac.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { androidSdkRoot, developerDir, javaHome, which } from './paths.ts';
import { nativeAvailability } from '../backends/ios-native.ts';
import type { Device } from './types.ts';

export interface DoctorCheck {
  id: string; status: 'ready' | 'missing' | 'unsupported' | 'warning'; summary: string;
  path?: string; version?: string; hints?: string[];
}
export interface DoctorReport {
  ok: boolean; scope: 'host-prerequisites'; checks: DoctorCheck[];
  targets: { iosSimulator: boolean; androidEmulator: boolean; nativeIphone: boolean };
  limits: string[];
}
export interface DoctorDeps {
  nodeVersion: string; platform: string; which(name: string): string | undefined;
  developerDir(): string | undefined; androidSdkRoot(): string | undefined; javaHome(): string | undefined;
  exists(path: string): boolean;
  nativeAvailability(): Promise<{ ok: boolean; reason?: string; pymobiledevice3?: string }>;
}
const defaults: DoctorDeps = { nodeVersion: process.versions.node, platform: process.platform, which,
  developerDir, androidSdkRoot, javaHome, exists: existsSync, nativeAvailability };

export async function buildDoctorReport(deps: DoctorDeps = defaults): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const node = /^v?(\d+)\./.exec(deps.nodeVersion); const nodeOk = !!node && Number(node[1]) >= 24;
  checks.push({ id: 'node', status: nodeOk ? 'ready' : 'unsupported', version: deps.nodeVersion,
    summary: nodeOk ? 'Node supports direct erasable TypeScript execution' : 'PhoneDock requires Node 24 or later',
    ...(!nodeOk ? { hints: ['Install Node 24 or later before starting PhoneDock.'] } : {}) });
  const mac = deps.platform === 'darwin';
  checks.push({ id: 'platform', status: mac ? 'ready' : 'unsupported', summary: mac ? 'macOS host' : 'PhoneDock device backends require macOS' });
  const xcode = deps.developerDir(); const sdk = deps.androidSdkRoot(); const java = deps.javaHome();
  const pathCheck = (id: string, path: string | undefined, summary: string, hint: string) => {
    const present = !!path && deps.exists(path);
    checks.push({ id, status: present ? 'ready' : 'missing', summary: present ? summary : `${summary} not found`, ...(path ? { path } : {}), ...(!present ? { hints: [hint] } : {}) });
    return present;
  };
  const xcodeOk = pathCheck('xcode', xcode, 'Xcode developer directory', 'Install full Xcode; PhoneDock sets DEVELOPER_DIR independently of xcode-select.');
  const sdkOk = pathCheck('android-sdk', sdk, 'Android SDK directory', 'Install the Android SDK or set ANDROID_HOME.');
  const javaOk = pathCheck('java', java, 'Java environment', 'Install a compatible Java runtime for Android SDK tooling.');
  const tool = (id: string, path: string | undefined, hint: string) => pathCheck(id, path, id, hint);
  const axe = tool('axe', deps.which('axe'), 'Install AXe for iOS simulator input and accessibility.');
  const adb = tool('adb', sdk ? join(sdk, 'platform-tools', 'adb') : deps.which('adb'), 'Install Android SDK platform-tools.');
  const emulator = tool('emulator', sdk ? join(sdk, 'emulator', 'emulator') : undefined, 'Install the Android SDK emulator and a compatible system image.');
  tool('ffmpeg', deps.which('ffmpeg'), 'Install ffmpeg for image comparisons and fallback video processing.');
  tool('scrcpy', deps.which('scrcpy'), 'Install scrcpy for Android streaming.');
  let nativeOk = false; let timer: NodeJS.Timeout | undefined;
  try {
    const native = await Promise.race([deps.nativeAvailability(), new Promise<never>((_r, reject) => {
      timer = setTimeout(() => reject(new Error('Native environment check exceeded 3 seconds')), 3000);
    })]);
    nativeOk = native.ok;
    checks.push({ id: 'native-iphone', status: native.ok ? 'ready' : 'missing', summary: native.ok
      ? 'Native iPhone Python dependencies import successfully; no phone was contacted' : native.reason ?? 'Native iPhone dependencies are unavailable',
      ...(native.pymobiledevice3 ? { version: native.pymobiledevice3 } : {}), ...(!native.ok ? { hints: ['Repair the pymobiledevice3 environment and run doctor again.'] } : {}) });
  } catch {
    checks.push({ id: 'native-iphone', status: 'warning', summary: 'Native iPhone dependency check failed or timed out', hints: ['Check the pymobiledevice3 installation; no phone was contacted.'] });
  } finally { if (timer) clearTimeout(timer); }
  return { ok: nodeOk && mac, scope: 'host-prerequisites', checks,
    targets: { iosSimulator: nodeOk && mac && xcodeOk && axe, androidEmulator: nodeOk && mac && sdkOk && javaOk && adb && emulator,
      nativeIphone: nodeOk && mac && xcodeOk && nativeOk },
    limits: ['These checks do not contact devices or validate installed simulator/system images.',
      'A present tool is not a tested OS/tool-version combination. Device pairing, Developer Mode, UI Automation, lock state and stream ownership still determine readiness.'] };
}

export interface DeviceDiagnosis { deviceId: string; state: Device['state']; observedFrom: 'cached-device-metadata'; issues: { code: string; message: string; hints: string[] }[] }
/** Only interpret metadata already obtained by the daemon. Unknown lock/readiness stays unknown. */
export function diagnoseKnownDevice(device: Device, requiredCapabilities: string[] = []): DeviceDiagnosis {
  const issues: DeviceDiagnosis['issues'] = [];
  const meta = (device.meta ?? {}) as Record<string, any>; const readiness = meta.readiness ?? {};
  if (device.state !== 'running') issues.push({ code: device.state, message: `Device state is ${device.state}`, hints: ['Resolve device availability before running input.'] });
  if (meta.locked === true || readiness.locked === true) issues.push({ code: 'locked', message: 'The last device metadata reports a locked device', hints: ['Unlock it and refresh readiness.'] });
  if (/stream_busy|another.*(?:stream|client)|stream.*(?:in use|busy)/i.test(device.error ?? '') || meta.streamBusy === true) issues.push({ code: 'stream_busy', message: 'Another application may own the screen stream', hints: ['Close the other viewer, then refresh the device.'] });
  if ([false, 'disabled', 'off'].includes(readiness.developerMode ?? meta.developerMode)) issues.push({ code: 'developer_mode_off', message: 'Developer Mode is reported disabled', hints: ['Enable Developer Mode on the device.'] });
  if ([false, 'disabled', 'off'].includes(readiness.uiAutomation ?? meta.uiAutomation)) issues.push({ code: 'ui_automation_off', message: 'UI Automation is reported disabled', hints: ['Enable UI Automation on the device.'] });
  for (const capability of requiredCapabilities) if (!(device.capabilities ?? []).includes(capability as never)) issues.push({ code: 'unsupported_capability', message: `This device does not advertise ${capability}`, hints: ['Use a compatible device or the documented fallback.'] });
  return { deviceId: device.id, state: device.state, observedFrom: 'cached-device-metadata', issues };
}
