import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { HomeView } from '@/app/(app)/home-view';
import { PreferencesCard } from '@/components/operations/preferences-card';
import { NotificationBell } from '@/components/shell/notification-bell';
import { odb } from '@/mocks/operations-db';
import { http, HttpResponse } from 'msw';
import { MyClassesView } from '@/app/(app)/my-classes/my-classes-view';
import { server } from '@/mocks/node';
import { sdb } from '@/mocks/schedule-db';
import { renderPage } from '@/test/people';

describe('Staff home (dashboard)', () => {
  it('the admin sees the queues, today’s classes, people and money; tiles open their lists', async () => {
    renderPage(<HomeView />, { path: '/' });
    const queues = await screen.findByRole('region', { name: 'تحتاج إجراء' });
    expect(within(queues).getByRole('link', { name: /مهامي المفتوحة/ })).toHaveAttribute(
      'href',
      '/tasks',
    );
    expect(within(queues).getByRole('link', { name: /غرامات مقترحة/ })).toHaveAttribute(
      'href',
      '/fines',
    );
    const classes = screen.getByRole('region', { name: 'حصص اليوم' });
    expect(within(classes).getByRole('link', { name: /إجمالي الحصص/ })).toHaveTextContent('46');
    expect(screen.getByRole('region', { name: 'المالية' })).toBeInTheDocument();
    expect(screen.queryByText('لا توجد بيانات بعد')).toBeNull();
  });

  it('a monitor sees only the numbers of the lists they may open', async () => {
    renderPage(<HomeView />, { as: 'monitor@qarabic.test', path: '/' });
    const queues = await screen.findByRole('region', { name: 'تحتاج إجراء' });
    expect(within(queues).getByRole('link', { name: /مهامي المفتوحة/ })).toBeInTheDocument();
    expect(within(queues).queryByRole('link', { name: /شكاوى مفتوحة/ })).toBeNull();
  });
});

describe('Notification preferences', () => {
  it('turns email on for tasks and saves; WhatsApp stays off for the academy', async () => {
    const user = userEvent.setup();
    renderPage(<PreferencesCard />, { as: 'monitor@qarabic.test', path: '/account' });
    const email = await screen.findByRole('switch', { name: 'المهام · البريد الإلكتروني' });
    expect(email).not.toBeChecked();
    expect(screen.getByRole('switch', { name: 'المهام · واتساب' })).toBeDisabled();
    expect(screen.queryByRole('switch', { name: /العملاء المحتملون/ })).toBeNull();
    await user.click(email);
    await user.click(screen.getByRole('button', { name: 'حفظ التفضيلات' }));
    await waitFor(() => expect(odb.prefs.get(12)?.task?.email).toBe(true));
    expect(await screen.findByRole('switch', { name: 'المهام · البريد الإلكتروني' })).toBeChecked();
  });

  it('has a mobile push column: off with its note while the server has no push driver', async () => {
    const { unmount } = renderPage(<PreferencesCard />, {
      as: 'monitor@qarabic.test',
      path: '/account',
    });
    const push = await screen.findByRole('switch', { name: 'المهام · إشعارات تطبيق الجوال' });
    expect(push).toBeDisabled();
    expect(push).not.toBeChecked();
    expect(push).toHaveAccessibleDescription(
      'إشعارات تطبيق الجوال غير مفعّلة في الخادم بعد، وتعمل مع إطلاق التطبيق.',
    );
    unmount();

    // Once the server's push driver is on, the column works like the others (default on).
    server.use(
      http.get('*/api/v1/me/notification-preferences', () =>
        HttpResponse.json({
          data: [{ kind: 'task', inApp: true, email: false, push: true, whatsapp: false }],
          channels: { in_app: true, email: true, push: true, whatsapp: false },
        }),
      ),
    );
    renderPage(<PreferencesCard />, { as: 'monitor@qarabic.test', path: '/account' });
    const on = await screen.findByRole('switch', { name: 'المهام · إشعارات تطبيق الجوال' });
    expect(on).toBeEnabled();
    expect(on).toBeChecked();
    expect(screen.queryByText(/غير مفعّلة في الخادم/)).toBeNull();
  });
});

describe('Bell', () => {
  it('shows task and announcement alerts with links to them', async () => {
    const user = userEvent.setup();
    renderPage(<NotificationBell />, { as: 'accounts@qarabic.test', path: '/' });
    await user.click(
      await screen.findAllByRole('button', { name: /الإشعارات|التنبيهات/ }).then((b) => b.at(-1)!),
    );
    expect(
      await screen.findByRole('link', {
        name: /مهمة جديدة مسندة إليك من Rana Monitor: متابعة طلب إجازة/,
      }),
    ).toHaveAttribute('href', '/tasks/7');
    expect(screen.getByRole('link', { name: /إعلان جديد: إجازة نصف العام/ })).toHaveAttribute(
      'href',
      '/announcements#ann-3',
    );
  });
});

describe('Dashboard review fixes (#32)', () => {
  it('a failed background refresh keeps the numbers and says so quietly', async () => {
    const { queryClient } = renderPage(<HomeView />, { path: '/' });
    expect(await screen.findByRole('region', { name: 'تحتاج إجراء' })).toBeInTheDocument();
    server.use(
      http.get('*/api/v1/dashboard/summary', () => HttpResponse.json({}, { status: 500 })),
    );
    await queryClient.refetchQueries({ queryKey: ['operations', 'dashboard'] });
    expect(await screen.findByText(/تعذّر تحديث الأرقام/)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'تحتاج إجراء' })).toBeInTheDocument();
  });

  it('urgent tiles say so in words, not only in red', async () => {
    renderPage(<HomeView />, { path: '/' });
    const queues = await screen.findByRole('region', { name: 'تحتاج إجراء' });
    expect(within(queues).getByRole('link', { name: /شكاوى مفتوحة/ })).toHaveTextContent(
      'يحتاج انتباهًا',
    );
  });

  it('nothing to see: an empty state, not a bare header', async () => {
    server.use(
      http.get('*/api/v1/dashboard/summary', () =>
        HttpResponse.json({
          data: {
            generatedAt: new Date().toISOString(),
            today: '2026-11-12',
            people: null,
            classesToday: null,
            queues: {
              myTasks: null,
              myOverdueTasks: null,
              sessionRequests: null,
              leaveRequests: null,
              proposedFines: null,
              newLeads: null,
              trialsToday: null,
              openTickets: null,
              openComplaints: null,
              unreadAnnouncements: null,
            },
            finance: null,
          },
        }),
      ),
    );
    renderPage(<HomeView />, { path: '/' });
    expect(await screen.findByText('لا توجد أرقام لك هنا')).toBeInTheDocument();
  });
});

describe('Class reminder links', () => {
  it('?session= on «حصصي» opens that class in the sheet', async () => {
    const s = sdb.sessions.find((x) => x.teacherId === 1 && !x.deleted)!;
    renderPage(<MyClassesView />, {
      as: 'teacher@qarabic.test',
      path: `/my-classes?session=${s.id}`,
    });
    expect(await screen.findByRole('dialog', { name: 'تفاصيل الحصة' })).toBeInTheDocument();
  });
});
