// Heuristics from one accessibility observation, not an accessibility-compliance certification.
import type { Bounds, Platform, UiElement, UiTree } from './types.ts';
export interface UiAuditFinding {
  kind: 'missing_label' | 'small_target' | 'clipped' | 'offscreen' | 'occluded';
  ref: string; severity: 'warning' | 'info'; confidence: 'medium' | 'low'; message: string;
  bounds: Bounds; units?: 'pt' | 'dp'; size?: { width: number; height: number }; coveredBy?: string;
}
export interface UiAuditResult { source: UiTree['source']; capturedAt: string; snapshotId?: string; findings: UiAuditFinding[]; examined: number; limitations: string[] }
const nodes = (root: UiElement[]): UiElement[] => root.flatMap((e) => [e, ...nodes(e.children ?? [])]);
const control = (e: UiElement) => e.clickable || /(?:Button|Switch|CheckBox|Toggle|TextField|SecureTextField|EditText|TextInput|Slider)$/.test(e.type.split('.').pop() ?? '');
const hasName = (e: UiElement): boolean => !!(e.label?.trim() || e.text?.trim() || e.placeholder?.trim() || e.children?.some(hasName));
const contains = (b: Bounds, x: number, y: number) => x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height;
export function auditUiTree(tree: UiTree, platform: Platform, opts: { includeOffscreen?: boolean } = {}): UiAuditResult {
  const findings: UiAuditFinding[] = [], limitations = ['These findings are heuristics from one UI tree; verify them against the app and screen reader.'];
  const { width: w, height: h } = tree.screen;
  const ratio = platform === 'ios' ? tree.screen.scale : platform === 'android' && tree.screen.density ? tree.screen.density / 160 : undefined;
  const threshold = platform === 'ios' ? 44 : 48, units = platform === 'ios' ? 'pt' : 'dp';
  if (!ratio || !Number.isFinite(ratio) || ratio <= 0) limitations.push(platform === 'android' ? 'Android density is unknown; touch-target sizing was skipped.' : 'Native screen scale is unknown; touch-target sizing was skipped.');
  if (tree.source === 'ocr') limitations.push('OCR cannot establish accessible labels or true interactive hit areas; semantic and touch-target checks were skipped.');
  if (!w || !h) limitations.push('Screen dimensions are unknown; screen-edge checks were skipped.');
  let examined = 0;
  const all = nodes(tree.root);
  const overlays: { bounds: Bounds; name: string; own?: Set<UiElement> }[] = (tree.windows ?? []).filter((x) => ['keyboard', 'heads_up', 'dialog'].includes(x.role) && !x.described).map((x) => ({ bounds: x.bounds, name: x.role === 'keyboard' ? 'the keyboard' : x.role }));
  // Float bars are inferred geometrically, never assumed to be proof of a broken layout.
  if (platform === 'ios') for (const e of all) {
    const b = e.bounds;
    const search = /(?:TextField|SecureTextField|EditText|TextInput)$/.test(e.type) && h && b.y + b.height / 2 > h * 0.8 && b.width > w * 0.4;
    const tabs = /TabBar$/.test(e.type) && h && b.y > h * 0.75;
    if (search || tabs) {
      const y = Math.max(0, b.y - (search ? Math.max(24, b.height * 0.4) : 0));
      overlays.push({ bounds: { x: 0, y, width: w, height: h - y }, name: search ? 'the floating search field' : 'the floating tab bar', own: new Set(nodes([e])) });
    }
  }
  for (const e of all) {
    const b = e.bounds;
    if (!control(e) || !b || ![b.x, b.y, b.width, b.height].every(Number.isFinite) || b.width <= 0 || b.height <= 0) continue;
    const outside = !!(w && h && (b.x + b.width <= 0 || b.y + b.height <= 0 || b.x >= w || b.y >= h));
    if (outside && !opts.includeOffscreen) continue;
    examined++;
    const add = (kind: UiAuditFinding['kind'], message: string, extra: Partial<UiAuditFinding> = {}) => findings.push({ kind, ref: e.ref, severity: 'warning', confidence: 'medium', message, bounds: { ...b }, ...extra });
    if (outside) { add('offscreen', 'Interactive element is outside the screenshot; it may be an intentionally loaded list row.', { severity: 'info', confidence: 'low' }); continue; }
    if (tree.source !== 'ocr' && !e.ocr && !hasName(e)) add('missing_label', 'Interactive element has no label, text, placeholder or named descendant.');
    if (tree.source !== 'ocr' && !e.ocr && ratio && Number.isFinite(ratio) && ratio > 0 && (platform === 'ios' || platform === 'android')) {
      const size = { width: +(b.width / ratio).toFixed(1), height: +(b.height / ratio).toFixed(1) };
      if (size.width < threshold || size.height < threshold) add('small_target', `Reported frame is smaller than ${threshold}×${threshold} ${units}; actual hit area may be larger.`, { size, units, confidence: 'low' });
    }
    if (w && h && (b.x < 0 || b.y < 0 || b.x + b.width > w || b.y + b.height > h)) add('clipped', 'Interactive element crosses a screenshot edge; check whether clipping is intentional.', { confidence: 'low' });
    const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
    const overlay = overlays.find((x) => contains(x.bounds, cx, cy) && !x.own?.has(e));
    if (overlay) add('occluded', `The reported activation center is covered by ${overlay.name}.`, { coveredBy: overlay.name, confidence: 'low' });
  }
  return { source: tree.source, capturedAt: tree.capturedAt, ...(tree.snapshotId ? { snapshotId: tree.snapshotId } : {}), examined, findings, limitations };
}
