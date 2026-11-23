// Deterministic UI screen hashes:
// - `outlineHash(text)`: 16-hex-char SHA-256 over the exact formatted outline MCP emits (element lines, prompt/window
//   lines, and coordinates in the reported space), so equal MCP hashes guarantee identical printed output by construction.
// - `uiTreeHash(tree)`: 16-hex-char SHA-256 over the device-pixel UiTree structure for HTTP `GET /v1/devices/:id/ui`
//   and daemon `returnUi: true` responses (`UiTree.screenHash`).
import { createHash } from 'node:crypto';
import type { UiElement, UiTree } from './types.ts';

const shortType = (t?: string) => (t ?? '').split('.').pop() ?? '';
const TOGGLE = /^(Switch|Toggle|CheckBox|ToggleButton|SwitchCompat|SwitchMaterial|MaterialSwitch)$/i;

function tapPoint(e: UiElement): { x: number; y: number } {
  const c = (b: UiElement['bounds']) => ({ x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) });
  if (TOGGLE.test(shortType(e.type)) && e.children?.length) {
    const stack = [...e.children];
    while (stack.length) {
      const k = stack.shift()!;
      if (TOGGLE.test(shortType(k.type)) && k.bounds.width < e.bounds.width) return c(k.bounds);
      stack.push(...(k.children ?? []));
    }
  }
  return c(e.bounds ?? { x: 0, y: 0, width: 0, height: 0 });
}

/** 16-hex-char SHA-256 of the exact formatted outline text emitted to an agent. */
export function outlineHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/** 16-hex-char SHA-256 of the device-pixel UiTree (insensitive to capturedAt, snapshotId, actionGeneration). */
export function uiTreeHash(tree: UiTree): string {
  const W = tree.screen?.width ?? 0;
  const H = tree.screen?.height ?? 0;
  const nodes: unknown[] = [];

  const walk = (els: UiElement[] | undefined, depth: number) => {
    for (const e of els ?? []) {
      const b = e.bounds;
      const offscreen = W > 0 && H > 0 && b && (b.x + b.width <= 0 || b.y + b.height <= 0 || b.x >= W || b.y >= H);
      if (offscreen) continue;
      const interesting = Boolean(e.text || e.label || e.id || e.value || e.placeholder || e.clickable || e.scrollable || e.focused);
      if (interesting) {
        const bx = b?.x ?? 0, by = b?.y ?? 0, bw = b?.width ?? 0, bh = b?.height ?? 0;
        const tp = tapPoint(e);
        nodes.push([
          Math.min(depth, 12),
          e.ref ?? '',
          shortType(e.type),
          e.text ?? '',
          e.label ?? '',
          e.id ?? '',
          e.value ?? '',
          e.placeholder ?? '',
          bx, by, bw, bh, tp.x, tp.y,
          e.clickable ? 1 : 0,
          e.scrollable ? 1 : 0,
          e.focused ? 1 : 0,
          e.selected ? 1 : 0,
          e.checked === true ? 1 : e.checked === false ? 0 : -1,
          e.enabled === false ? 0 : 1,
          e.ocr ? 1 : 0,
        ]);
      }
      walk(e.children, interesting ? depth + 1 : depth);
    }
  };

  walk(tree.root, 0);

  const pr = tree.prompt
    ? [
      tree.prompt.kind,
      tree.prompt.reason,
      tree.prompt.needsHuman ? 1 : 0,
      tree.prompt.title ?? '',
      tree.prompt.message ?? '',
      ...(tree.prompt.buttons ?? []).map((b) => [b.text, b.ref ?? '', b.role ?? '']),
    ]
    : null;

  const wins = tree.windows?.length
    ? tree.windows.map((w) => [
      w.role,
      w.bounds.x, w.bounds.y, w.bounds.width, w.bounds.height,
      w.package ?? '',
      w.title ?? '',
      w.texts ?? [],
      w.focused ? 1 : 0,
      w.described ? 1 : 0,
    ])
    : null;

  const ocr = tree.ocr ? [tree.ocr.merged, tree.ocr.error ?? ''] : null;

  return createHash('sha256')
    .update(JSON.stringify(['ui-v2', tree.source ?? '', W, H, nodes, pr, wins, ocr]))
    .digest('hex')
    .slice(0, 16);
}
