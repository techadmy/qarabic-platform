import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AttentionBadge } from '@/components/sessions/badges';
import { renderWithProviders } from '@/test/render';

describe('attention badges (Z1, D35: icon and text)', () => {
  it('names the Zoom attendance problems in words', () => {
    renderWithProviders(
      <>
        <AttentionBadge code="teacher_no_show" />
        <AttentionBadge code="student_no_show" />
        <AttentionBadge code="short_class" />
      </>,
    );
    expect(screen.getByText('المعلم لم يحضر')).toBeInTheDocument();
    expect(screen.getByText('الطالب لم يحضر')).toBeInTheDocument();
    expect(screen.getByText('حصة أقصر من المقرر')).toBeInTheDocument();
  });
});
