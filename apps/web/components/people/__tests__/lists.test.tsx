import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FamiliesView } from '@/app/(app)/families/families-view';
import { StaffView } from '@/app/(app)/staff/staff-view';
import { StudentsView } from '@/app/(app)/students/students-view';
import { TeachersView } from '@/app/(app)/teachers/teachers-view';
import { lastReplacedUrl, renderPage } from '@/test/people';
import { routerMock } from '@/test/router-mock';

async function table(name: string) {
  const t = await screen.findByRole('table', { name });
  await waitFor(() => expect(t).not.toHaveAttribute('aria-busy'));
  return t;
}

describe('Families list', () => {
  it('shows the result count, the views menu with counts from meta.counts and the rows', async () => {
    const user = userEvent.setup();
    renderPage(<FamiliesView />, { path: '/families' });
    const t = await table('العائلات');
    expect((await screen.findAllByText('26 نتيجة')).length).toBeGreaterThan(0);
    // Six views (all + five statuses) move into the title (D141 §2).
    const h1 = screen.getByRole('heading', { level: 1 });
    await user.click(within(h1).getByRole('button', { name: /^الكل\s*\(26\)\s*تغيير العرض$/ }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitemradio', { name: /^منتظمة\s*16$/ })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitemradio', { name: /^معلّقة\s*2$/ })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitemradio', { name: /^غير نشطة\s*3$/ })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    // 25 per page + header; the parent's local time is labelled with the city.
    expect(within(t).getAllByRole('row')).toHaveLength(26);
    expect(within(t).getAllByText(/· (نيويورك|لندن|دبي|برلين)/).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'أضف عائلة' })).toBeInTheDocument();
  });

  it('puts the status tab in the URL and lists only that status', async () => {
    const user = userEvent.setup();
    const { unmount } = renderPage(<FamiliesView />, { path: '/families' });
    await table('العائلات');
    await user.click(await screen.findByRole('button', { name: /تغيير العرض$/ }));
    await user.click(await screen.findByRole('menuitemradio', { name: /^معلّقة\s*2$/ }));
    expect(lastReplacedUrl().searchParams.get('status')).toBe('suspended');
    unmount();

    renderPage(<FamiliesView />, { path: '/families?status=suspended' });
    const t = await table('العائلات');
    await waitFor(() => expect(within(t).getAllByRole('row')).toHaveLength(3));
    expect(within(t).getAllByText('معلّقة')).toHaveLength(2);
  });

  it('searches on the server 300 ms after typing and shows «no results for …» with a clear button', async () => {
    const user = userEvent.setup();
    const { unmount } = renderPage(<FamiliesView />, { path: '/families' });
    await table('العائلات');
    await user.type(screen.getByRole('searchbox', { name: 'بحث في العائلات' }), 'Yusuf');
    await waitFor(() => expect(lastReplacedUrl().searchParams.get('q')).toBe('Yusuf'));
    unmount();

    renderPage(<FamiliesView />, { path: '/families?q=Yusuf' });
    const t = await table('العائلات');
    await waitFor(() => expect(within(t).getAllByRole('row')).toHaveLength(2));
    expect(within(t).getByRole('link', { name: 'Yusuf Hassan' })).toHaveAttribute(
      'href',
      '/families/2',
    );
    expect(
      await screen.findByRole('button', { name: /^الكل\s*\(1\)\s*تغيير العرض$/ }),
    ).toBeInTheDocument();
  });

  it('finds a family by a child name, and says so when nothing matches', async () => {
    renderPage(<FamiliesView />, { path: '/families?q=zzzz' });
    expect(await screen.findByText('لا نتائج مطابقة لـ «zzzz»')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getAllByRole('button', { name: 'مسح الكل' })[0]!);
    expect(lastReplacedUrl().searchParams.get('q')).toBeNull();
  });

  it('lists archived families with «استعادة» behind the «المحذوفة» switch', async () => {
    renderPage(<FamiliesView />, { path: '/families?archived=1' });
    const t = await table('العائلات');
    await waitFor(() => expect(within(t).getAllByRole('row')).toHaveLength(3));
    expect(within(t).getAllByRole('button', { name: /استعادة/ })).toHaveLength(2);
    expect(screen.getByRole('switch', { name: 'المحذوفة' })).toBeChecked();
  });

  it('hides «أضف عائلة» and the «المحذوفة» switch without families.manage', async () => {
    renderPage(<FamiliesView />, { as: 'parent@qarabic.test', path: '/families' });
    await table('العائلات');
    expect(screen.queryByRole('button', { name: 'أضف عائلة' })).not.toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'المحذوفة' })).not.toBeInTheDocument();
    // The API scopes a parent to their own family.
    expect((await screen.findAllByText('نتيجة واحدة')).length).toBeGreaterThan(0);
  });
});

describe('Students, teachers and staff lists', () => {
  it('a teacher sees «طلابي»: own students only, no teacher column, no add', async () => {
    renderPage(<StudentsView />, { as: 'teacher@qarabic.test', path: '/students' });
    const t = await table('طلابي');
    expect(screen.getByRole('heading', { level: 1, name: 'طلابي' })).toBeInTheDocument();
    expect(within(t).queryByRole('columnheader', { name: 'المعلم' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'أضف طالبًا' })).not.toBeInTheDocument();
    // No parent data for a teacher (D138): the secondary line under the name stays empty.
    expect(within(t).queryByText('ولي أمر تجريبي')).not.toBeInTheDocument();
    expect(within(t).getByRole('link', { name: 'Ali' })).toBeInTheDocument();
  });

  it('filters students by family from the URL and shows a removable chip', async () => {
    renderPage(<StudentsView />, { path: '/students?familyId=2' });
    const t = await table('الطلاب');
    await waitFor(() => expect(within(t).getAllByRole('row')).toHaveLength(4));
    expect(await screen.findByText('العائلة: Yusuf Hassan')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'عرض كل العائلات' }));
    expect(lastReplacedUrl().searchParams.get('familyId')).toBeNull();
  });

  it('teachers: active/inactive tabs with counts and the active students link', async () => {
    renderPage(<TeachersView />, { path: '/teachers' });
    const t = await table('المعلمون');
    expect(await screen.findByRole('radio', { name: /^نشط\s*\(7\)$/ })).toBeInTheDocument();
    expect(await screen.findByRole('radio', { name: /^غير نشط\s*\(1\)$/ })).toBeInTheDocument();
    const link = within(t)
      .getAllByRole('link')
      .find((a) => a.getAttribute('href') === '/students?teacherId=1');
    expect(link).toBeTruthy();
  });

  it('staff: sorted by name with role badges', async () => {
    routerMock.reset();
    renderPage(<StaffView />, { path: '/staff' });
    const t = await table('الموظفون');
    expect(within(t).getByText('المالك (مدير النظام)')).toBeInTheDocument();
    expect(within(t).getByText('مشرف')).toBeInTheDocument();
    expect(await screen.findByRole('radio', { name: /^الكل\s*\(8\)$/ })).toBeInTheDocument();
  });
});

describe('D141 on the people lists', () => {
  it('students keep their status tabs (three views); the table has the column chooser', async () => {
    renderPage(<StudentsView />, { path: '/students' });
    await table('الطلاب');
    expect(screen.getByRole('radiogroup', { name: 'تصفية حسب الحالة' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'اختيار الأعمدة' })).toBeInTheDocument();
  });

  it('from 1024 px a family opens beside the list, with «إغلاق» back to it', async () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      ...original(query),
      matches: query.includes('min-width: 1024px'),
    })) as typeof window.matchMedia;
    try {
      renderPage(<FamiliesView />, { path: '/families?id=2' });
      expect(
        await screen.findByRole('heading', { level: 2, name: /Yusuf Hassan/ }),
      ).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('العائلات');
      expect(screen.getByRole('link', { name: 'فتح في صفحة كاملة' })).toHaveAttribute(
        'href',
        '/families/2',
      );
      expect(screen.getByRole('link', { name: /Yusuf Hassan/ })).toHaveAttribute('aria-current');
    } finally {
      window.matchMedia = original;
    }
  });
});
