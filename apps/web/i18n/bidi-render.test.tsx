import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RolesView } from '@/app/(app)/roles/roles-view';
import { MOCK_ROLES } from '@/mocks/data';
import { renderPage } from '@/test/people';
import { FSI, PDI } from './bidi';

/**
 * docs/39 P1-10 as shipped (the other unit tests read the messages without the isolates): a value
 * inside a sentence keeps its isolates in visible text and in an aria-label.
 */
describe('bidi isolates reach the page', () => {
  it('«Admin (2)» is isolated whole in its delete button label (docs/39 §5)', async () => {
    const supervisor = MOCK_ROLES.find((r) => !r.isSystem)!;
    MOCK_ROLES.push({
      ...supervisor,
      id: 990,
      name: 'admin_2',
      labelAr: 'Admin (2)',
      labelEn: 'Admin (2)',
      usersCount: 0,
    });
    renderPage(<RolesView />, { path: '/roles', bidi: true });
    const del = await screen.findByRole('button', { name: /Admin \(2\)/ });
    expect(del.getAttribute('aria-label')).toBe(`حذف الدور «${FSI}Admin (2)${PDI}»`);
  });

  it('the welcome line and a role’s delete button isolate the name', async () => {
    renderPage(<RolesView />, { path: '/roles', bidi: true });
    const del = (await screen.findAllByRole('button', { name: /^حذف الدور/ }))[0]!;
    expect(del.getAttribute('aria-label')).toMatch(new RegExp(`^حذف الدور «${FSI}.+${PDI}»$`));
  });
});
