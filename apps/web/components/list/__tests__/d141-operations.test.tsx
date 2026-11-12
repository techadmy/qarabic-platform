import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ScheduleView } from '@/app/(app)/schedule/schedule-view';
import { InboxView } from '@/components/support/inbox-view';
import { renderPage } from '@/test/people';

/** D141 rollout 2: the split view on the schedule and the support inbox from 1024 px. */
const original = window.matchMedia;
beforeEach(() => {
  window.matchMedia = ((query: string) => ({
    ...original(query),
    matches: query.includes('min-width: 1024px'),
  })) as typeof window.matchMedia;
});
afterEach(() => {
  window.matchMedia = original;
});

describe('split view on the operations lists', () => {
  it('schedule: an enrollment opens beside the list; the list keeps the h1', async () => {
    renderPage(<ScheduleView />, { path: '/schedule?id=1' });
    const full = await screen.findByRole('link', { name: 'فتح في صفحة كاملة' });
    expect(full).toHaveAttribute('href', '/schedule/1');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('الجدول');
    expect(screen.getAllByRole('heading', { level: 2 }).length).toBeGreaterThan(0);
  });

  it('support inbox: a ticket opens beside the narrowed list of tickets', async () => {
    renderPage(<InboxView />, { as: 'admin@qarabic.test', path: '/support?id=2' });
    const full = await screen.findByRole('link', { name: 'فتح في صفحة كاملة' });
    expect(full).toHaveAttribute('href', '/tickets/2');
    const list = await screen.findByRole('list', { name: 'صندوق الطلبات' });
    const current = await within(list).findByRole('link', { current: true });
    expect(within(current).getByText('#2', { exact: false })).toBeInTheDocument();
  });
});

describe('narrow screens keep the record pages', () => {
  it('support inbox: below 1024 px a ticket links to /tickets/:id (not /support/:id)', async () => {
    window.matchMedia = original;
    renderPage(<InboxView />, { as: 'admin@qarabic.test', path: '/support' });
    const list = await screen.findByRole('list', { name: 'صندوق الطلبات' });
    const link = await within(list).findByRole('link', { name: /#2 · / });
    expect(link).toHaveAttribute('href', '/tickets/2');
  });
});
