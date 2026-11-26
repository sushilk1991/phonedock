// MCP tool `device_proxy`: manage saved HTTP/SOCKS5 proxies, test exit IP/country on the spot, and attach live to Android devices.
import { z } from 'zod';
import type { ProxyTestResult, ProxyView, DeviceProxyState } from '../sdk/client.ts';
import type { ToolKit } from './server.ts';

function fmtTest(r: ProxyTestResult): string {
  if (!r.ok) return `FAILED (${r.latencyMs} ms): ${r.error ?? 'error'}`;
  const loc = [r.city, r.country].filter(Boolean).join(', ');
  return `OK — IP ${r.ip ?? '?'}${loc ? ` (${loc})` : ''}${r.org ? `, ${r.org}` : ''} (${r.latencyMs} ms)`;
}

function fmtProxy(p: ProxyView): string {
  const test = p.lastTest ? ` | last test: ${fmtTest(p.lastTest)}` : ' | untested';
  return `${p.name} [id=${p.id}] ${p.url}${test}`;
}

function fmtDeviceProxy(st: DeviceProxyState, deviceName: string): string {
  if (!st.supported) return `${deviceName}: proxy not supported — ${st.reason ?? 'unsupported platform'}`;
  if (!st.proxy) return `${deviceName}: no proxy attached.`;
  const state = st.error ? `error: ${st.error}` : st.applied ? `active via 127.0.0.1:${st.localPort}` : 'saved (will apply on boot)';
  const exit = st.proxy.lastTest?.ok ? ` | exit ${st.proxy.lastTest.ip}${st.proxy.lastTest.country ? ` (${st.proxy.lastTest.country})` : ''}` : '';
  return `${deviceName}: ${st.proxy.name} [${st.proxy.id}] ${st.proxy.url} — ${state}${exit}${st.note ? `\nNote: ${st.note}` : ''}`;
}

export function registerProxyTools(k: ToolKit): void {
  const { tool, c, target, text, deviceParam } = k;

  tool(
    'device_proxy',
    'Manage saved HTTP/SOCKS5 proxies, test a proxy on the spot to see its exit IP and country, and attach/detach proxies on Android devices (emulators and real Android phones) live without restarting. Passwords are stored in 0600 proxies.json and never returned or logged. iOS returns not_supported. Actions: "list" (saved proxies), "test" (pass url or proxy_id), "add" (name + url, optional test=true), "remove" (proxy_id), "attach" (device + proxy_id), "detach" (device), "status" (device).',
    {
      action: z.enum(['list', 'test', 'add', 'remove', 'attach', 'detach', 'status']),
      device: deviceParam,
      proxy_id: z.string().optional().describe('Saved proxy id (for test, remove, attach)'),
      name: z.string().optional().describe('Short label when adding a proxy'),
      url: z.string().optional().describe('Proxy URL: http://, socks5://, or socks5h://[user:pass@]host:port (never returned)'),
      test: z.boolean().optional().describe('For action="add": test exit IP before returning'),
    },
    async (a) => {
      switch (a.action) {
        case 'list': {
          const list = await c.proxies();
          return {
            content: [text(list.length
              ? list.map(fmtProxy).join('\n')
              : 'No saved proxies. Use device_proxy(action="test", url="…") or action="add" to save one.')],
          };
        }
        case 'test': {
          if (a.url) {
            const res = await c.testProxyUrl(a.url);
            return { isError: !res.ok, content: [text(`Proxy test: ${fmtTest(res)}`)] };
          }
          if (a.proxy_id) {
            const res = await c.testProxy(a.proxy_id);
            return { isError: !res.result.ok, content: [text(`${res.proxy.name} [${res.proxy.id}]: ${fmtTest(res.result)}`)] };
          }
          throw new Error('action="test" requires url or proxy_id');
        }
        case 'add': {
          if (!a.name || !a.url) throw new Error('action="add" requires name and url');
          const saved = await c.addProxy(a.name, a.url, { test: a.test === true });
          return { content: [text(`Saved ${fmtProxy(saved)}`)] };
        }
        case 'remove': {
          if (!a.proxy_id) throw new Error('action="remove" requires proxy_id');
          const res = await c.deleteProxy(a.proxy_id);
          return { content: [text(`Removed proxy ${a.proxy_id}${res.detachedDevices.length ? ` (detached from ${res.detachedDevices.length} device(s))` : ''}.`)] };
        }
        case 'attach': {
          if (!a.proxy_id) throw new Error('action="attach" requires proxy_id');
          const d = await target(a.device);
          const st = await c.attachProxy(d.id, a.proxy_id);
          return { content: [text(fmtDeviceProxy(st, d.name))] };
        }
        case 'detach': {
          const d = await target(a.device);
          const st = await c.detachProxy(d.id);
          return { content: [text(fmtDeviceProxy(st, d.name))] };
        }
        case 'status': {
          const d = await target(a.device);
          const st = await c.deviceProxy(d.id);
          return { content: [text(fmtDeviceProxy(st, d.name))] };
        }
      }
    },
  );
}
