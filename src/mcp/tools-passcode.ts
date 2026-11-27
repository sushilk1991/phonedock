// MCP tool `unlock_device`: unlock a device using the passcode the user saved in PhoneDock (macOS Keychain).
// Security invariant: the agent NEVER supplies, sees, or modifies the passcode. If unattended unlock is not enabled,
// unsupported (e.g. iOS 18–26 WDA), before first unlock after reboot, or paused by the 1-failure circuit breaker,
// the tool returns clear instructions to hand off to the human (`request_human`).
import { z } from 'zod';
import type { PasscodeStatus } from '../sdk/client.ts';
import type { ToolKit } from './server.ts';

function fmtPasscodeStatus(st: PasscodeStatus, name: string): string {
  if (!st.supported) return `${name}: unattended unlock is not supported — ${st.reason ?? 'unsupported device'}. Use request_human if locked.`;
  if (!st.hasPasscode) return `${name}: no passcode saved in PhoneDock. Ask the user to save one in PhoneDock Device Settings (Unattended Unlock), or call request_human.`;
  if (st.tripped) return `${name}: unattended unlock is PAUSED after a failed attempt (${st.tripped.reason}). Ask the user to re-save the passcode in PhoneDock Device Settings, or call request_human.`;
  if (!st.enabled) return `${name}: passcode is saved, but unattended unlock is turned OFF. Ask the user to enable "Allow agent to unlock" in Device Settings, or call request_human.`;
  const last = st.lastUnlock ? ` Last unlock: ${st.lastUnlock.ok ? 'OK' : 'failed'} at ${st.lastUnlock.at}.` : '';
  return `${name}: unattended unlock is READY (passcode stored in ${st.storage === 'keychain' ? 'macOS Keychain' : 'local store'}).${last}`;
}

export function registerPasscodeTools(k: ToolKit): void {
  const { tool, c, target, text, deviceParam } = k;

  tool(
    'unlock_device',
    'Wake and unlock a locked phone or emulator using the passcode the user saved in PhoneDock (macOS Keychain). You never see, supply, or change the passcode. Works on Android phones/emulators (PIN, password, or swipe lock) and iOS 27+ iPhones; not supported on iOS 18–26 (WDA) or before first unlock after a reboot. If a saved passcode fails once, PhoneDock pauses unattended unlock automatically to prevent lockout — call request_human instead of retrying. Set status_only=true to check whether unattended unlock is configured without unlocking.',
    {
      device: deviceParam,
      status_only: z.boolean().optional().describe('If true, only check whether unattended unlock is configured and ready without unlocking'),
    },
    async (a) => {
      const d = await target(a.device);
      if (a.status_only === true) {
        const st = await c.passcodeStatus(d.id);
        return { content: [text(fmtPasscodeStatus(st, d.name))] };
      }
      const res = await c.unlock(d.id);
      const how = res.alreadyUnlocked
        ? 'was already unlocked'
        : `unlocked${res.method ? ` via ${res.method}` : ''}`;
      return { content: [text(`${d.name}: ${how}. You can continue interacting with the device.`)] };
    },
  );
}
