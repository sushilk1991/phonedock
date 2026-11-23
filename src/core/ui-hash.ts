// Deterministic hash of a UiTree's visible outline: equal hashes guarantee identical refs, bounds, text, flags, prompt, and overlays.
import { createHash } from 'node:crypto';
import type { UiElement, UiTree } from './types.ts';

const shortType = (t?: string) => (t ?? '').split('.').pop() ?? '';

/** 16-hex-char SHA-256 of the visible outline (insensitive to capturedAt, snapshotId, actionGeneration). */
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
        nodes.push([
          Math.min(depth, 12),
          e.ref ?? '',
          shortType(e.type),
          e.text ?? '',
          e.label ?? '',
          e.id ?? '',
          e.value ?? '',
          e.placeholder ?? '',
          bx, by, bw, bh,
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
      w.focused ? 1 : 0,
      w.described ? 1 : 0,
    ])
    : null;

  const ocr = tree.ocr ? [tree.ocr.merged, tree.ocr.error ?? ''] : null;

  return createHash('sha256')
    .update(JSON.stringify(['ui-v1', tree.source ?? '', W, H, nodes, pr, wins, ocr]))
    .digest('hex')
    .slice(0, 16);
}
