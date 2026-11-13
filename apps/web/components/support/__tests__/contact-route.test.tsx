import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ContactRoute } from '@/app/(app)/contact/contact-route';
import { bdb } from '@/mocks/billing-db';
import { db as people } from '@/mocks/people-db';
import { renderPage } from '@/test/people';

const PARENT = 'parent@qarabic.test';

describe('/contact deep links (S5)', () => {
  it('a choice opens its pre-filled form, with the family’s invoice by its number', async () => {
    const family = people.families.find((f) => f.parentUserId === 3)!;
    const own = bdb.invoices.find((x) => x.familyId === family.id && x.number)!;
    renderPage(<ContactRoute />, {
      as: PARENT,
      path: `/contact?card=billing&choice=invoice_question&invoice=${own.id}`,
    });
    const form = await screen.findByRole('dialog', { name: 'استفسار عن فاتورة أو دفعة' });
    expect(form).toHaveTextContent(`الفاتورة: ${own.number}`);
  });

  it('another family’s invoice is not used: the form opens without a subject', async () => {
    const family = people.families.find((f) => f.parentUserId === 3)!;
    const other = bdb.invoices.find((x) => x.familyId !== family.id)!;
    renderPage(<ContactRoute />, {
      as: PARENT,
      path: `/contact?card=billing&choice=invoice_question&invoice=${other.id}`,
    });
    const form = await screen.findByRole('dialog', { name: 'استفسار عن فاتورة أو دفعة' });
    expect(form).not.toHaveTextContent('الفاتورة:');
    if (other.number) expect(form).not.toHaveTextContent(other.number);
  });

  it('a card opens on its choices; a class choice opens the card (the class is picked there)', async () => {
    const { unmount } = renderPage(<ContactRoute />, {
      as: PARENT,
      path: '/contact?card=billing',
    });
    const hub = await screen.findByRole('dialog', { name: 'الفواتير والاشتراك' });
    expect(
      within(hub).getByRole('button', { name: /استفسار عن فاتورة أو دفعة/ }),
    ).toBeInTheDocument();
    unmount();

    renderPage(<ContactRoute />, {
      as: PARENT,
      path: '/contact?card=classes&choice=reschedule&session=12',
    });
    expect(await screen.findByRole('dialog', { name: 'الحصص والمواعيد' })).toBeInTheDocument();
  });

  it('an unknown card opens the hub home; the page underneath is the person’s own home', async () => {
    renderPage(<ContactRoute />, { as: PARENT, path: '/contact?card=nope' });
    const hub = await screen.findByRole('dialog', { name: 'تواصل معنا' });
    expect(within(hub).getByRole('heading', { name: 'بخصوص ماذا؟' })).toBeInTheDocument();
  });
});
