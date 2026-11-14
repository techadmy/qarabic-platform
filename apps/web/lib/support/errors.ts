'use client';

import { useTranslations } from 'next-intl';
import { isApiError } from '@/lib/api/client';

/**
 * Support refusals in the UI language (apps/api README N4): the lifecycle rules are 422 on the
 * field (`note`, `priority`, `prUrl`, `status`, `assigneeId`), a closed ticket is 422 `body`,
 * limits are 429. Never the server's English text.
 */
export function useSupportError() {
  const t = useTranslations('support.errors');
  return (error: unknown): string => {
    if (!isApiError(error)) return t('generic');
    if (error.status === 429) return t('tooMany');
    if (error.status === 404) return t('notFound');
    if (error.status === 403) return t('forbidden');
    const errors = error.error?.errors ?? {};
    // S3 typed requests: the request moved on, or the proposed teacher cannot take the child.
    if (error.status === 409 && error.code === 'request_transition') return t('requestState');
    if (error.status === 422 && (errors['proposal.teacherId'] || errors.proposal))
      return t('proposalTeacher');
    if (error.status === 422) {
      if (errors.note) return t('note');
      if (errors.priority) return t('priority');
      if (errors.prUrl) return t('prUrl');
      if (errors.assigneeId) return t('assignee');
      if (errors.status) return t('status');
      if (errors.subjectId || errors.subjectType || errors.familyId) return t('subject');
      if (errors.attachments || errors.screenshot) return t('files');
      if (errors.body) return t('closed');
      if (errors.description) return t('description');
      return t('invalid');
    }
    return t('generic');
  };
}
