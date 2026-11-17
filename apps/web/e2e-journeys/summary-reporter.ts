import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import type {
  FullResult,
  Reporter,
  TestCase,
  TestResult,
  TestStep,
} from '@playwright/test/reporter';

/**
 * Writes `journeys-summary.json`: one entry per journey (its tag, e.g. `@J1`) with every top-level
 * `test.step` as a numbered step — status, duration, the first error line and its screenshot
 * (attachment `step-<n>`, or Playwright's failure screenshot). The QA dashboard and the GitHub job
 * summary read this file; it holds no personal data (QA personas only) and no secrets.
 */
export interface JourneySummary {
  schema: 1;
  generatedAt: string;
  status: 'passed' | 'failed';
  durationMs: number;
  commit: string | null;
  branch: string | null;
  event: string | null;
  runUrl: string | null;
  journeys: Array<{
    id: string;
    title: string;
    status: 'passed' | 'failed' | 'skipped';
    durationMs: number;
    error: string | null;
    steps: Array<{
      n: number;
      title: string;
      status: 'passed' | 'failed' | 'not_run';
      durationMs: number;
      error: string | null;
      screenshot: string | null;
    }>;
  }>;
}

const firstLine = (message?: string) =>
  message
    ?.replace(/\u001b\[[0-9;]*m/g, '')
    .split('\n')
    .find((l) => l.trim()) ?? null;

export default class SummaryReporter implements Reporter {
  private readonly outputFile: string;
  private readonly tests: Array<{ test: TestCase; result: TestResult }> = [];
  private readonly started = Date.now();

  constructor(options: { outputFile?: string } = {}) {
    this.outputFile = resolve(options.outputFile ?? 'journeys-summary.json');
  }

  onTestEnd(test: TestCase, result: TestResult) {
    this.tests.push({ test, result });
  }

  onEnd(result: FullResult) {
    const env = process.env;
    const runUrl =
      env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
        ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
        : null;
    const base = dirname(this.outputFile);
    const summary: JourneySummary = {
      schema: 1,
      generatedAt: new Date().toISOString(),
      status: result.status === 'passed' ? 'passed' : 'failed',
      durationMs: Date.now() - this.started,
      commit: env.GITHUB_SHA ?? null,
      branch: env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || null,
      event: env.GITHUB_EVENT_NAME ?? null,
      runUrl,
      journeys: this.tests.map(({ test, result: r }) => {
        const shotOf = (n: number) => {
          const a =
            r.attachments.find((x) => x.name === `step-${n}` && x.path) ??
            (r.status === 'passed'
              ? undefined
              : r.attachments.find((x) => x.name === 'screenshot' && x.path));
          return a?.path ? relative(base, a.path) : null;
        };
        const top = r.steps.filter((s: TestStep) => s.category === 'test.step');
        type Step = JourneySummary['journeys'][number]['steps'][number];
        const steps: Step[] = top.map((s, i) => {
          const n = Number(s.title.match(/^(\d+)\./)?.[1] ?? i + 1);
          return {
            n,
            title: s.title.replace(/^\d+\.\s*/, ''),
            status: s.error ? 'failed' : 'passed',
            durationMs: Math.round(s.duration),
            error: firstLine(s.error?.message),
            screenshot: s.error ? (shotOf(n) ?? shotOf(-1)) : shotOf(n),
          };
        });
        // Steps the run never reached (declared in the test's `steps` annotation).
        const planned = test.annotations
          .filter((a) => a.type === 'step')
          .map((a) => a.description!);
        for (const [i, title] of planned.entries()) {
          if (!steps.some((s) => s.n === i + 1)) {
            steps.push({
              n: i + 1,
              title,
              status: 'not_run',
              durationMs: 0,
              error: null,
              screenshot: null,
            });
          }
        }
        steps.sort((a, b) => a.n - b.n);
        return {
          id: test.tags[0]?.replace(/^@/, '') ?? test.title,
          title: test.title,
          status: r.status === 'passed' ? 'passed' : r.status === 'skipped' ? 'skipped' : 'failed',
          durationMs: Math.round(r.duration),
          error: firstLine(r.error?.message),
          steps,
        };
      }),
    };
    mkdirSync(base, { recursive: true });
    writeFileSync(this.outputFile, `${JSON.stringify(summary, null, 2)}\n`);
  }
}
