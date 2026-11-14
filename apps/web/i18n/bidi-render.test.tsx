import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RolesView } from '@/app/(app)/roles/roles-view';
import { renderPage } from '@/test/people';
import { FSI, PDI } from './bidi';

/**
 * docs/39 P1-10 as shipped (the other unit tests read the messages without the isolates): a value
 * inside a sentence keeps its isolates in visible text and in an aria-label.
 */
describe('bidi isolates reach the page', () => {
  it('the welcome line and a role’s delete button isolate the name', async () => {
    renderPage(<RolesView />, { path: '/roles', bidi: true });
    const del = (await screen.findAllByRole('button', { name: /^حذف الدور/ }))[0]!;
    expect(del.getAttribute('aria-label')).toMatch(new RegExp(`^حذف الدور «${FSI}.+${PDI}»$`));
  });
});
