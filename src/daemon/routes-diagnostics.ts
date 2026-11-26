import { buildDoctorReport, diagnoseKnownDevice, type DoctorReport } from '../core/doctor.ts';
import { inspectAndroidWebView, validateWebViewOptions, type WebViewOptions, type WebViewResult } from '../backends/android-webview.ts';
import { inspectIosSimWebView } from '../backends/ios-webview.ts';
import { PhoneDockError, type Backend, type Device } from '../core/types.ts';
import { checkLease, getDevice } from './core.ts';
import { dev, router } from './routes.ts';
import { Router, type Ctx } from './http.ts';

export interface DiagnosticRouteDeps {
  doctor(): Promise<DoctorReport>;
  device(c: Ctx): { id: string; b: Backend; nid: string };
  knownDevice(id: string): Promise<Device>;
  checkLease(id: string, owner: string): void;
  inspect(serial: string, options: WebViewOptions): Promise<WebViewResult>;
  inspectIosSim?(udid: string, options: WebViewOptions): Promise<WebViewResult>;
}
const defaults: DiagnosticRouteDeps = { doctor: buildDoctorReport, device: dev, knownDevice: getDevice, checkLease, inspect: inspectAndroidWebView, inspectIosSim: inspectIosSimWebView };
export function registerDiagnosticRoutes(r: Router, deps: DiagnosticRouteDeps = defaults): void {
  r.get('/v1/doctor', async (c) => {
    const report = await deps.doctor(); const requested = c.q('device');
    if (!requested) return report;
    const device = await deps.knownDevice(requested);
    const required = (c.q('capabilities') ?? '').split(',').filter(Boolean).slice(0, 30);
    return { ...report, device: diagnoseKnownDevice(device, required) };
  });
  r.post('/v1/devices/:id/webview', async (c) => {
    const d = deps.device(c); deps.checkLease(d.id, c.owner);
    const isAndroid = ['android-emulator', 'android-device'].includes(d.b.id);
    const isIosSim = d.b.id === 'ios-simulator';
    if (!isAndroid && !isIosSim) throw new PhoneDockError('WebView diagnostics support Android devices/emulators and iOS simulators', 'not_supported', 501,
      ['Use native accessibility or OCR for this device.']);
    const body = await c.body();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new PhoneDockError('Pass a WebView diagnostic request object', 'bad_request', 400);
    const options: WebViewOptions = {
      ...(body.appId !== undefined ? { appId: body.appId } : {}),
      action: body.action ?? 'snapshot',
      ...(body.selector !== undefined ? { selector: body.selector } : {}),
      targetId: body.targetId,
      bounds: body.bounds,
      captureMs: body.captureMs,
      maxElements: body.maxElements,
    };
    validateWebViewOptions(options, { requireAppId: isAndroid });
    if (isIosSim) {
      const device = await deps.knownDevice(d.id);
      if (device.state !== 'running') throw new PhoneDockError('The selected iOS simulator is not running', 'offline', 409,
        ['Boot the simulator and open Safari or a debuggable WKWebView first.']);
      deps.checkLease(d.id, c.owner);
      return (deps.inspectIosSim ?? inspectIosSimWebView)(d.nid, options);
    }
    let serial: string | undefined;
    if (d.b.id === 'android-emulator') serial = await (d.b as Backend & { runningSerial(nativeId: string): Promise<string | undefined> }).runningSerial?.(d.nid);
    else {
      const device = await deps.knownDevice(d.id);
      if (device.state === 'running' && typeof device.meta?.serial === 'string') serial = device.meta.serial;
    }
    if (!serial) throw new PhoneDockError('The selected Android device has no known online transport', 'offline', 409,
      ['Refresh device inventory and connect the selected device before inspecting a WebView.']);
    deps.checkLease(d.id, c.owner);
    return deps.inspect(serial, options);
  });
}
registerDiagnosticRoutes(router);
