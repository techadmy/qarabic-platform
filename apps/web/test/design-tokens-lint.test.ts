import { Linter } from 'eslint';
import { designTokens } from '../../../packages/config/eslint/design-tokens.mjs';

/**
 * Audit 39 P1-9: the design-token guard that `pnpm lint` runs in apps/web and packages/ui.
 * Acceptance: adding `ml-2`, `bg-red-500` or `text-[13px]` fails lint.
 */
const linter = new Linter({ configType: 'flat' });
// The samples are plain JSX, so ESLint's own parser reads them (the real lint uses the TS parser).
const config = [
  {
    files: ['**/*.jsx'],
    languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
  },
  { ...designTokens, files: ['**/*.jsx'] },
];

function lint(code: string) {
  return linter
    .verify(code, config as Linter.Config[], { filename: 'x.jsx' })
    .filter((m) => m.ruleId === 'qarabic/design-tokens')
    .map((m) => m.message);
}

describe('qarabic/design-tokens lint rule', () => {
  it('fails on physical utilities, palette colours, hex colours and arbitrary font sizes', () => {
    expect(lint('const a = <div className="ml-2 bg-red-500" />;')).toEqual([
      expect.stringContaining('«ml-2» is a physical'),
      expect.stringContaining('«bg-red-500» is a raw Tailwind palette colour'),
    ]);
    expect(lint('const a = <p className="text-[13px]" />;')[0]).toContain('«text-[13px]»');
    expect(lint("const a = cn('md:text-right', x);")[0]).toContain('«text-right»');
    expect(lint('const a = `rounded-l-md ${x}`;')[0]).toContain('«rounded-l-md»');
    expect(lint("const a = 'dark:border-emerald-900';")[0]).toContain('«border-emerald-900»');
    expect(lint("const a = 'bg-[#651c1e]';")[0]).toContain('«bg-[#651c1e]»');
    expect(lint("const a = 'pr-[3px] -left-2';")).toHaveLength(1);
  });

  it('passes logical utilities, tokens and ordinary text', () => {
    expect(
      lint(
        'const a = <div className="ms-2 pe-4 start-0 text-start border-s rounded-e-md bg-warning text-status-green-emphasis text-caption md:text-body text-[length:var(--x)]" />;',
      ),
    ).toEqual([]);
    expect(lint("const a = 'Turn left at the red-500 sign'; const b = 'margin-left';")).toEqual([]);
    expect(lint("const a = 'w-[22rem] max-w-[420px] grid-cols-[9rem_1fr]';")).toEqual([]);
  });

  it('can be switched off on one line with a reason', () => {
    expect(
      lint(
        '// eslint-disable-next-line qarabic/design-tokens -- shadcn side keyed on data-[side]\nconst a = "data-[side=left]:left-0";',
      ),
    ).toEqual([]);
  });
});
