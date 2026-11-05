// Android clipboard (Backend.clipboardGet / clipboardSet) for emulators and phones. The on-device helper reads and
// sets the primary clip through the clipboard service as the shell user (android-helper.ts `clip get|set`), which
// works on builds without `cmd clipboard` (the Android 16 emulator image and vivo's Android 15 have none). Setting
// falls back to `cmd clipboard set-primary-clip` where a build has it; reading has no fallback.
// The text never goes on a command line (stdin only) and never into an error message.
import { PhoneDockError } from '../core/types.ts';
import { adb } from './android-common.ts';
import { helperClipGet, helperClipSet, helperEnabled } from './android-helper.ts';

const OFF = 'the on-device helper is turned off (PHONEDOCK_ANDROID_HELPER=0)';
/** Clipboard text can be secret: keep it out of anything that may be logged or returned. */
export function redact(s: string, text: string): string {
  return text.length >= 3 ? s.split(text).join('•••') : s;
}

export async function clipboardGet(serial: string): Promise<string | null> {
  if (!helperEnabled()) {
    throw new PhoneDockError('Reading the clipboard needs PhoneDock’s Android helper, which is turned off', 'not_supported', 501,
      ['Unset PHONEDOCK_ANDROID_HELPER (or set it to 1) and restart the PhoneDock service.'], OFF);
  }
  try { return await helperClipGet(serial); }
  catch (e) {
    throw new PhoneDockError('Couldn’t read the clipboard', 'clipboard_failed', 502,
      ['Check that the device is connected and unlocked, then try again.'], `helper clip get: ${(e as Error).message}`);
  }
}

// `cmd clipboard` takes the text as an argument: read it from stdin on the device (keeping trailing newlines).
const CMD_SET = 't="$(cat; echo .)"; t="${t%.}"; cmd clipboard set-primary-clip "$t" 2>&1 || echo __NOCLIP__';

export async function clipboardSet(serial: string, text: string): Promise<void> {
  let why = OFF;
  if (helperEnabled()) {
    try { await helperClipSet(serial, text); return; } catch (e) { why = `helper clip set: ${(e as Error).message}`; }
  }
  const r = await adb(serial, ['shell', CMD_SET], { allowFail: true, input: text, timeoutMs: 20_000 });
  const out = (r.stdout + ' ' + r.stderr).trim();
  if (r.code === 0 && !/__NOCLIP__|Unknown|No shell command|Exception|usage/i.test(out)) return;
  throw new PhoneDockError('Couldn’t set the clipboard', 'clipboard_failed', 502,
    ['Check that the device is connected and unlocked, then try again.'],
    redact(`${why}; cmd clipboard: ${out.slice(0, 300) || `exit ${r.code}`}`, text));
}
