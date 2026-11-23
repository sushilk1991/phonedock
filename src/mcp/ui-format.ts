// Shared compact UI formatter for MCP `get_ui` and action `observe: "ui" | "both"`.
// Handles session observation counters, unchanged-screen suppression (hashing exact printed output),
// snapshot binding, and strict element/character size caps.
import { windowsLine } from '../backends/android-windows.ts';
import { outlineHash } from '../core/ui-hash.ts';
import type { Device, UiElement, UiTree } from '../core/types.ts';
import { promptWarning } from './tools-extra.ts';
import type { McpContext, ScaleInfo } from './server.ts';

export type ObserveMode = 'none' | 'image' | 'ui' | 'both';
export const OBSERVE_MAX_ELEMENTS = 120;
export const OBSERVE_MAX_CHARS = 8000;
const HASH_PLACEHOLDER = '0'.repeat(16);

/** Resolve `observe` + legacy `return_screenshot`, rejecting conflicting combinations before sending input. */
export function resolveObserve(observe?: ObserveMode, returnScreenshot?: boolean): ObserveMode {
  if (returnScreenshot === true && (observe === 'none' || observe === 'ui')) {
    throw new Error(`Conflicting options: return_screenshot=true cannot be combined with observe="${observe}". Use observe="image" or observe="both" instead.`);
  }
  if (observe !== undefined) return observe;
  if (returnScreenshot === true) return 'image';
  return 'none';
}

const shortType = (t?: string) => (t ?? '').split('.').pop() ?? '';
const TOGGLE = /^(Switch|Toggle|CheckBox|ToggleButton|SwitchCompat|SwitchMaterial|MaterialSwitch)$/i;
const HUMAN_SCREENS: [RegExp, string][] = [
  [/\bcaptcha\b|I.m not a robot|verify (that )?you.?re (a )?human/i, 'a CAPTCHA'],
];

export function humanNeeded(texts: string[]): string | undefined {
  const all = texts.join('\n');
  for (const [re, what] of HUMAN_SCREENS) if (re.test(all)) return what;
  return undefined;
}

/** Tap-ready point (same rule as the daemon): a toggle row with its own inner switch is tapped on the switch. */
function tapPoint(e: UiElement): { x: number; y: number } {
  const c = (b: UiElement['bounds']) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
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

/** Fit any action-mode block strictly within `maxChars`, appending an explicit truncation notice when cut. */
function capActionBlock(block: string, maxChars: number | undefined, foot: string): { text: string; capped: boolean } {
  if (maxChars === undefined || block.length <= maxChars) return { text: block, capped: false };
  const suffix = `…\n${foot}`;
  if (suffix.length >= maxChars) return { text: foot.slice(0, maxChars), capped: true };
  return { text: `${block.slice(0, maxChars - suffix.length)}${suffix}`, capped: true };
}

export interface FormatUiOptions {
  ctx: McpContext;
  device: Device;
  tree: UiTree;
  scale: ScaleInfo;
  mode: 'full' | 'action';
  coordinateSpace?: 'image' | 'device';
  includeAll?: boolean;
  fullText?: boolean;
  visibleOnly?: boolean;
  interactiveOnly?: boolean;
  diff?: boolean;
  maxLines?: number;
  maxElements?: number;
  maxChars?: number;
}

export interface FormatUiResult {
  text: string;
  hash: string;
  obsCount: number;
  unchanged: boolean;
  totalElements: number;
  shownElements: number;
  truncated: boolean;
}

/** Format a UiTree for MCP, updating session snapshot, outline cache, and obs counter/hash.
 *  The MCP hash is computed over the exact printed outline (element lines in reported coordinates,
 *  prompt/human warnings, OCR notes, and overlay window lines), so equal hashes guarantee identical output. */
export function formatUiObservation(opts: FormatUiOptions): FormatUiResult {
  const { ctx, device: d, tree, mode } = opts;
  ctx.snapshots ??= new Map();
  if (tree.snapshotId) ctx.snapshots.set(d.id, tree.snapshotId);
  if (opts.coordinateSpace !== 'device') ctx.offSpace?.delete(d.id);

  ctx.uiObs ??= new Map();
  const prevObs = ctx.uiObs.get(d.id);
  const obsCount = (prevObs?.count ?? 0) + 1;

  const s = opts.coordinateSpace === 'device' ? { ...opts.scale, scale: 1 } : opts.scale;
  const sc = s.scale || 1;
  const maxLines = mode === 'action' ? (opts.maxElements ?? OBSERVE_MAX_ELEMENTS) : (opts.maxLines ?? 400);
  const maxChars = mode === 'action' ? (opts.maxChars ?? OBSERVE_MAX_CHARS) : undefined;

  const lines: string[] = [];
  let total = 0;
  const texts: string[] = [];
  let cutSome = false;
  const cut = (t: string, n: number) => {
    if (opts.fullText || t.length <= n) return t;
    cutSome = true;
    return t.slice(0, n - 3) + '…';
  };

  const walk = (els: UiElement[] | undefined, depth: number) => {
    for (const e of els ?? []) {
      const bounds = e.bounds;
      const offscreen = bounds && tree.screen?.width && tree.screen?.height
        && (bounds.x + bounds.width <= 0 || bounds.y + bounds.height <= 0 || bounds.x >= tree.screen.width || bounds.y >= tree.screen.height);
      if (opts.visibleOnly !== false && offscreen) continue;
      if (e.text || e.label) texts.push(`${e.text ?? ''} ${e.label ?? ''}`);
      const interesting = opts.interactiveOnly
        ? Boolean(e.clickable || e.scrollable || e.focused || /(?:TextField|EditText|TextInput|SecureTextField)$/.test(e.type))
        : Boolean(opts.includeAll || e.text || e.label || e.id || e.value || e.placeholder || e.clickable || e.scrollable || e.focused);
      if (interesting) {
        total++;
        if (lines.length < maxLines) {
          const b = e.bounds ?? { x: 0, y: 0, width: 0, height: 0 };
          const tp = tapPoint(e);
          const cx = Math.round(tp.x / sc);
          const cy = Math.round(tp.y / sc);
          const parts = [`${'  '.repeat(Math.min(depth, 12))}${e.ref}`, shortType(e.type)];
          if (e.text) parts.push(JSON.stringify(cut(e.text, 80)));
          if (e.label && e.label !== e.text) parts.push(`label=${JSON.stringify(cut(e.label, 80))}`);
          if (e.id) parts.push(`id=${e.id.replace(/^.*:id\//, '')}`);
          if (e.value && e.value !== e.text && !(e.checked !== undefined && /^[01]$/.test(e.value))) parts.push(`value=${JSON.stringify(cut(e.value, 60))}`);
          if (e.placeholder) parts.push(`placeholder=${JSON.stringify(cut(e.placeholder, 60))}${e.text || e.value ? '' : ' (empty)'}`);
          parts.push(`@(${cx},${cy})`, `${Math.round(b.width / sc)}x${Math.round(b.height / sc)}`);
          const flags = [
            e.clickable && 'clickable', e.scrollable && 'scrollable', e.focused && 'focused', e.selected && 'selected',
            e.checked === true && 'on', e.checked === false && 'off', e.enabled === false && 'disabled', e.ocr && 'ocr',
          ].filter(Boolean);
          if (flags.length) parts.push(`[${flags.join(',')}]`);
          lines.push(parts.join(' '));
        }
      }
      walk(e.children, interesting ? depth + 1 : depth);
    }
  };
  walk(tree.root, 0);

  const needs = humanNeeded(texts);
  const pr = tree.prompt;
  const warnings = [
    needs ? `NEEDS A HUMAN? This looks like ${needs}. Don't guess credentials or approve it yourself: call request_human(reason="…") and wait, then get_ui again.` : '',
    pr && !(pr.needsHuman && needs) ? promptWarning(pr) : '',
  ].filter(Boolean);

  const space = opts.coordinateSpace === 'device'
    ? `device pixels (${s.deviceWidth || tree.screen?.width}x${s.deviceHeight || tree.screen?.height})`
    : `image space ${s.imageWidth}x${s.imageHeight} (device ${s.deviceWidth}x${s.deviceHeight}, scale ${+sc.toFixed(4)})`;
  const om = tree.ocr;
  const over = windowsLine(tree.windows?.map((w) => ({
    ...w,
    bounds: { x: Math.round(w.bounds.x / sc), y: Math.round(w.bounds.y / sc), width: Math.round(w.bounds.width / sc), height: Math.round(w.bounds.height / sc) },
  })));
  const ocrNote = om?.merged
    ? `\n${om.merged} line${om.merged > 1 ? 's' : ''} marked [ocr] ${om.merged > 1 ? 'were' : 'was'} read from the screen: the accessibility tree has no content there, so controls in those rows (switches, buttons) aren't listed. tap(text=…) works on [ocr] text; for a control next to it, take a screenshot.`
    : om?.error
      ? `\nThe accessibility tree looks incomplete here (${om.regions.length} empty area${om.regions.length > 1 ? 's' : ''}) and OCR failed (${om.error.split('\n')[0].slice(0, 160)}); take a screenshot to see it.`
      : '';

  const headTail = (elemClause: string) =>
    `coordinates in ${space}. ${elemClause}`
    + (cutSome ? ' Long texts are cut (…): full_text=true shows them whole.' : '')
    + (warnings.length ? '\n' + warnings.join('\n') : '')
    + ocrNote
    + (over ? `\n${over} (not in this list)` : '');

  if (mode === 'action') {
    const tail = headTail(`${total} elements.`);
    const prefix = `UI of ${d.name} via ${tree.source}; obs=#${obsCount} hash=${HASH_PLACEHOLDER}${tree.snapshotId ? ` snapshot=${tree.snapshotId}` : ''}; `;
    const head = `${prefix}${tail}`;
    const stablePrefix = `UI via ${tree.source}; `;

    if (!lines.length) {
      const emptyFoot = `… truncated (${maxChars} char limit); call get_ui for the full tree.`;
      const rawOut = `${head}\nNo UI elements found — take a screenshot to see the screen.`;
      const capped = capActionBlock(rawOut, maxChars, emptyFoot);
      const stableOut = capped.capped
        ? `${stablePrefix}${capped.text.slice(prefix.length)}`
        : `${stablePrefix}${tail}\nNo UI elements found — take a screenshot to see the screen.`;
      const hash = outlineHash(stableOut);
      ctx.uiObs.set(d.id, { hash, count: obsCount });

      if (prevObs && prevObs.hash && prevObs.hash === hash) {
        const rawUnchanged = [
          `Screen unchanged (obs=#${obsCount}, hash=${hash}${tree.snapshotId ? `, snapshot=${tree.snapshotId}` : ''}).`,
          ...warnings,
        ].join('\n');
        const cappedUnchanged = capActionBlock(rawUnchanged, maxChars, emptyFoot);
        return { text: cappedUnchanged.text, hash, obsCount, unchanged: true, totalElements: 0, shownElements: 0, truncated: cappedUnchanged.capped };
      }
      return { text: capped.text.replace(HASH_PLACEHOLDER, hash), hash, obsCount, unchanged: false, totalElements: 0, shownElements: 0, truncated: capped.capped };
    }

    let elementCapped = total > lines.length;
    let charCapped = false;
    let kept = lines;
    const footerFor = (shown: number, reasons: string[]) =>
      `… truncated: showing ${shown} of ${total} elements (${reasons.join(' / ')}); call get_ui for the full tree.`;

    if (maxChars !== undefined) {
      const build = (arr: string[], trunc: boolean, reasons: string[]) => {
        const parts = [head, ...arr];
        if (trunc) parts.push(footerFor(arr.length, reasons));
        return parts.join('\n');
      };
      const initialReasons = elementCapped ? [`${maxLines} element limit`] : [];
      if (build(kept, elementCapped, initialReasons).length > maxChars) {
        charCapped = true;
        const reasons = [...(elementCapped ? [`${maxLines} element limit`] : []), `${maxChars} char limit`];
        let lo = 0;
        let hi = kept.length;
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2);
          if (build(kept.slice(0, mid), true, reasons).length <= maxChars) lo = mid;
          else hi = mid - 1;
        }
        kept = kept.slice(0, lo);
      }
    }

    const truncated = elementCapped || charCapped;
    const reasons = [
      ...(elementCapped ? [`${maxLines} element limit`] : []),
      ...(charCapped ? [`${maxChars} char limit`] : []),
    ];
    const foot = truncated ? footerFor(kept.length, reasons) : '';
    const rawOut = [head, ...kept, ...(truncated ? [foot] : [])].join('\n');
    const cappedHead = capActionBlock(rawOut, maxChars, footerFor(0, reasons));
    const finalTemplate = cappedHead.text;
    const stableOut = cappedHead.capped
      ? `${stablePrefix}${finalTemplate.slice(prefix.length)}`
      : [`${stablePrefix}${tail}`, ...kept, ...(truncated ? [foot] : [])].join('\n');
    const hash = outlineHash(stableOut);

    ctx.uiObs.set(d.id, { hash, count: obsCount });
    ctx.outlines ??= new Map();
    ctx.outlines.set(d.id, { lines });

    // Action-mode unchanged-screen suppression: equal hashes guarantee identical printed outline by construction.
    if (prevObs && prevObs.hash && prevObs.hash === hash) {
      const rawUnchanged = [
        `Screen unchanged (obs=#${obsCount}, hash=${hash}${tree.snapshotId ? `, snapshot=${tree.snapshotId}` : ''}).`,
        ...warnings,
      ].join('\n');
      const unchangedFoot = `… truncated (${maxChars} char limit); call get_ui for the full tree.`;
      const cappedUnchanged = capActionBlock(rawUnchanged, maxChars, unchangedFoot);
      return { text: cappedUnchanged.text, hash, obsCount, unchanged: true, totalElements: total, shownElements: 0, truncated: cappedUnchanged.capped };
    }

    return {
      text: finalTemplate.replace(HASH_PLACEHOLDER, hash),
      hash,
      obsCount,
      unchanged: false,
      totalElements: total,
      shownElements: cappedHead.capped ? 0 : kept.length,
      truncated: truncated || cappedHead.capped,
    };
  }

  // Full `get_ui` mode: preserve existing format + diff semantics, hashing the exact printed outline.
  const elemClause = `${total} elements${total > lines.length ? ` (showing ${lines.length}; raise max_lines)` : ''}.`;
  const tail = headTail(elemClause);
  const stablePrefix = `UI via ${tree.source}; `;

  if (!lines.length) {
    const hash = outlineHash(`${stablePrefix}${tail}\nNo UI elements found — take a screenshot to see the screen.`);
    ctx.uiObs.set(d.id, { hash, count: obsCount });
    const head = `UI of ${d.name} via ${tree.source}; obs=#${obsCount} hash=${hash}; ${tail}`;
    return { text: `${head}\nNo UI elements found — take a screenshot to see the screen.`, hash, obsCount, unchanged: false, totalElements: 0, shownElements: 0, truncated: false };
  }

  ctx.outlines ??= new Map();
  const previous = ctx.outlines.get(d.id);
  ctx.outlines.set(d.id, { lines });
  const old = new Set(previous?.lines);
  const now = new Set(lines);
  const isDiff = Boolean(opts.diff && previous);
  const shown = isDiff
    ? [
      ...previous!.lines.filter((l) => !now.has(l)).map((l) => `- ${l.replace(/\be\d+\b/, '(removed)')}`),
      ...lines.filter((l) => !old.has(l)).map((l) => `+ ${l}`),
    ]
    : lines;
  const body = `${isDiff ? 'Changes (removed lines cannot be targeted):\n' : ''}${shown.join('\n') || '(unchanged)'}`;
  const hash = outlineHash(`${stablePrefix}${tail}\n${body}`);
  ctx.uiObs.set(d.id, { hash, count: obsCount });

  const head = `UI of ${d.name} via ${tree.source}; obs=#${obsCount} hash=${hash}; ${tail}`;
  const fullOut = `${head}${tree.snapshotId ? ` snapshot=${tree.snapshotId}` : ''}\n${body}`;
  return { text: fullOut, hash, obsCount, unchanged: false, totalElements: total, shownElements: lines.length, truncated: total > lines.length };
}
