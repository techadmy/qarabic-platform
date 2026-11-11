'use client';

import {
  REQUEST_TYPE_LABELS,
  REQUEST_TYPES,
  SESSION_ACTION_LABELS,
  type RequestType,
  type SessionAction,
  type SessionDto,
} from '@qarabic/shared';
import { Button } from '@qarabic/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@qarabic/ui/components/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@qarabic/ui/components/tooltip';
import { cn } from '@qarabic/ui/lib/utils';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  EllipsisVerticalIcon,
  MessageCircleIcon,
  PhoneIcon,
  PlayIcon,
  SquareIcon,
  VideoIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState, type SyntheticEvent } from 'react';
import { toast } from 'sonner';
import { RequestDialog } from '@/components/requests/request-dialog';
import { useCurrentUser } from '@/components/shell/app-shell';
import { retryZoom } from '@/lib/api/sessions';
import { can } from '@/lib/auth/use-me';
import { useDirection } from '@/lib/use-direction';
import { upsertSession } from '@/lib/sessions/cache';
import { useClassError } from '@/lib/sessions/errors';
import { RescheduleDialog } from './reschedule-dialog';
import { useUiLocale } from './times';
import { useSessionActions } from './use-session-actions';

/** Class actions in the order a monitor reaches for them; destructive ones last (§5.7). */
const MENU_ORDER: SessionAction[] = [
  'activate',
  'start',
  'end',
  'mark_absent',
  'mark_declined',
  'mark_leave',
  'undo_mark',
  'undo_activate',
  'cancel',
  'revert',
];
const DESTRUCTIVE = new Set<SessionAction>(['cancel', 'revert', 'undo_activate']);
const digits = (phone: string) => phone.replace(/[^\d]/g, '');

/**
 * Row actions (docs/15 §6.1, the current app's `RowActions`): observe / join the meeting, call or
 * WhatsApp the teacher (real links, no state change), and a «⋯» shadcn `DropdownMenu` with the
 * class actions this user may do now (`allowedActions`), «تعديل الموعد» for staff and the
 * requests (leave, reschedule, advance, extra). `primary`: the teacher's own row also gets
 * «ابدأ الحصة» / «إنهاء الحصة» as buttons.
 */
export function RowActions({
  session,
  primary,
  className,
}: {
  session: SessionDto;
  primary?: boolean;
  className?: string;
}) {
  const t = useTranslations('classes');
  const locale = useUiLocale();
  const dir = useDirection();
  const me = useCurrentUser();
  const queryClient = useQueryClient();
  const message = useClassError();
  const actions = useSessionActions(session);
  const [request, setRequest] = useState<RequestType | null>(null);
  const [shifting, setShifting] = useState(false);
  const allowed = session.allowedActions;
  const ownTeacher = can(me, 'sessions.conduct') && !can(me, 'sessions.manage');
  // «ابدأ الحصة» / «أنهِ الحصة» as buttons for the class's own teacher; staff use the menu.
  const primaryActions =
    primary && ownTeacher ? (['activate', 'end'] as const).filter((a) => allowed.includes(a)) : [];
  const menu = MENU_ORDER.filter(
    (a) => allowed.includes(a) && !(primaryActions as readonly string[]).includes(a),
  );
  const canShift = can(me, 'sessions.manage') && session.stage === 'scheduled';
  const mayRequest =
    (can(me, 'session_requests.request') || can(me, 'session_requests.manage')) &&
    session.stage === 'scheduled' &&
    // Still ahead: a scheduled class past its start is flagged late or needing entry.
    !session.attention.includes('late') &&
    !session.attention.includes('needs_entry');
  const pendingTypes = new Set(session.pendingRequests.map((r) => r.type));
  const requestTypes = mayRequest ? REQUEST_TYPES.filter((r) => !pendingTypes.has(r)) : [];
  const retry = useMutation({
    mutationFn: () => retryZoom(session.id),
    onSuccess: (s) => {
      upsertSession(queryClient, s);
      toast.success(t('meeting.retried'));
    },
    onError: (e) => toast.error(message(e)),
  });
  const canRetry = session.zoom.status === 'failed' && can(me, 'sessions.manage');
  const phone = session.teacher.phone;
  const stop = (e: SyntheticEvent) => e.stopPropagation();
  const name = session.student.name;
  const hasMenu = menu.length > 0 || canShift || requestTypes.length > 0 || canRetry;

  return (
    <div
      className={cn('flex items-center justify-end gap-0.5', className)}
      onClick={stop}
      onKeyDown={stop}
    >
      {primaryActions.map((a) => (
        <Button
          key={a}
          size="sm"
          className="me-1"
          variant={a === 'activate' ? 'default' : 'outline'}
          disabled={!!actions.pending}
          onClick={() => {
            if (a === 'activate' && ownTeacher && session.zoom.status !== 'none') {
              actions.openMeeting('start');
            }
            actions.run(a);
          }}
        >
          {a === 'activate' ? <PlayIcon /> : <SquareIcon />}
          {a === 'activate' ? t('startClass') : t('endClass')}
          <span className="sr-only">: {name}</span>
        </Button>
      ))}
      {session.zoom.joinAvailable && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`${t(ownTeacher ? 'meeting.open' : 'meeting.observe')}: ${name}`}
              onClick={() => actions.openMeeting(ownTeacher ? 'start' : 'join')}
            >
              <VideoIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t(ownTeacher ? 'meeting.open' : 'meeting.observe')}</TooltipContent>
        </Tooltip>
      )}
      {phone && (
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" asChild>
                <a
                  href={`tel:+${digits(phone)}`}
                  aria-label={t('call', { name: session.teacher.name })}
                >
                  <PhoneIcon />
                </a>
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('call', { name: session.teacher.name })}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" asChild>
                <a
                  href={`https://wa.me/${digits(phone)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={t('whatsapp', { name: session.teacher.name })}
                >
                  <MessageCircleIcon />
                </a>
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('whatsapp', { name: session.teacher.name })}</TooltipContent>
          </Tooltip>
        </>
      )}
      {hasMenu && (
        <DropdownMenu dir={dir}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`${t('moreActions')}: ${name}`}
              disabled={!!actions.pending}
            >
              <EllipsisVerticalIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-52">
            {menu.length > 0 && (
              <DropdownMenuGroup>
                {menu.map((a, i) => (
                  <div key={a}>
                    {DESTRUCTIVE.has(a) && i > 0 && !DESTRUCTIVE.has(menu[i - 1]!) && (
                      <DropdownMenuSeparator />
                    )}
                    <DropdownMenuItem
                      variant={DESTRUCTIVE.has(a) ? 'destructive' : 'default'}
                      onSelect={() => actions.run(a)}
                    >
                      {SESSION_ACTION_LABELS[a][locale]}
                    </DropdownMenuItem>
                  </div>
                ))}
              </DropdownMenuGroup>
            )}
            {(canShift || canRetry) && (
              <>
                {menu.length > 0 && <DropdownMenuSeparator />}
                {canShift && (
                  <DropdownMenuItem onSelect={() => setShifting(true)}>
                    {t('editTime')}
                  </DropdownMenuItem>
                )}
                {canRetry && (
                  <DropdownMenuItem onSelect={() => retry.mutate()}>
                    {t('meeting.retry')}
                  </DropdownMenuItem>
                )}
              </>
            )}
            {requestTypes.length > 0 && (
              <>
                {(menu.length > 0 || canShift || canRetry) && <DropdownMenuSeparator />}
                <DropdownMenuLabel className="text-xs text-muted-foreground">
                  {t('requestsGroup')}
                </DropdownMenuLabel>
                {requestTypes.map((type) => (
                  <DropdownMenuItem key={type} onSelect={() => setRequest(type)}>
                    {REQUEST_TYPE_LABELS[type][locale]}
                  </DropdownMenuItem>
                ))}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {actions.dialogs}
      {request && (
        <RequestDialog
          session={session}
          type={request}
          open
          onOpenChange={(open) => !open && setRequest(null)}
        />
      )}
      {shifting && <RescheduleDialog session={session} open onOpenChange={setShifting} />}
    </div>
  );
}
