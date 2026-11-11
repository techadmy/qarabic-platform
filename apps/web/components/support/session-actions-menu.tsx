'use client';

import {
  PARENT_CONTACT_CARDS,
  TEACHER_CONTACT_CARDS,
  type RequestType,
  type SessionDto,
} from '@qarabic/shared';
import { Button } from '@qarabic/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@qarabic/ui/components/dropdown-menu';
import { EllipsisIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { RequestDialog } from '@/components/requests/request-dialog';
import { useUiLocale, useViewerTz } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { can } from '@/lib/auth/use-me';
import { dayAndClock } from '@/lib/schedule-time';
import { audienceOf, canReport } from '@/lib/support/labels';
import { useDirection } from '@/lib/use-direction';
import { classActions, useActionLabel, type ClassAction } from './contact-hub';
import { TicketFormDialog, type TicketIntent } from './ticket-form-dialog';

/**
 * «⋯ إجراءات» on a class card (docs/32 §2b layer 1): change the time, excuse from the class, a
 * problem in this class. Two taps to the pre-filled form; a real menu (keyboard: Enter / Space
 * opens, arrows move).
 */
export function SessionActionsMenu({ session: s }: { session: SessionDto }) {
  const t = useTranslations('support.actions');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const dir = useDirection();
  const me = useCurrentUser();
  const label = useActionLabel();
  const [request, setRequest] = useState<RequestType | null>(null);
  const [intent, setIntent] = useState<TicketIntent | null>(null);
  const audience = audienceOf(me);
  const card = (audience === 'teacher' ? TEACHER_CONTACT_CARDS : PARENT_CONTACT_CARDS).find(
    (c) => c.key === 'classes',
  );
  const mayRequest = can(me, 'session_requests.request');
  const actions = classActions(s, card?.choices ?? [], mayRequest).filter(
    (a) => a.kind === 'request' || canReport(me),
  );
  const when = dayAndClock(s.startsAt, tz, locale);
  if (actions.length === 0) return null;

  const run = (a: ClassAction) => {
    if (a.kind === 'request') {
      setRequest(a.type);
      return;
    }
    setIntent({
      key: a.key,
      category: a.choice.category,
      ...(a.choice.subcategory ? { subcategory: a.choice.subcategory } : {}),
      subject: {
        type: 'session',
        id: s.id,
        label: [when, locale === 'en' ? s.course.nameEn : s.course.nameAr, s.student.name].join(
          ' · ',
        ),
      },
    });
  };

  return (
    <>
      <DropdownMenu dir={dir}>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" className="h-10" aria-label={`${t('menu')} · ${when}`}>
            <EllipsisIcon />
            {t('menu')}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-52">
          {actions.map((a) => (
            <DropdownMenuItem
              key={a.kind === 'request' ? a.type : a.key}
              className="min-h-10"
              onSelect={() => run(a)}
            >
              {label(a)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {request && (
        <RequestDialog
          session={s}
          type={request}
          open
          onOpenChange={(open) => !open && setRequest(null)}
        />
      )}
      {intent && (
        <TicketFormDialog intent={intent} open onOpenChange={(open) => !open && setIntent(null)} />
      )}
    </>
  );
}
