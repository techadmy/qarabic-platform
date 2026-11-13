import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { LeadWorkbench } from '@/components/crm/lead-workbench';
import { TeacherHomeView } from '@/components/portal/teacher-home';
import { crmdb } from '@/mocks/crm-db';
import { offersForTests } from '@/mocks/trial-offers';
import { renderPage } from '@/test/people';

const TEACHER = 'teacher@qarabic.test';
const LEAD = 6; // the seeded open offer is for this lead's child, to teachers 1 and 4

describe('T3 open offers', () => {
  it('the teacher sees the offer without the family, and accepting books it for them', async () => {
    const user = userEvent.setup();
    renderPage(<TeacherHomeView />, { as: TEACHER, path: '/' });
    const section = await screen.findByRole('region', { name: 'عروض الحصص التجريبية' });
    const lead = crmdb.leads.find((l) => l.id === LEAD)!;
    // Course, time, the child's age and gender, the note: never the family's name or contacts.
    expect(section).toHaveTextContent('A shy seven-year-old; please be patient.');
    expect(section).toHaveTextContent(/الرد قبل/);
    expect(section).not.toHaveTextContent(lead.parentName);
    if (lead.email) expect(section).not.toHaveTextContent(lead.email);
    await user.click(within(section).getByRole('button', { name: 'أقبل الحصة' }));
    // It asks first: accepting books the class at once.
    const confirm = await screen.findByRole('alertdialog', { name: 'قبول الحصة التجريبية؟' });
    await user.click(within(confirm).getByRole('button', { name: 'أقبل الحصة' }));
    expect(await screen.findByText('حُجزت الحصة التجريبية لك.')).toBeInTheDocument();
    expect(await within(section).findByText('حُجزت لك')).toBeInTheDocument();
    expect(within(section).getByRole('link', { name: 'افتح الحصة' })).toHaveAttribute(
      'href',
      expect.stringMatching(/^\/my-classes\?session=\d+$/),
    );
    await waitFor(() => expect(lead.status).toBe('trial_scheduled'));
  });

  it('the CSR sees the offer on the lead, who it went to, and can cancel it', async () => {
    const user = userEvent.setup();
    // The workbench keeps its tab in the URL.
    renderPage(<LeadWorkbench id={LEAD} />, { path: `/leads/${LEAD}?tab=trials` });
    const offers = await screen.findByRole('region', {
      name: 'عروض الحصة التجريبية على المعلمين',
    });
    expect(within(offers).getByText('أول من يقبل', { exact: false })).toBeInTheDocument();
    const teachers = within(offers).getByRole('list', { name: 'المعلمون الذين وصلهم العرض' });
    expect(within(teachers).getAllByRole('listitem')).toHaveLength(2);
    expect(within(teachers).getAllByText('لم يرد بعد')).toHaveLength(2);
    await user.click(within(offers).getByRole('button', { name: 'ألغِ العرض' }));
    // Confirm with a reason (D31).
    const dialog = await screen.findByRole('alertdialog', { name: 'إلغاء العرض؟' });
    await user.type(within(dialog).getByLabelText(/سبب الإلغاء/), 'The family found a time');
    await user.click(within(dialog).getByRole('button', { name: 'ألغِ العرض' }));
    expect(await screen.findByText('أُلغي العرض.')).toBeInTheDocument();
    expect(await within(offers).findByText('ملغى')).toBeInTheDocument();
  });

  it('an offer another teacher took says so; nothing to answer', async () => {
    const o = offersForTests()[0]!;
    Object.assign(o, { status: 'claimed', claimedTeacher: { id: 4, name: 'Nour Adel' } });
    renderPage(<TeacherHomeView />, { as: TEACHER, path: '/' });
    const section = await screen.findByRole('region', { name: 'عروض الحصص التجريبية' });
    expect(await within(section).findByText('تم إسناد هذه الحصة')).toBeInTheDocument();
    expect(within(section).queryByRole('button', { name: 'أقبل الحصة' })).toBeNull();
  });

  it('«اختر» a volunteer: the booking’s warnings are shown to confirm, then it books', async () => {
    const user = userEvent.setup();
    const o = offersForTests()[0]!;
    // A Friday at 8 pm Cairo: outside the demo teachers' hours (Sat–Thu), so a warning to tick.
    const friday = new Date();
    friday.setUTCDate(friday.getUTCDate() + ((5 - friday.getUTCDay() + 7) % 7 || 7));
    const day = friday.toISOString().slice(0, 10);
    Object.assign(o, {
      policy: 'volunteer',
      familyZone: 'Africa/Cairo',
      familyLocal: { date: day, time: '20:00' },
      startsAt: `${day}T18:00:00.000Z`,
    });
    o.teachers[0]!.response = 'volunteer';
    renderPage(<LeadWorkbench id={LEAD} />, { path: `/leads/${LEAD}?tab=trials` });
    const offers = await screen.findByRole('region', {
      name: 'عروض الحصة التجريبية على المعلمين',
    });
    await user.click(within(offers).getByRole('button', { name: /^اختر/ }));
    const pick = await screen.findByRole('dialog', { name: /^حجز الحصة مع/ });
    const confirm = within(pick).getByRole('button', { name: 'احجز مع هذا المعلم' });
    expect(confirm).toBeDisabled();
    await user.click(within(pick).getByRole('checkbox', { name: 'خارج ساعات عمل المعلم' }));
    await user.click(confirm);
    expect(await screen.findByText('حُجزت الحصة مع المعلم المختار.')).toBeInTheDocument();
    await waitFor(() => expect(o.status).toBe('claimed'));
  });
});
