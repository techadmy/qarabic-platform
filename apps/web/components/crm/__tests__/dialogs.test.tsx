import type { LeadDetailDto } from '@qarabic/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { ConvertDialog } from '@/components/crm/convert-dialog';
import { LeadWorkbench } from '@/components/crm/lead-workbench';
import { crmdb } from '@/mocks/crm-db';
import { presentDetail } from '@/mocks/crm-handlers';
import { MOCK_USERS } from '@/mocks/data';
import { server } from '@/mocks/node';
import { renderPage } from '@/test/people';

const TRIAL_SCHEDULED = 6; // Khadija Noor, trial with Aisha
const TRIAL_DONE = 7; // Yasmin Farouk, trial done with Musa

/** The JSON bodies POSTed to a path ending with `suffix` (a handler wrapper, so nothing leaks). */
function capture(suffix: string) {
  const bodies: Record<string, unknown>[] = [];
  server.use(
    http.post(`*/api/v1/leads/:id/${suffix}`, async ({ request }) => {
      bodies.push((await request.clone().json()) as Record<string, unknown>);
      return undefined;
    }),
  );
  return bodies;
}

async function openOutcome(user: ReturnType<typeof userEvent.setup>) {
  renderPage(<LeadWorkbench id={TRIAL_SCHEDULED} />, { path: `/leads/${TRIAL_SCHEDULED}` });
  await user.click(await screen.findByRole('button', { name: 'سجّل نتيجة التجريبية' }));
  return screen.findByRole('dialog', { name: 'نتيجة الحصة التجريبية' });
}

describe('Trial outcome dialog', () => {
  it('needs an outcome', async () => {
    const user = userEvent.setup();
    const sent = capture('trial-outcome');
    const dialog = await openOutcome(user);
    expect(within(dialog).getByText(/^Aisha — حالة الحصة:/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'سجّل النتيجة' }));
    expect(await within(dialog).findByText('اختر النتيجة.')).toBeInTheDocument();
    expect(sent).toHaveLength(0);
  });

  it('«غير مهتم» asks for the lost reason and sends it; the lead becomes lost', async () => {
    const user = userEvent.setup();
    const sent = capture('trial-outcome');
    const dialog = await openOutcome(user);
    expect(within(dialog).queryByRole('combobox', { name: 'السبب' })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('radio', { name: 'غير مهتم' }));
    const reason = within(dialog).getByRole('combobox', { name: 'السبب' });
    // Pre-set to «غير مهتم» so a reason is always sent; the agent can pick a closer one.
    expect(reason).toHaveTextContent('غير مهتم');
    await user.click(reason);
    await user.click(await screen.findByRole('option', { name: 'المواعيد غير مناسبة' }));
    await user.type(within(dialog).getByLabelText(/ملاحظة/), 'Evenings only.');
    await user.click(within(dialog).getByRole('button', { name: 'سجّل النتيجة' }));
    expect((await screen.findAllByText('سُجّلت النتيجة.'))[0]).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'نتيجة الحصة التجريبية' })).toBeNull(),
    );
    expect(sent[0]).toEqual({
      outcome: 'not_interested',
      lostReason: 'schedule',
      note: 'Evenings only.',
    });
    expect(crmdb.leads.find((l) => l.id === TRIAL_SCHEDULED)).toMatchObject({
      status: 'lost',
      lostReason: 'schedule',
    });
  });

  it('«مهتم بالاشتراك» sends no reason and moves the lead to «حضر التجريبية»', async () => {
    const user = userEvent.setup();
    const sent = capture('trial-outcome');
    const dialog = await openOutcome(user);
    await user.click(within(dialog).getByRole('radio', { name: 'مهتم بالاشتراك' }));
    expect(within(dialog).queryByRole('combobox', { name: 'السبب' })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'سجّل النتيجة' }));
    expect((await screen.findAllByText('سُجّلت النتيجة.'))[0]).toBeInTheDocument();
    expect(sent[0]).toMatchObject({ outcome: 'interested', lostReason: null });
    // The workbench moves on to the next stage.
    expect(await screen.findByRole('button', { name: 'حوّل إلى منتظم' })).toBeInTheDocument();
  });
});

describe('Convert dialog', () => {
  const admin = () => MOCK_USERS.find((u) => u.email === 'admin@qarabic.test')!;
  const detail = (id: number): LeadDetailDto =>
    presentDetail(
      crmdb.leads.find((l) => l.id === id)!,
      admin(),
    );

  function renderConvert(lead: LeadDetailDto) {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    renderPage(<ConvertDialog lead={lead} onClose={onClose} onSaved={onSaved} />, {
      path: `/leads/${lead.id}`,
    });
    return { onSaved, onClose };
  }

  it('prefills the course and teacher from the trial and asks for a weekly time', async () => {
    const user = userEvent.setup();
    const sent = capture('convert');
    renderConvert(detail(TRIAL_DONE));
    const dialog = await screen.findByRole('dialog', { name: 'التحويل إلى منتظم' });
    expect(within(dialog).getByRole('checkbox', { name: 'Musa' })).toBeChecked();
    await user.click(within(dialog).getByRole('button', { name: 'حوّل إلى منتظم' }));
    expect(
      await within(dialog).findByText(
        'أكمل بيانات كل طالب: الدورة والمعلم وموعدًا أسبوعيًا واحدًا على الأقل.',
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('combobox', { name: 'يوم الموعد 1' })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(within(dialog).getByRole('combobox', { name: 'الدورة' })).toHaveAttribute(
      'aria-invalid',
      'false',
    );
    expect(sent).toHaveLength(0);
  });

  it('marks a missing course and teacher when the lead had no trial', async () => {
    const user = userEvent.setup();
    const lead = detail(TRIAL_DONE);
    const bare: LeadDetailDto = {
      ...lead,
      trials: [],
      students: lead.students.map((s) => ({ ...s, courseId: null })),
    };
    renderConvert(bare);
    const dialog = await screen.findByRole('dialog', { name: 'التحويل إلى منتظم' });
    await user.click(within(dialog).getByRole('button', { name: 'حوّل إلى منتظم' }));
    expect(
      await within(dialog).findByText(
        'أكمل بيانات كل طالب: الدورة والمعلم وموعدًا أسبوعيًا واحدًا على الأقل.',
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('combobox', { name: 'الدورة' })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
  });

  it('needs at least one student', async () => {
    const user = userEvent.setup();
    renderConvert(detail(TRIAL_DONE));
    const dialog = await screen.findByRole('dialog', { name: 'التحويل إلى منتظم' });
    await user.click(within(dialog).getByRole('checkbox', { name: 'Musa' }));
    await user.click(within(dialog).getByRole('button', { name: 'حوّل إلى منتظم' }));
    expect(await within(dialog).findByText('اختر طالبًا واحدًا على الأقل.')).toBeInTheDocument();
  });

  it('asks for the family account first when there is none', async () => {
    renderConvert(detail(4));
    const dialog = await screen.findByRole('dialog', { name: 'التحويل إلى منتظم' });
    expect(
      within(dialog).getByText('أنشئ حساب العائلة أولًا من «احجز حصة تجريبية».'),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'حوّل إلى منتظم' })).toBeDisabled();
  });
});
