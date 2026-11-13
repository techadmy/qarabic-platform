import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { LeadWorkbench } from '@/components/crm/lead-workbench';
import { TeacherHomeView } from '@/components/portal/teacher-home';
import { crmdb } from '@/mocks/crm-db';
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
    expect(await screen.findByText('أُلغي العرض.')).toBeInTheDocument();
    expect(await within(offers).findByText('ملغى')).toBeInTheDocument();
  });
});
