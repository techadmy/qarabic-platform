import type { SessionDto } from '@qarabic/shared';
import { screen, within } from '@testing-library/react';
import { http, HttpResponse, delay } from 'msw';
import { describe, expect, it } from 'vitest';
import { HomeView } from '@/app/(app)/home-view';
import { TeacherHomeView } from '@/components/portal/teacher-home';
import { pickHeroClass, upcomingDays } from '@/lib/sessions/teacher-home';
import { JoinClassButton, ParentHomeView } from '@/components/support/parent-home-view';
import { RowActions } from '@/components/sessions/row-actions';
import { renderPage } from '@/test/people';
import { server } from '@/mocks/node';

const TEACHER = 'teacher@qarabic.test';
const PARENT = 'parent@qarabic.test';

const at = (min: number) => new Date(Date.UTC(2026, 10, 12, 10, min)).toISOString();
const cls = (id: number, stage: string, start: number, end = start + 30) =>
  ({ id, stage, startsAt: at(start), endsAt: at(end) }) as unknown as SessionDto;
const NOW = new Date(Date.UTC(2026, 10, 12, 10, 20));

describe('«يومي»: which class goes on top', () => {
  it('a running class wins over an earlier scheduled one', () => {
    const days = [
      { date: '2026-11-12', sessions: [cls(1, 'scheduled', 25), cls(2, 'in_progress', 0)] },
    ];
    expect(pickHeroClass(days, NOW)?.id).toBe(2);
  });

  it('else the next scheduled class not yet over; ended and marked ones never', () => {
    const days = [
      {
        date: '2026-11-12',
        sessions: [cls(1, 'ended', 0), cls(2, 'absent', 5), cls(3, 'scheduled', -40)],
      },
      { date: '2026-11-13', sessions: [cls(5, 'scheduled', 60 * 24 + 30)] },
      { date: '2026-11-12', sessions: [cls(4, 'scheduled', 40)] },
    ];
    expect(pickHeroClass(days, NOW)?.id).toBe(4);
  });

  it('nothing ahead: no hero', () => {
    expect(pickHeroClass([{ date: '2026-11-12', sessions: [cls(1, 'taken', 0)] }], NOW)).toBeNull();
  });

  it('the next five days after today, across the week boundary, in order', () => {
    const days = [
      '2026-11-13',
      '2026-11-12',
      '2026-11-11',
      '2026-11-14',
      '2026-11-15',
      '2026-11-16',
      '2026-11-17',
      '2026-11-18',
    ].map((date) => ({ date, sessions: [] }));
    expect(upcomingDays(days, '2026-11-12').map((d) => d.date)).toEqual([
      '2026-11-13',
      '2026-11-14',
      '2026-11-15',
      '2026-11-16',
      '2026-11-17',
    ]);
  });
});

describe('Teacher home «يومي»', () => {
  it('the home route gives a teacher «يومي», not the placeholder', async () => {
    renderPage(<HomeView />, { as: TEACHER, path: '/' });
    expect(await screen.findByRole('heading', { level: 1, name: /مرحبًا/ })).toBeInTheDocument();
    expect(
      await screen.findByRole('heading', { name: 'الأيام الخمسة القادمة' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('لا توجد بيانات بعد')).toBeNull();
  });

  it('shows the next class with its start button, both times, reports due and check-in', async () => {
    renderPage(<TeacherHomeView />, { as: TEACHER, path: '/' });
    const hero = await screen.findByRole('region', { name: /الحصة التالية|الحصة الجارية الآن/ });
    expect(within(hero).getByRole('link')).toHaveAttribute(
      'href',
      expect.stringMatching(/^\/students\/\d+$/),
    );
    expect(within(hero).getByText(/الطالب/)).toBeInTheDocument();
    expect(within(hero).getByRole('button', { name: 'تفاصيل الحصة' })).toBeInTheDocument();
    expect(within(hero).getByRole('button', { name: /ابدأ الحصة|أنهِ الحصة/ })).toBeInTheDocument();
    expect(within(hero).getByText(/· (\d+ دقيقة|دقيقتان|\d+ دقائق)$/)).toBeInTheDocument();
    // The alert and the «بلا تقرير» fact show the same number (the API's week summary).
    const fact = screen.getByText('بلا تقرير').parentElement!.querySelector('dd')!.textContent!;
    const alert = await screen.findByText(/تنتظر تقريرك|تنتظران تقريرك/);
    expect(Number(fact)).toBeGreaterThan(0);
    // Arabic spells out one and two («حصة واحدة», «حصتان»); from three the digits are in the text.
    const n = Number(fact);
    const words: Record<number, RegExp> = { 1: /حصة واحدة/, 2: /حصتان/ };
    expect(alert.textContent).toMatch(words[n] ?? new RegExp(`${n} `));
    expect(await screen.findByRole('button', { name: 'تسجيل الحضور' })).toBeInTheDocument();
    const upcoming = screen.getByRole('region', { name: 'الأيام الخمسة القادمة' });
    expect(await within(upcoming).findAllByRole('heading', { level: 3 })).toHaveLength(5);
  });
});

describe('Parent home additions (M9)', () => {
  it('each child links to their lessons and progress', async () => {
    renderPage(<ParentHomeView />, { as: PARENT, path: '/' });
    const links = await screen.findAllByRole('link', { name: /وتقدّمه$/ });
    expect(links.length).toBeGreaterThan(0);
    for (const link of links)
      expect(link).toHaveAttribute('href', expect.stringMatching(/^\/students\/\d+$/));
  });

  it('«ادخل الحصة» shows only inside the join window', async () => {
    const open = {
      ...cls(1, 'scheduled', 30),
      student: { id: 1, name: 'Omar' },
      zoom: { status: 'ready', joinAvailable: true },
    } as unknown as SessionDto;
    const { unmount } = renderPage(<JoinClassButton session={open} />, { as: PARENT, path: '/' });
    expect(await screen.findByRole('button', { name: 'ادخل الحصة: Omar' })).toBeInTheDocument();
    unmount();
    renderPage(
      <>
        <JoinClassButton session={{ ...open, zoom: { status: 'ready', joinAvailable: false } }} />
        <p>ready</p>
      </>,
      { as: PARENT, path: '/' },
    );
    await screen.findByText('ready');
    expect(screen.queryByRole('button', { name: /ادخل الحصة/ })).toBeNull();
  });
});

describe('M9 part 2', () => {
  it('the parent home shows what is due, with «ادفع الآن» to that invoice', async () => {
    renderPage(<ParentHomeView />, { as: PARENT, path: '/' });
    const due = await screen.findByRole('region', { name: 'المستحق عليكم' });
    const pay = await within(due).findAllByRole('link', { name: /^ادفع الآن/ });
    expect(pay.length).toBeGreaterThan(0);
    expect(pay[0]).toHaveAttribute('href', expect.stringMatching(/^\/invoices\/\d+\?pay=1$/));
    expect(within(due).getByRole('link', { name: /^فواتيري/ })).toHaveAttribute(
      'href',
      '/invoices',
    );
  });

  it('a parent joins a class from the class list with a labelled button, not «تابع الحصة»', async () => {
    const s = {
      ...cls(1, 'scheduled', 30),
      allowedActions: [],
      student: { id: 1, name: 'Omar', timezone: 'America/New_York' },
      teacher: { id: 1, name: 'Ahmed', timezone: 'Africa/Cairo', phone: null },
      course: { id: 1, nameAr: 'تلاوة', nameEn: 'Recitation' },
      zoom: { status: 'ready', joinAvailable: true },
      pendingRequests: [],
      attention: [],
    } as unknown as SessionDto;
    renderPage(<RowActions session={s} />, { as: PARENT, path: '/my-classes' });
    const join = await screen.findByRole('button', { name: 'ادخل الحصة: Omar' });
    // 44 px on a parent's phone (docs/15 §5.15).
    expect(join).toHaveClass('h-11');
    expect(screen.queryByRole('button', { name: /تابع الحصة/ })).toBeNull();
  });

  it('the due card holds its place while loading and offers a retry when the load fails', async () => {
    server.use(
      http.get('*/api/v1/invoices', async () => {
        await delay('infinite');
        return HttpResponse.json({});
      }),
    );
    const { unmount } = renderPage(<ParentHomeView />, { as: PARENT, path: '/' });
    const busy = await screen.findByRole('region', { name: 'المستحق عليكم' });
    expect(busy).toHaveAttribute('aria-busy', 'true');
    unmount();

    server.use(http.get('*/api/v1/invoices', () => HttpResponse.json({}, { status: 500 })));
    renderPage(<ParentHomeView />, { as: PARENT, path: '/' });
    const due = await screen.findByRole('region', { name: 'المستحق عليكم' });
    expect(await within(due).findByRole('alert')).toHaveTextContent('تعذّر تحميل المستحق عليكم.');
    expect(within(due).getByRole('button', { name: 'حاول مرة أخرى' })).toBeInTheDocument();
  });
});
