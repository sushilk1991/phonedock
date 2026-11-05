// Pure helpers for the device settings API. Native category names are those printed by simctl ui.
export const IOS_TEXT_SIZES = [
  ['extra-small', 14], ['small', 15], ['medium', 16], ['large', 17],
  ['extra-large', 19], ['extra-extra-large', 21], ['extra-extra-extra-large', 23],
  ['accessibility-medium', 28], ['accessibility-large', 33], ['accessibility-extra-large', 40],
  ['accessibility-extra-extra-large', 47], ['accessibility-extra-extra-extra-large', 53],
] as const;
export type IosTextCategory = typeof IOS_TEXT_SIZES[number][0];
export type TextSizeInput = number | 'default' | 'smallest' | 'largest' | IosTextCategory;

/** Translate a simctl category to its body-size ratio; unknown/unsupported cannot be represented. */
export function iosTextScale(category: string): number | undefined {
  const item = IOS_TEXT_SIZES.find(([name]) => name === category.trim());
  return item ? item[1] / 17 : undefined;
}

/** Map ratios to the nearest body size. Ties pick the smaller category. */
export function iosTextCategory(input: TextSizeInput): IosTextCategory {
  if (input === 'default') return 'large';
  if (input === 'smallest') return IOS_TEXT_SIZES[0][0];
  if (input === 'largest') return IOS_TEXT_SIZES[IOS_TEXT_SIZES.length - 1][0];
  if (typeof input === 'string') {
    const item = IOS_TEXT_SIZES.find(([name]) => name === input);
    if (!item) throw new Error('Unknown iOS content size category');
    return item[0];
  }
  if (!Number.isFinite(input) || input <= 0) throw new Error('textSize must be a positive finite number');
  return IOS_TEXT_SIZES.reduce((best, item) => Math.abs(item[1] / 17 - input) < Math.abs(best[1] / 17 - input) - 1e-12 ? item : best)[0];
}

/** Android settings returns the literal string "null" for absent values. */
export function parseAndroidSettingNumber(output: string): number | undefined {
  const s = output.trim();
  if (!s || s === 'null' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(s)) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

export interface SettingsInput {
  appearance?: 'light' | 'dark';
  textSize?: TextSizeInput;
  boldText?: boolean;
  increaseContrast?: boolean;
  reduceMotion?: boolean;
  reduceTransparency?: boolean;
  colorFilter?: 'none' | 'grayscale' | 'invert';
}

/** Validate a complete patch before any device mutation takes place. */
export function validateSettingsInput(value: unknown): SettingsInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('settings must be an object');
  const o = value as Record<string, unknown>;
  const allowed = new Set(['appearance', 'textSize', 'boldText', 'increaseContrast', 'reduceMotion', 'reduceTransparency', 'colorFilter']);
  for (const [key, v] of Object.entries(o)) {
    if (!allowed.has(key)) throw new Error(`Unknown setting: ${key}`);
    if (key === 'appearance' && v !== 'light' && v !== 'dark') throw new Error('appearance must be light or dark');
    if (key === 'textSize') {
      if (typeof v === 'number') {
        if (!Number.isFinite(v) || v <= 0) throw new Error('textSize must be a positive finite number');
      } else if (typeof v !== 'string' || !['default', 'smallest', 'largest', ...IOS_TEXT_SIZES.map(([name]) => name)].includes(v)) {
        throw new Error('textSize must be a positive scale, keyword or iOS category');
      }
    }
    if (['boldText', 'increaseContrast', 'reduceMotion', 'reduceTransparency'].includes(key) && typeof v !== 'boolean') throw new Error(`${key} must be a boolean`);
    if (key === 'colorFilter' && v !== 'none' && v !== 'grayscale' && v !== 'invert') throw new Error('colorFilter must be none, grayscale or invert');
  }
  return o as SettingsInput;
}
