import type { SessionDto } from '@qarabic/shared';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { TeacherProfile } from '@/app/(app)/teachers/[id]/teacher-profile';
import { ZoomLinkMissingBadge } from '@/components/sessions/badges';
import { hasMeetingLink } from '@/components/sessions/use-session-actions';
import { renderPage } from '@/test/people';

describe('teacher Zoom user with Zoom connected (D151 b)', () => {
  afterEach(() => window.localStorage.removeItem('qarabic.mock.zoomOn'));

  it('the form picks a free licensed user instead of a typed link; the profile shows it', async () => {
    window.localStorage.setItem('qarabic.mock.zoomOn', '1');
    const user = userEvent.setup();
    renderPage(<TeacherProfile id={2} />, { path: '/teachers/2' });
    await user.click(await screen.findByRole('button', { name: 'أضف الرابط' }));
    const picker = await screen.findByRole('combobox', { name: 'حساب Zoom' });
    expect(screen.queryByLabelText('رابط Zoom')).not.toBeInTheDocument();
    await user.click(picker);
    // Only free, licensed users: not Zoom 1/2 (teachers 1 and 3) nor Zoom 6 (no licence).
    const options = await screen.findAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining('Qarabic Zoom 3'),
      expect.stringContaining('Qarabic Zoom 4'),
      expect.stringContaining('Qarabic Zoom 5'),
    ]);
    await user.click(options[0]!);
    await user.click(screen.getByRole('button', { name: 'حفظ' }));
    expect(
      await screen.findByText('https://us02web.zoom.us/j/8500000003?pwd=mock103'),
    ).toBeInTheDocument();
    expect(screen.getByText('zoom3@qarabic.test')).toBeInTheDocument();
    expect(screen.queryByText('لا يوجد رابط Zoom لهذا المعلم')).not.toBeInTheDocument();
  });
});

/** D151: the teacher's personal Zoom link on the profile, in the form, and on the classes. */
describe('teacher Zoom link (D151)', () => {
  it('shows the link with copy and open to its editors', async () => {
    renderPage(<TeacherProfile id={1} />, { path: '/teachers/1' });
    const url = 'https://us02web.zoom.us/j/8100000001?pwd=demo1';
    expect(await screen.findByText(url)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^نسخ/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^فتح/ })).toHaveAttribute('href', url);
    expect(screen.queryByText('لا يوجد رابط Zoom لهذا المعلم')).not.toBeInTheDocument();
  });

  it('warns when the teacher has none; a link another teacher uses is refused on the field', async () => {
    const user = userEvent.setup();
    renderPage(<TeacherProfile id={2} />, { path: '/teachers/2' });
    const alert = (await screen.findByText('لا يوجد رابط Zoom لهذا المعلم')).closest(
      '[data-slot="alert"]',
    ) as HTMLElement;
    await user.click(within(alert).getByRole('button', { name: 'أضف الرابط' }));
    const field = await screen.findByLabelText('رابط Zoom');
    await user.type(field, 'https://zoom.us/j/8100000001');
    await user.click(screen.getByRole('button', { name: 'حفظ' }));
    expect(
      await screen.findByText('هذا الرابط مسجّل لمعلم آخر. لكل معلم رابط Zoom خاص به.'),
    ).toBeInTheDocument();
    expect(field).toHaveFocus();
  });

  it('refuses a link that is not a Zoom meeting link before sending it', async () => {
    const user = userEvent.setup();
    renderPage(<TeacherProfile id={2} />, { path: '/teachers/2' });
    await user.click(await screen.findByRole('button', { name: 'أضف الرابط' }));
    const field = await screen.findByLabelText('رابط Zoom');
    await user.type(field, 'https://meet.example.com/j/123456789');
    await user.click(screen.getByRole('button', { name: 'حفظ' }));
    expect(await screen.findByText('صحّح الحقول المحددة ثم احفظ.')).toBeInTheDocument();
    expect(field).toHaveAttribute('aria-invalid', 'true');
  });
});

describe('a class without its teacher’s link', () => {
  const missing = { zoom: { status: 'external', joinAvailable: false, link: 'missing' } };

  it('shows the warning badge to staff', async () => {
    renderPage(<ZoomLinkMissingBadge session={missing as unknown as SessionDto} />);
    expect(await screen.findByText('لا يوجد رابط زووم للمعلّم')).toBeInTheDocument();
  });

  it('hides it from a parent', async () => {
    renderPage(
      <>
        <span>loaded</span>
        <ZoomLinkMissingBadge session={missing as unknown as SessionDto} />
      </>,
      { as: 'parent@qarabic.test' },
    );
    // The shell renders its page once the signed-in user is loaded.
    expect(await screen.findByText('loaded')).toBeInTheDocument();
    expect(screen.queryByText('لا يوجد رابط زووم للمعلّم')).not.toBeInTheDocument();
  });

  it('does not open a meeting on «ابدأ الحصة» when there is no link', () => {
    expect(hasMeetingLink(missing as unknown as SessionDto)).toBe(false);
    expect(
      hasMeetingLink({ zoom: { status: 'external', joinAvailable: true, link: 'teacher' } }),
    ).toBe(true);
    expect(hasMeetingLink({ zoom: { status: 'none', joinAvailable: false } })).toBe(false);
    expect(hasMeetingLink({ zoom: { status: 'ready', joinAvailable: true } })).toBe(true);
  });
});
