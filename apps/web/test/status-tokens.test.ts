import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Status tones (`--status-*` in packages/ui globals.css) must stay legible in both themes:
 * chip text on its fill ≥ 4.5:1 (WCAG 1.4.3) and an emphasis number/icon on a card or the
 * canvas ≥ 4.5:1. The chip border is decorative (the text and icon carry the meaning).
 */
// Vitest runs from apps/web (turbo and `pnpm test` both).
const css = readFileSync(resolve(process.cwd(), '../../packages/ui/src/styles/globals.css'), 'utf8');

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {\n  --background`);
  const body = css.slice(start, css.indexOf('\n}', start));
  return Object.fromEntries(
    [...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]),
  );
}

type Rgb = [number, number, number];

function parse(value: string): Rgb {
  const hex = value.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1]!, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255) as Rgb;
  }
  const ok = value.match(/^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)\s*\)$/);
  if (!ok) throw new Error(`Unsupported colour ${value}`);
  const L = Number(ok[1]) / (ok[2] ? 100 : 1);
  const C = Number(ok[3]);
  const h = (Number(ok[4]) * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return lin.map((v) => {
    const c = Math.min(1, Math.max(0, v));
    return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
  }) as Rgb;
}

function luminance([r, g, b]: Rgb) {
  const f = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(fg: string, bg: string) {
  const [a, b] = [luminance(parse(fg)), luminance(parse(bg))].sort((x, y) => y - x);
  return (a! + 0.05) / (b! + 0.05);
}

const TONES = [
  'green',
  'amber',
  'orange',
  'red',
  'rose',
  'violet',
  'sky',
  'brown',
  'indigo',
  'teal',
];

describe.each([
  ['light', block(':root')],
  ['dark', block('.dark')],
])('status tokens (%s)', (_theme, vars) => {
  it.each(TONES)('%s chip text on its fill ≥ 4.5:1', (tone) => {
    expect(contrast(vars[`status-${tone}-foreground`]!, vars[`status-${tone}`]!)).toBeGreaterThanOrEqual(4.5);
  });
  it.each(TONES)('%s emphasis on the card and the canvas ≥ 4.5:1', (tone) => {
    const emphasis = vars[`status-${tone}-emphasis`]!;
    expect(contrast(emphasis, vars.card!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(emphasis, vars.background!)).toBeGreaterThanOrEqual(4.5);
  });
});
