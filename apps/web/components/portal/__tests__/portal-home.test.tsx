import type { SessionDto } from '@qarabic/shared';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { HomeView } from '@/app/(app)/home-view';
import { pickHeroClass, TeacherHomeView, upcomingDays } from '@/components/portal/teacher-home';
import { JoinClassButton, ParentHomeView } from '@/components/support/parent-home-view';
import { renderPage } from '@/test/people';

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
    expect(await screen.findByText(/تنتظر تقريرك|تنتظران تقريرك/)).toBeInTheDocument();
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
