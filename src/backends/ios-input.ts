import { fileURLToPath } from 'node:url';
import { PhoneDockError, type AppInfo } from '../core/types.ts';

export interface PasteBegin { token: string; restorable: boolean }
export interface PasteFinish { restored: boolean; reason?: string }
export interface UnicodePasteDeps {
  beforeInput?(): void;
  begin(text: string, secret: boolean): Promise<PasteBegin>;
  paste(): Promise<void>;
  verify(): Promise<boolean>;
  finish(token: string, confirmed: boolean): Promise<PasteFinish>;
}
/** HID acknowledgement alone does not prove an app accepted paste (iOS may be asking the person). No retries. */
export async function pasteUnicode(text: string, secret: boolean, deps: UnicodePasteDeps): Promise<void> {
  deps.beforeInput?.();
  const begun = await deps.begin(text, secret); // a preflight rejection has sent no keyboard input
  let confirmed = false; let attempted = false; let cancelled: unknown;
  try {
    deps.beforeInput?.();
    attempted = true;
    await deps.paste();
    confirmed = await deps.verify();
  } catch (e) { if (!attempted) cancelled = e; /* Other errors may contain secret text: never expose them. */ }
  let finish: PasteFinish | undefined;
  try { finish = await deps.finish(begun.token, confirmed || !attempted); } catch { /* don't leak clipboard payload through an error */ }
  if (!attempted) {
    if (cancelled instanceof PhoneDockError) { cancelled.delivery = 'not_sent'; throw cancelled; }
    throw new PhoneDockError('Text input was cancelled before pasting', 'aborted', 499, undefined, undefined, 'not_sent');
  }
  if (!confirmed) throw new PhoneDockError('The paste could not be confirmed', 'paste_unconfirmed', 409,
    ['Check the field and handle any Allow Paste prompt before trying again.', 'The clipboard may still contain the text. Clear it manually after the paste is finished.'],
    'The paste shortcut was sent or may have been sent. The clipboard was not restored because the app may still need it. Do not resend the text blindly.', 'unknown');
  if (secret && !finish?.restored && finish?.reason !== 'clipboard_changed') throw new PhoneDockError('Text was pasted, but the clipboard could not be restored', 'clipboard_restore_failed', 502,
    ['The text was already entered: do not type it again.', 'Clear the device clipboard manually.'],
    'The field confirmed the insertion; restoring the previous clipboard failed. No text is included in diagnostics.', 'sent');
}

interface ProcessInfo { processIdentifier: number; executable?: string; executableURL?: string | { relative?: string }; bundleIdentifier?: string }
interface AppRecord { bundleIdentifier?: string; name?: string; url?: string; path?: string }
const nativePath = (value: string): string | undefined => {
  try { return (value.startsWith('file:') ? fileURLToPath(value) : value).replace(/\/+$/, ''); } catch { return undefined; }
};
/** AX supplies the frontmost PID; a process list alone cannot. Reject ambiguous matches and app extensions. */
export function resolveForegroundApp(pid: number | null | undefined, apps: AppRecord[], processes: ProcessInfo[]): AppInfo | null {
  const unknown = () => new PhoneDockError('The foreground app could not be identified', 'foreground_unknown', 502,
    ['Read the screen to identify the app. An unresolved PID does not establish that the home screen is showing.']);
  if (!Number.isInteger(pid) || Number(pid) <= 0) throw unknown();
  const process = processes.find((p) => p.processIdentifier === pid);
  if (!process) throw unknown();
  if (process.bundleIdentifier === 'com.apple.springboard') return null;
  const value = process.executable ?? (typeof process.executableURL === 'string' ? process.executableURL : process.executableURL?.relative);
  const exe = value ? nativePath(value) : undefined;
  const matches = apps.filter((a) => {
    if (!a.bundleIdentifier) return false;
    if (process.bundleIdentifier) return process.bundleIdentifier === a.bundleIdentifier;
    const root = a.url ?? a.path; const path = root ? nativePath(root) : undefined;
    const relative = exe && path && exe.startsWith(path + '/') ? exe.slice(path.length + 1) : undefined;
    return !!relative && !relative.includes('/');
  });
  if (matches.length !== 1) throw unknown();
  if (matches[0].bundleIdentifier === 'com.apple.springboard') return null;
  return { id: matches[0].bundleIdentifier!, ...(matches[0].name ? { name: matches[0].name } : {}) };
}
