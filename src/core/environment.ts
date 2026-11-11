import { PhoneDockError } from './types.ts';
import { isAppId } from './app-notes.ts';

export type EnvironmentAction =
  | { action: 'permissions'; appId: string; state: 'grant' | 'revoke' | 'reset'; permissions: string[] }
  | { action: 'biometric'; event: 'enroll' | 'unenroll' | 'match' | 'fail'; modality?: 'face' | 'fingerprint'; fingerId?: number }
  | { action: 'statusBar'; mode: 'override' | 'clear'; time?: string; batteryLevel?: number; wifiBars?: number; cellularBars?: number }
  | { action: 'media'; path: string };
export interface EnvironmentResult { ok: true; action: EnvironmentAction['action']; warnings: string[]; path?: string; delivery: 'sent' | 'not_sent' }
export interface EnvironmentCapabilities {
  supported: boolean;
  actions: EnvironmentAction['action'][];
  permissions: { services: string[]; states: ('grant' | 'revoke' | 'reset')[]; acceptsAndroidPermissionNames?: boolean };
  biometric: { events: string[]; modalities: string[]; experimental: boolean; prerequisites: string[] };
  statusBar: { fields: string[]; wifiBarsMax?: number; clear: boolean };
  media: { import: boolean; virtualCamera: false };
  limitations: string[];
}
const bad = (message: string): never => { throw new PhoneDockError(message, 'bad_request', 400, undefined, undefined, 'not_sent'); };
export function parseEnvironmentAction(value: unknown): EnvironmentAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return bad('Pass an environment action object');
  const o = value as Record<string, unknown>;
  const fields: Record<string, string[]> = {
    permissions: ['action', 'appId', 'state', 'permissions'], biometric: ['action', 'event', 'modality', 'fingerId'],
    statusBar: ['action', 'mode', 'time', 'batteryLevel', 'wifiBars', 'cellularBars'], media: ['action', 'path'],
  };
  const keys = fields[String(o.action)];
  if (!keys) return bad('action must be permissions, biometric, statusBar or media');
  if (Object.keys(o).some((k) => !keys.includes(k))) return bad('Unknown field in environment action');
  switch (o.action) {
    case 'permissions':
      if (!isAppId(o.appId)) return bad('appId must be a package name or bundle identifier');
      if (!['grant', 'revoke', 'reset'].includes(String(o.state))) return bad('permissions state must be grant, revoke or reset');
      if (!Array.isArray(o.permissions) || !o.permissions.length || o.permissions.length > 32 || !o.permissions.every((p) => typeof p === 'string' && /^[A-Za-z0-9._-]{1,120}$/.test(p))) return bad('permissions must contain 1–32 service names');
      return { action: 'permissions', appId: o.appId, state: o.state as 'grant' | 'revoke' | 'reset', permissions: [...new Set(o.permissions)] };
    case 'biometric':
      if (!['enroll', 'unenroll', 'match', 'fail'].includes(String(o.event))) return bad('biometric event must be enroll, unenroll, match or fail');
      if (o.modality !== undefined && o.modality !== 'face' && o.modality !== 'fingerprint') return bad('biometric modality must be face or fingerprint');
      if (o.fingerId !== undefined && (!Number.isInteger(o.fingerId) || Number(o.fingerId) < 1 || Number(o.fingerId) > 10_000)) return bad('fingerId must be an integer from 1 to 10000');
      return { action: 'biometric', event: o.event as 'enroll' | 'unenroll' | 'match' | 'fail', ...(o.modality ? { modality: o.modality } : {}), ...(o.fingerId !== undefined ? { fingerId: Number(o.fingerId) } : {}) } as EnvironmentAction;
    case 'statusBar':
      if (o.mode !== 'override' && o.mode !== 'clear') return bad('statusBar mode must be override or clear');
      if (o.mode === 'clear' && Object.keys(o).some((k) => !['action', 'mode'].includes(k))) return bad('statusBar clear takes no override fields');
      if (o.time !== undefined && (typeof o.time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(o.time))) return bad('statusBar time must be HH:MM in 24-hour time');
      for (const [key, max] of [['batteryLevel', 100], ['wifiBars', 4], ['cellularBars', 4]] as const) {
        if (o[key] !== undefined && (!Number.isInteger(o[key]) || Number(o[key]) < 0 || Number(o[key]) > max)) return bad(`${key} must be an integer from 0 to ${max}`);
      }
      return { ...o } as EnvironmentAction;
    case 'media':
      if (typeof o.path !== 'string' || !o.path || o.path.includes('\0') || o.path.length > 4096) return bad('media path must name a local image or video file');
      return { action: 'media', path: o.path };
    default: return bad('Unknown environment action');
  }
}
