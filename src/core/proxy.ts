// Saved proxy types, URL parsing, validation, and secret redaction.
// Passwords are never returned by APIs, never logged, and scrubbed from error strings.
import { PhoneDockError } from './types.ts';

export type ProxyScheme = 'http' | 'socks5' | 'socks5h';

export interface ProxyEndpoint {
  scheme: ProxyScheme;
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export interface ProxyTestResult {
  ok: boolean;
  ip?: string;
  country?: string;
  city?: string;
  org?: string;
  timezone?: string;
  lat?: number;
  lon?: number;
  latencyMs: number;
  at: string;
  error?: string;
}

/** Internal on-disk record in stateDir()/proxies.json (mode 0600). Never send directly over HTTP. */
export interface SavedProxyStored extends ProxyEndpoint {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  lastTest?: ProxyTestResult;
}

/** Public API view of a saved proxy: password is omitted and the URL is redacted. */
export interface ProxyView {
  id: string;
  name: string;
  scheme: ProxyScheme;
  host: string;
  port: number;
  username?: string;
  hasAuth: boolean;
  url: string;
  createdAt: string;
  updatedAt: string;
  lastTest?: ProxyTestResult;
}

/** Current proxy attachment and runtime state for a single device. */
export interface DeviceProxyState {
  deviceId: string;
  supported: boolean;
  reason?: string;
  proxyId: string | null;
  proxy: ProxyView | null;
  applied: boolean;
  localPort?: number;
  locationSynced?: { lat: number; lon: number; city?: string; country?: string };
  error?: string;
  note?: string;
}

const VALID_SCHEMES = new Set<string>(['http', 'socks5', 'socks5h']);
const MAX_NAME_LEN = 120;
const MAX_URL_LEN = 2048;

export function normalizeProxyName(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new PhoneDockError('Proxy name is required', 'bad_request', 400, ['Provide a short name, such as "US residential".']);
  }
  const name = raw.trim();
  if (!name || name.length > MAX_NAME_LEN) {
    throw new PhoneDockError(`Proxy name must be 1–${MAX_NAME_LEN} characters`, 'bad_request', 400);
  }
  if (/[\r\n\0]/.test(name)) {
    throw new PhoneDockError('Proxy name cannot contain control characters', 'bad_request', 400);
  }
  return name;
}

/** Format a host for URLs/Host headers (brackets raw IPv6 addresses). */
export function formatHostForUrl(host: string): string {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  return bare.includes(':') ? `[${bare}]` : bare;
}

/** Parse and validate an HTTP or SOCKS5 proxy URL. Credentials are decoded; password is kept only in memory/0600 store. */
export function parseProxyUrl(raw: unknown): ProxyEndpoint {
  if (typeof raw !== 'string') {
    throw new PhoneDockError('Proxy URL is required', 'bad_request', 400, ['Use http://, socks5://, or socks5h://host:port']);
  }
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_URL_LEN) {
    throw new PhoneDockError('Proxy URL is empty or too long', 'bad_request', 400);
  }
  if (/[\r\n\t\0\s]/.test(trimmed)) {
    throw new PhoneDockError('Proxy URL cannot contain whitespace or control characters', 'bad_request', 400);
  }

  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(trimmed);
  if (!schemeMatch) {
    throw new PhoneDockError('Proxy URL must include a scheme', 'bad_request', 400, ['Use http://host:port, socks5://host:port, or socks5h://host:port.']);
  }
  const scheme = schemeMatch[1].toLowerCase();
  if (!VALID_SCHEMES.has(scheme)) {
    throw new PhoneDockError(`Unsupported proxy scheme "${scheme}"`, 'bad_request', 400, ['Supported schemes: http, socks5, socks5h.']);
  }

  const rest = trimmed.slice(schemeMatch[0].length);
  // Check explicit port before WHATWG URL parsing (which rejects >65535 generically and strips :80).
  const authority = rest.split('/', 1)[0];
  const hostPort = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority;
  const portMatch = hostPort.startsWith('[') ? /\]:(\d+)$/.exec(hostPort) : /:(\d+)$/.exec(hostPort);
  if (!portMatch) {
    throw new PhoneDockError('Proxy URL must include an explicit port', 'bad_request', 400, ['Example: socks5://user:pass@proxy.example.com:1080']);
  }
  const port = Number(portMatch[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new PhoneDockError(`Proxy port must be between 1 and 65535 (got ${portMatch[1]})`, 'bad_request', 400);
  }

  let parsed: URL;
  try {
    // Replace socks5/socks5h temporarily with http so IPv6/host/port/auth parsing follows WHATWG rules.
    parsed = new URL(`http://${rest}`);
  } catch {
    throw new PhoneDockError('Invalid proxy URL', 'bad_request', 400, ['Expected format: scheme://[user:pass@]host:port']);
  }

  if (parsed.pathname && parsed.pathname !== '/') {
    throw new PhoneDockError('Proxy URL must not include a path', 'bad_request', 400, ['Use scheme://[user:pass@]host:port without a path.']);
  }
  if (parsed.search || parsed.hash) {
    throw new PhoneDockError('Proxy URL must not include query parameters or fragments', 'bad_request', 400);
  }

  const rawHost = parsed.hostname;
  if (!rawHost) {
    throw new PhoneDockError('Proxy URL is missing a host', 'bad_request', 400);
  }
  const host = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost;
  if (!host || /[\s\r\n\0]/.test(host)) {
    throw new PhoneDockError('Proxy host is invalid', 'bad_request', 400);
  }

  let username: string | undefined;
  let password: string | undefined;
  try {
    if (parsed.username !== '') username = decodeURIComponent(parsed.username);
    if (parsed.password !== '') password = decodeURIComponent(parsed.password);
  } catch {
    throw new PhoneDockError('Proxy credentials contain invalid percent-encoding', 'bad_request', 400);
  }

  if (username !== undefined && Buffer.byteLength(username, 'utf8') > 255) {
    throw new PhoneDockError('Proxy username is too long (max 255 bytes)', 'bad_request', 400);
  }
  if (password !== undefined && Buffer.byteLength(password, 'utf8') > 255) {
    throw new PhoneDockError('Proxy password is too long (max 255 bytes)', 'bad_request', 400);
  }

  return {
    scheme: scheme as ProxyScheme,
    host,
    port,
    ...(username !== undefined ? { username } : {}),
    ...(password !== undefined ? { password } : {}),
  };
}

/** Format a proxy URL with any password replaced by `***`. Never outputs the real password. */
export function redactProxyUrl(p: Pick<ProxyEndpoint, 'scheme' | 'host' | 'port' | 'username' | 'password'> & { hasAuth?: boolean }): string {
  const host = formatHostForUrl(p.host);
  const hasAuth = Boolean(p.hasAuth || p.username !== undefined || p.password !== undefined);
  if (!hasAuth) return `${p.scheme}://${host}:${p.port}`;
  const userPart = p.username ? encodeURIComponent(p.username) : '';
  return `${p.scheme}://${userPart}:***@${host}:${p.port}`;
}

/** Scrub any known proxy passwords (raw or percent-encoded) and inline URL credentials from an error or log string. */
export function redactProxySecrets(text: string, secrets: readonly (string | undefined)[] = []): string {
  let out = text.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/\s:@]*):([^@\s/]+)@/g, '$1:***@');
  for (const s of secrets) {
    if (!s) continue;
    out = out.split(s).join('***');
    const encoded = encodeURIComponent(s);
    if (encoded && encoded !== s) out = out.split(encoded).join('***');
    const b64 = Buffer.from(s, 'utf8').toString('base64');
    if (s.length >= 4 && b64) out = out.split(b64).join('***');
  }
  return out;
}

/** Convert an internal stored proxy into a safe API view without the password. */
export function toProxyView(stored: SavedProxyStored): ProxyView {
  const hasAuth = stored.username !== undefined || stored.password !== undefined;
  return {
    id: stored.id,
    name: stored.name,
    scheme: stored.scheme,
    host: stored.host,
    port: stored.port,
    ...(stored.username !== undefined ? { username: stored.username } : {}),
    hasAuth,
    url: redactProxyUrl(stored),
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    ...(stored.lastTest ? { lastTest: stored.lastTest } : {}),
  };
}
