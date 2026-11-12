'use client';

import type { SessionDto } from '@qarabic/shared';
import { Button } from '@qarabic/ui/components/button';
import { VideoIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useSessionActions } from './use-session-actions';

/**
 * «ادخل الحصة» for a parent (docs/15 §2.6 P1): a labelled button, at least 44 px high on phones
 * (§5.15), shown only while the meeting can be joined. `compact` is the row size (44 px), the
 * default the hero size.
 */
export function JoinClassButton({ session, compact }: { session: SessionDto; compact?: boolean }) {
  const t = useTranslations('support.parentHome');
  const actions = useSessionActions(session);
  if (!session.zoom.joinAvailable) return null;
  return (
    <Button
      className={compact ? 'h-11' : 'h-12 px-6 text-base'}
      onClick={() => actions.openMeeting('join')}
    >
      <VideoIcon />
      {t('join')}
      <span className="sr-only">: {session.student.name}</span>
    </Button>
  );
}
