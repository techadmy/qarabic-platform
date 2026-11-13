import type { RequestState } from '@qarabic/shared';

export type StaffStep = 'propose' | 'approve' | 'complete' | 'reject';
export const STAFF_STEPS: readonly StaffStep[] = ['propose', 'approve', 'complete', 'reject'];

/** From → to per staff step; teacher change and the others differ (docs/32 §3). Null = not allowed. */
export function stepAfter(
  kind: string,
  state: RequestState,
  action: StaffStep,
): RequestState | null {
  const teacher = kind === 'teacher_change';
  switch (action) {
    case 'propose':
      return teacher && ['submitted', 'proposed', 'declined'].includes(state) ? 'proposed' : null;
    case 'approve':
      return !teacher && state === 'submitted' ? 'approved' : null;
    case 'complete':
      return (teacher ? state === 'accepted' : state === 'approved') ? 'done' : null;
    case 'reject':
      return ['submitted', 'proposed', 'declined', 'approved', 'accepted'].includes(state)
        ? 'rejected'
        : null;
  }
}
