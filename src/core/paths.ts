// Filesystem layout + host tool discovery. PHONEDOCK_HOME overrides the state dir (used by tests).
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const PHONEDOCK_HOME = process.env.PHONEDOCK_HOME ?? join(homedir(), 'Library', 'Application Support', 'PhoneDock');
export const DEFAULT_PORT = Number(process.env.PHONEDOCK_PORT ?? 47420);

export function stateDir(...parts: string[]): string {
  const p = join(PHONEDOCK_HOME, ...parts);
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
  return p;
}

/** daemon.json: { port, token, pid, startedAt } – read by CLI/MCP/SDK/app to find the daemon.
 *  A daemon on a non-default port (tests, workers) uses daemon-<port>.json so it never clobbers the main one. */
export function daemonInfoName(port: number = DEFAULT_PORT): string { return port === 47420 ? 'daemon.json' : `daemon-${port}.json`; }
export const DAEMON_INFO_FILE = join(PHONEDOCK_HOME, daemonInfoName());

function firstExisting(cands: (string | undefined)[]): string | undefined {
  return cands.find((c) => c && existsSync(c));
}

export function androidSdkRoot(): string | undefined {
  return firstExisting([
    process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT,
    join(homedir(), 'Library', 'Android', 'sdk'),
    '/opt/homebrew/share/android-commandlinetools',
    '/usr/local/share/android-commandlinetools',
  ]);
}

export function javaHome(): string | undefined {
  return firstExisting([
    process.env.JAVA_HOME,
    '/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home',
    '/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home',
    '/Applications/Android Studio.app/Contents/jbr/Contents/Home',
  ]);
}

/** Xcode developer dir (xcode-select may point at CommandLineTools, which lacks simctl). */
export function developerDir(): string | undefined {
  return firstExisting([process.env.DEVELOPER_DIR, '/Applications/Xcode.app/Contents/Developer', '/Applications/Xcode-beta.app/Contents/Developer']);
}

/** Find a host binary on PATH or common locations. */
export function which(name: string, extra: string[] = []): string | undefined {
  const dirs = [...(process.env.PATH ?? '').split(':'), '/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local', 'bin'), ...extra];
  return firstExisting(dirs.map((d) => (d ? join(d, name) : undefined)));
}

/** Env for child processes that need Xcode / Java / Android SDK. */
export function toolEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const dd = developerDir(); if (dd) env.DEVELOPER_DIR = dd;
  const jh = javaHome(); if (jh) env.JAVA_HOME = jh;
  const sdk = androidSdkRoot(); if (sdk) { env.ANDROID_HOME = sdk; env.ANDROID_SDK_ROOT = sdk; }
  env.PATH = [env.PATH, '/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local', 'bin')].filter(Boolean).join(':');
  return env;
}
