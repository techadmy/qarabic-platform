'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { archivePerson, changeStatus, restorePerson, type PeopleKind } from '@/lib/api/people';
import { isApiError } from '@/lib/api/client';

/** React Query keys of the People screens. */
export const peopleKeys = {
  all: ['people'] as const,
  list: (kind: PeopleKind, query: unknown) => ['people', kind, 'list', query] as const,
  detail: (kind: PeopleKind, id: number) => ['people', kind, 'detail', id] as const,
  lookups: ['people', 'lookups'] as const,
};

/** Undo toasts stay 8 s (docs/15 §5.7, §5.9). */
export const UNDO_MS = 8_000;

/** The refusal codes of apps/api/README.md → copy under `people.refusals`. */
const REFUSALS = new Set([
  'same_status',
  'archived',
  'must_deactivate_first',
  'family_archived',
  'teacher_has_students',
  'cannot_archive_self',
  'last_admin',
  'not_archived',
  'cannot_change_own_role',
  'owner_role_locked',
  'permission_not_held',
]);

export function useRefusalMessage() {
  const t = useTranslations('people.refusals');
  return (error: unknown): string => {
    if (isApiError(error) && error.code && REFUSALS.has(error.code)) {
      return t(error.code, { count: Number(error.error?.data?.activeStudents ?? 0) });
    }
    if (isApiError(error, 403)) return t('forbidden');
    return t('generic');
  };
}

/** Status change, archive and restore, with the Undo toasts of docs/28 §2 and D128. */
export function usePersonActions(kind: PeopleKind) {
  const queryClient = useQueryClient();
  const t = useTranslations('people');
  const refusal = useRefusalMessage();
  const refresh = () => queryClient.invalidateQueries({ queryKey: peopleKeys.all });

  const status = useMutation({
    mutationFn: (v: { id: number; status: string; reason: string | null }) =>
      changeStatus(kind, v.id, { status: v.status, reason: v.reason }),
    onSuccess: refresh,
  });

  const archive = useMutation({
    mutationFn: (v: { id: number; reason: string }) =>
      archivePerson(kind, v.id, { reason: v.reason }),
    onSuccess: refresh,
  });

  const restore = useMutation({
    mutationFn: (v: { id: number }) => restorePerson(kind, v.id),
    onSuccess: refresh,
  });

  /** Restore with a toast; Undo archives it again with the same reason. */
  function restoreWithUndo(record: { id: number; name: string; reason: string | null }) {
    // mutateAsync: the row leaves the archived list (and unmounts) before the promise settles.
    restore
      .mutateAsync({ id: record.id })
      .then(() =>
        toast.success(t('archive.restored', { name: record.name }), {
          duration: UNDO_MS,
          action: {
            label: t('undo'),
            onClick: () =>
              void archive
                .mutateAsync({ id: record.id, reason: record.reason ?? t('archive.undoReason') })
                .catch((e: unknown) => toast.error(refusal(e))),
          },
        }),
      )
      .catch((e: unknown) => toast.error(refusal(e)));
  }

  return { status, archive, restore, restoreWithUndo, refusal };
}
