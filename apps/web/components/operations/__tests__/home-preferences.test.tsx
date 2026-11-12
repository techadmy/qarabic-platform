import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { HomeView } from '@/app/(app)/home-view';
import { PreferencesCard } from '@/components/operations/preferences-card';
import { NotificationBell } from '@/components/shell/notification-bell';
import { odb } from '@/mocks/operations-db';
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
});

describe('Bell', () => {
  it('shows task and announcement alerts with links to them', async () => {
    const user = userEvent.setup();
    renderPage(<NotificationBell />, { as: 'accounts@qarabic.test', path: '/' });
    await user.click(
      await screen.findAllByRole('button', { name: /الإشعارات|التنبيهات/ }).then((b) => b.at(-1)!),
    );
    expect(
      await screen.findByRole('link', { name: /أسند إليك مهمة: متابعة طلب إجازة/ }),
    ).toHaveAttribute('href', '/tasks/7');
    expect(screen.getByRole('link', { name: /إعلان جديد: إجازة نصف العام/ })).toHaveAttribute(
      'href',
      '/announcements',
    );
  });
});
