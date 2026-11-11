import { overallScore, tajweedScore } from '@qarabic/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { TestDetailView } from '@/app/(app)/tests/[id]/test-detail-view';
import { TestsView } from '@/app/(app)/tests/tests-view';
import { tdb } from '@/mocks/teaching-db';
import { lastReplacedUrl, renderPage } from '@/test/people';

/** The demo teacher's test that can be recorded now (scheduled in 10 minutes, hifz). */
const recordable = () => tdb.tests.find((t) => t.status === 'scheduled' && t.teacherId === 1)!;

describe('Tests list', () => {
  it('shows the month tiles and status tabs with counts; a tile filters', async () => {
    const user = userEvent.setup();
    renderPage(<TestsView />, { path: '/tests' });
    const tiles = await screen.findByRole('navigation', { name: 'عدادات الشهر' });
    await waitFor(() =>
      expect(
        within(tiles)
          .getAllByRole('button')
          .map((b) => b.textContent),
      ).toEqual([
        expect.stringMatching(/^\d+المُنشأة$/),
        expect.stringMatching(/^\d+المنجزة$/),
        expect.stringMatching(/^\d+المتبقية$/),
        expect.stringMatching(/^\d+المرفوضة$/),
      ]),
    );
    const tabs = screen.getByRole('radiogroup', { name: 'تصفية حسب الحالة' });
    await waitFor(() =>
      expect(within(tabs).getByRole('radio', { name: /^الكل\s*\(\d+\)$/ })).toBeChecked(),
    );
    expect(within(tabs).getByRole('radio', { name: 'حسب المعلم' })).toBeInTheDocument();
    await user.click(within(tiles).getByRole('button', { name: /المتبقية$/ }));
    expect(lastReplacedUrl().searchParams.get('tab')).toBe('scheduled');
  });

  it('opens a teacher on their scheduled tests, without the per-teacher tab', async () => {
    renderPage(<TestsView />, { as: 'teacher@qarabic.test', path: '/tests' });
    const tabs = await screen.findByRole('radiogroup', { name: 'تصفية حسب الحالة' });
    expect(within(tabs).getByRole('radio', { name: /^مجدول/ })).toBeChecked();
    expect(within(tabs).queryByRole('radio', { name: 'حسب المعلم' })).not.toBeInTheDocument();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'الاختبارات' }),
    ).toBeInTheDocument();
  });
});

describe('Record a test result', () => {
  it('scores live from the ticked mistakes (D115) and needs every score of the track', async () => {
    const user = userEvent.setup();
    const test = recordable();
    renderPage(<TestDetailView id={test.id} />, { path: `/tests/${test.id}` });
    const form = (await screen.findByText('تسجيل النتيجة')).closest(
      '[data-slot="card"]',
    ) as HTMLElement;
    const live = within(form).getByText(/^التجويد:/).parentElement!;
    expect(live).toHaveTextContent('التجويد: 100%');

    await user.click(within(form).getByLabelText('نطق الحروف غير سليم'));
    await user.click(within(form).getByLabelText('لا يمد حروف المد'));
    const tajweed = tajweedScore(test.sections, [1, 22]);
    expect(live).toHaveTextContent(`التجويد: ${tajweed}%`);

    // Hifz track: reading and memorisation are both required.
    await user.click(within(form).getByRole('button', { name: 'حفظ النتيجة' }));
    expect(within(form).getAllByText('اختر الدرجة')).toHaveLength(2);
    const reading = within(form).getByRole('radiogroup', { name: /^التلاوة/ });
    const hifz = within(form).getByRole('radiogroup', { name: /^الحفظ/ });
    await user.click(within(reading).getByRole('radio', { name: '75%' }));
    await user.click(within(hifz).getByRole('radio', { name: '100%' }));
    expect(live).toHaveTextContent(`الدرجة الكلية: ${overallScore('hifz', tajweed, 75, 100)}%`);
    await user.click(within(form).getByRole('button', { name: 'حفظ النتيجة' }));

    expect(await screen.findByText('حُفظت النتيجة')).toBeInTheDocument();
    await waitFor(() => expect(tdb.tests.find((t) => t.id === test.id)!.status).toBe('taken'));
    expect(tdb.tests.find((t) => t.id === test.id)!.result).toMatchObject({
      mistakes: [1, 22],
      reading: 75,
      hifz: 100,
      tajweed,
    });
    // The read-only result names the mistakes in words.
    expect(await screen.findByText('لا يمد حروف المد')).toBeInTheDocument();
  });

  it('refuses a test only with a reason (confirm dialog)', async () => {
    const user = userEvent.setup();
    const test = recordable();
    renderPage(<TestDetailView id={test.id} />, { path: `/tests/${test.id}` });
    await user.click(await screen.findByRole('button', { name: 'تسجيل رفض أو غياب' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'تسجيل رفض أو غياب' }));
    expect(within(dialog).getByText('هذا الحقل مطلوب')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/السبب/), 'ab');
    await user.click(within(dialog).getByRole('button', { name: 'تسجيل رفض أو غياب' }));
    expect(within(dialog).getByText('اكتب 3 أحرف على الأقل')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/السبب/), 'sent');
    await user.click(within(dialog).getByRole('button', { name: 'تسجيل رفض أو غياب' }));
    expect(await screen.findByText('سُجّل الرفض أو الغياب')).toBeInTheDocument();
    expect(tdb.tests.find((t) => t.id === test.id)).toMatchObject({
      status: 'refused',
      statusReason: 'absent',
    });
  });

  it('a staff correction of a recorded result needs a reason', async () => {
    const user = userEvent.setup();
    const test = tdb.tests.find((t) => t.status === 'taken' && t.track === 'hifz')!;
    renderPage(<TestDetailView id={test.id} />, { path: `/tests/${test.id}` });
    await user.click(await screen.findByRole('button', { name: 'تصحيح النتيجة' }));
    await user.click(screen.getByRole('button', { name: 'حفظ التصحيح' }));
    expect(screen.getByText('اكتب سبب التصحيح (3 أحرف على الأقل)')).toBeInTheDocument();
    await user.type(screen.getByLabelText(/سبب التصحيح/), 'Wrong mistake ticked');
    await user.click(screen.getByRole('button', { name: 'حفظ التصحيح' }));
    expect(await screen.findByText('حُفظ تصحيح النتيجة')).toBeInTheDocument();
  });
});
