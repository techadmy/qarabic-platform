/**
 * Qarabic design-token guard (audit 39 P1-9, docs/standards/design-tokens.md, apps/web/RTL.md):
 * class strings may not use physical (non-RTL) utilities, Tailwind palette colours, raw hex
 * colours or arbitrary font sizes. Checks every string and template literal, so `className`,
 * `cn()`, `cva()` and class constants are all covered.
 *
 * Exceptions: put `// eslint-disable-next-line qarabic/design-tokens -- <why>` on the line
 * (e.g. a shadcn internal keyed on `data-[side=left]`).
 */

// A class token starts at the string start, after whitespace, or after a variant `:`.
const START = String.raw`(?:^|[\s:"'\x60])`;
const PALETTE =
  'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose';

const CHECKS = [
  {
    id: 'physical',
    re: new RegExp(
      START +
        String.raw`(-?(?:ml|mr|pl|pr|left|right|scroll-ml|scroll-mr|scroll-pl|scroll-pr)-(?:\d|\[|px\b|auto\b|full\b)|text-(?:left|right)\b|(?:border|rounded)-(?:l|r|tl|tr|bl|br)(?:-|\b)|float-(?:left|right)\b|clear-(?:left|right)\b)`,
    ),
    message:
      '«{{match}}» is a physical (left/right) utility. Use the logical one (ms/me, ps/pe, start/end, text-start/end, border-s/e, rounded-s/e) so RTL works (apps/web/RTL.md).',
  },
  {
    id: 'palette',
    re: new RegExp(
      START +
        String.raw`((?:bg|text|border|ring|ring-offset|fill|stroke|from|via|to|outline|decoration|divide|placeholder|caret|accent|shadow)-(?:${PALETTE})-\d{2,3}\b)`,
    ),
    message:
      '«{{match}}» is a raw Tailwind palette colour. Use a token (text-muted-foreground, bg-warning, status-<tone>, …): docs/standards/design-tokens.md.',
  },
  {
    id: 'hex',
    re: new RegExp(START + String.raw`([a-z-]+-\[#[0-9a-fA-F]{3,8}\])`),
    message: '«{{match}}» is a raw hex colour. Add or use a token in packages/ui globals.css.',
  },
  {
    id: 'size',
    re: new RegExp(START + String.raw`(text-\[\d[\d.]*(?:px|rem|em)\])`),
    message:
      '«{{match}}» is an arbitrary font size. Use the scale (text-xs…text-2xl) or a token (text-caption, text-body, …): docs/standards/design-tokens.md.',
  },
];

function check(context, node, value) {
  if (typeof value !== 'string' || value.length < 3) return;
  for (const c of CHECKS) {
    const m = c.re.exec(value);
    if (!m) continue;
    // Report the whole class (e.g. «rounded-l-md», not just «rounded-l-»).
    const rest = /^[^\s"'\x60]*/.exec(value.slice(m.index + m[0].length))[0];
    context.report({ node, message: c.message, data: { match: m[1] + rest } });
  }
}

const rule = {
  meta: {
    type: 'problem',
    docs: { description: 'Design tokens and logical (RTL) utilities only in class strings.' },
    schema: [],
  },
  create(context) {
    return {
      Literal(node) {
        check(context, node, node.value);
      },
      TemplateElement(node) {
        check(context, node, node.value.cooked ?? node.value.raw);
      },
    };
  },
};

/** Flat-config block: `...designTokens` in an eslint.config.mjs. */
export const designTokens = {
  files: ['**/*.{ts,tsx}'],
  ignores: ['**/*.test.{ts,tsx}', '**/__tests__/**', '**/e2e/**', '**/mocks/**'],
  plugins: { qarabic: { rules: { 'design-tokens': rule } } },
  rules: { 'qarabic/design-tokens': 'error' },
};
export default designTokens;
