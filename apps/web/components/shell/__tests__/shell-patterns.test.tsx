import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FamilyProfile } from '@/app/(app)/families/[id]/family-profile';
import { FamiliesView } from '@/app/(app)/families/families-view';
import { mockSignIn } from '@/mocks/handlers';
import { renderPage } from '@/test/people';
import { renderWithProviders } from '@/test/render';
import { routerMock } from '@/test/router-mock';
import { AppShell } from '../app-shell';

/** D141 shell patterns: sidebar «+», scoped `/` search, record tabs + collapsible sections. */
async function sidebar() {
  await waitFor(() => expect(document.querySelector('[data-sidebar="content"]')).not.toBeNull());
  return within(document.querySelector('[data-sidebar="content"]') as HTMLElement);
}

describe('sidebar «+» (D141 §6)', () => {
  it('shows «+» only beside sections the user may create in, linking to ?new=1', async () => {
    mockSignIn('admin@qarabic.test');
    renderWithProviders(
      <AppShell defaultOpen>
        <p>محتوى</p>
      </AppShell>,
    );
    const menu = await sidebar();
    expect(menu.getByRole('link', { name: 'إضافة في «العائلات»' })).toHaveAttribute(
      'href',
      '/families?new=1',
    );
    expect(menu.getByRole('link', { name: 'إضافة في «العملاء المحتملون»' })).toHaveAttribute(
      'href',
      '/leads?new=1',
    );
    // No create action on Today.
    expect(menu.queryByRole('link', { name: /«حصص اليوم»/ })).toBeNull();
  });

  it('?new=1 opens the list’s add sheet once and cleans the URL', async () => {
    renderPage(<FamiliesView />, { path: '/families?new=1' });
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'عائلة جديدة' })).toBeInTheDocument();
    const last = routerMock.replace.mock.calls.at(-1)?.[0] as string;
    expect(last).toBe('/families');
  });
});

describe('global search (D141 §5)', () => {
  it('opens with `/`, is scoped to the current section, switches section and opens a result', async () => {
    const user = userEvent.setup();
    renderPage(<p>محتوى</p>, { path: '/families' });
    const trigger = await screen.findByRole('button', { name: 'بحث في «العائلات»' });
    expect(trigger).toHaveAttribute('aria-keyshortcuts', '/');
    document.body.focus();
    await user.keyboard('/');
    const dialog = await screen.findByRole('dialog', { name: 'البحث' });
    expect(within(dialog).getByRole('combobox', { name: 'قسم البحث' })).toHaveTextContent(
      'العائلات',
    );
    const input = within(dialog).getByRole('combobox', { name: 'ابحث في «العائلات»…' });
    expect(input).toHaveFocus();
    await user.type(input, 'Omar');
    const list = await within(dialog).findByRole('listbox', { name: 'نتائج «العائلات»' });
    const [option] = await within(list).findAllByRole('option', { name: /Omar/ });
    await user.click(option!);
    expect(routerMock.push).toHaveBeenCalledWith(expect.stringMatching(/^\/families\/\d+$/));
  });

  it('does not open while typing in a field', async () => {
    const user = userEvent.setup();
    renderPage(<input aria-label="حقل" />, { path: '/families' });
    await user.type(await screen.findByRole('textbox', { name: 'حقل' }), '/');
    expect(screen.queryByRole('dialog', { name: 'البحث' })).toBeNull();
  });
});

describe('family profile tabs + collapsible sections (D141 §7)', () => {
  it('opens on «نظرة عامة», keeps the tab in the URL and collapses a section', async () => {
    const user = userEvent.setup();
    renderPage(<FamilyProfile id={1} />, { path: '/families/1' });
    const tabs = await screen.findByRole('tablist');
    expect(within(tabs).getByRole('tab', { name: 'نظرة عامة' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(within(tabs).getByRole('tab', { name: 'الفوترة' })).toBeInTheDocument();
    const contact = screen.getByRole('button', { name: 'التواصل' });
    expect(contact).toHaveAttribute('aria-expanded', 'true');
    await user.click(contact);
    expect(contact).toHaveAttribute('aria-expanded', 'false');
    await user.click(within(tabs).getByRole('tab', { name: 'السجل' }));
    expect(routerMock.replace.mock.calls.at(-1)?.[0]).toBe('/families/1?tab=history');
  });
});
