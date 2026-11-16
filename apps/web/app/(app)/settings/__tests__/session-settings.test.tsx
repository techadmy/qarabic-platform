import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { HolidaysView } from '@/app/(app)/holidays/holidays-view';
import { SessionSettingsView } from '@/app/(app)/settings/sessions/session-settings-view';
import { server } from '@/mocks/node';
import { renderPage } from '@/test/people';

describe('Class settings', () => {
  it('validates each rule with SESSION_SETTING_RULES and sends only the changed keys', async () => {
    const user = userEvent.setup();
    let body: Record<string, unknown> | null = null;
    server.events.on('request:start', async ({ request }) => {
      if (request.method === 'PUT') body = await request.clone().json();
    });
    renderPage(<SessionSettingsView />, { path: '/settings/sessions' });
    const horizon = await screen.findByLabelText('تُنشأ الحصص مسبقًا لمدة');
    expect(horizon).toHaveValue(14);
    // Range and unit from the shared rule.
    expect(screen.getByText(/\(من 1 إلى 60 يوم\)/)).toBeInTheDocument();
    await user.clear(horizon);
    await user.type(horizon, '90');
    await user.click(screen.getByRole('button', { name: 'احفظ التغييرات' }));
    expect(await screen.findByText('أدخل رقمًا لا يزيد على 60')).toBeInTheDocument();
    expect(horizon).toHaveAttribute('aria-invalid', 'true');
    expect(body).toBeNull();
    await user.clear(horizon);
    await user.type(horizon, '21');
    await user.click(screen.getByRole('button', { name: 'احفظ التغييرات' }));
    expect(await screen.findByText('حُفظت الإعدادات')).toBeInTheDocument();
    expect(body).toEqual({ 'sessions.horizon_days': 21 });
    server.events.removeAllListeners();
  });

  it('switches whether parents see the class rating (reports.parent_sees_rating)', async () => {
    const user = userEvent.setup();
    let body: Record<string, unknown> | null = null;
    server.events.on('request:start', async ({ request }) => {
      if (request.method === 'PUT') body = await request.clone().json();
    });
    renderPage(<SessionSettingsView />, { path: '/settings/sessions' });
    const toggle = await screen.findByRole('switch', { name: 'يرى ولي الأمر تقييم الحصة' });
    expect(toggle).toBeChecked();
    await user.click(toggle);
    await user.click(screen.getByRole('button', { name: 'احفظ التغييرات' }));
    await waitFor(() => expect(body).toEqual({ 'reports.parent_sees_rating': false }));
    server.events.removeAllListeners();
  });

  it('shows no access without settings.view', async () => {
    renderPage(<SessionSettingsView />, {
      as: 'supervisor@qarabic.test',
      path: '/settings/sessions',
    });
    expect(await screen.findByText('ليست لديك صلاحية')).toBeInTheDocument();
  });

  // D151 (b): the Zoom account's licensed users, one per teacher (the mock account is off unless
  // a test turns it on).
  const zoomOn = () => window.localStorage.setItem('qarabic.mock.zoomOn', '1');
  afterEach(() => window.localStorage.removeItem('qarabic.mock.zoomOn'));
  it('lists the licensed Zoom users with their teacher; links a free one after choosing a teacher', async () => {
    const user = userEvent.setup();
    zoomOn();
    renderPage(<SessionSettingsView />, { path: '/settings/sessions' });
    await user.click(await screen.findByRole('tab', { name: 'حسابات Zoom' }));
    const table = await screen.findByRole('table', { name: 'حسابات Zoom' });
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(7));
    expect(within(table).getByText('zoom1@qarabic.test')).toBeInTheDocument();
    expect(within(table).getByText('غير مرخّص')).toBeInTheDocument();
    expect(screen.getByText(/^آخر مزامنة:/)).toBeInTheDocument();

    await user.click(within(table).getByRole('button', { name: 'ربط بمعلم: Qarabic Zoom 3' }));
    const dialog = await screen.findByRole('dialog', { name: 'ربط Qarabic Zoom 3 بمعلم' });
    await user.click(within(dialog).getByRole('button', { name: 'ربط بمعلم' }));
    expect(await within(dialog).findAllByText('اختر المعلم')).not.toHaveLength(0);
    await user.click(within(dialog).getByRole('combobox', { name: 'المعلم' }));
    await user.click(await screen.findByRole('option', { name: /^معلم تجريبي/ }));
    expect(within(dialog).getByText(/مرتبط الآن بـ Qarabic Zoom 1/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'ربط بمعلم' }));
    expect(await screen.findByText('رُبط الحساب بالمعلم.')).toBeInTheDocument();
    const row = within(table).getByText('zoom3@qarabic.test').closest('tr')!;
    expect(within(row).getByRole('link', { name: 'معلم تجريبي' })).toBeInTheDocument();
    // Teacher 1 moved: their old user is free again.
    const old = within(table).getByText('zoom1@qarabic.test').closest('tr')!;
    expect(within(old).getByText('غير مرتبط')).toBeInTheDocument();
  });

  it('unlinks after a confirmation, and syncs on «مزامنة الآن»', async () => {
    const user = userEvent.setup();
    zoomOn();
    renderPage(<SessionSettingsView />, { path: '/settings/sessions' });
    await user.click(await screen.findByRole('tab', { name: 'حسابات Zoom' }));
    const table = await screen.findByRole('table', { name: 'حسابات Zoom' });
    await user.click(
      await within(table).findByRole('button', { name: 'إلغاء الربط: Qarabic Zoom 2' }),
    );
    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText(/سيُحذف رابط Zoom من ملف المعلم/)).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: 'إلغاء الربط' }));
    expect(await screen.findByText('أُلغي ربط الحساب.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'مزامنة الآن' }));
    expect(await screen.findByText(/^تمت المزامنة:/)).toBeInTheDocument();
  });

  it('says it works once Zoom is connected when the account is off', async () => {
    const user = userEvent.setup();
    renderPage(<SessionSettingsView />, { path: '/settings/sessions' });
    await user.click(await screen.findByRole('tab', { name: 'حسابات Zoom' }));
    expect(await screen.findByText('يُفعَّل بعد ربط حساب Zoom')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'مزامنة الآن' })).not.toBeInTheDocument();
  });
});

describe('Public holidays', () => {
  it('adds a holiday with a name and a range', async () => {
    const user = userEvent.setup();
    renderPage(<HolidaysView />, { path: '/holidays' });
    const table = await screen.findByRole('table', { name: 'العطلات الرسمية' });
    await waitFor(() => expect(within(table).getAllByRole('row').length).toBeGreaterThan(1));
    await user.click(screen.getByRole('button', { name: 'أضف عطلة' }));
    const dialog = await screen.findByRole('dialog', { name: 'عطلة رسمية جديدة' });
    await user.click(within(dialog).getByRole('button', { name: 'أضف عطلة' }));
    expect(await within(dialog).findByText('اكتب اسم العطلة')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/اسم العطلة/), 'يوم التأسيس');
    await user.click(within(dialog).getByRole('button', { name: 'أضف عطلة' }));
    expect(await screen.findByText('أُضيفت العطلة')).toBeInTheDocument();
    expect(await within(table).findByText('يوم التأسيس')).toBeInTheDocument();
  });
});
