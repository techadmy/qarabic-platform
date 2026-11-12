'use client';

import {
  LEAD_NOTIFICATION_LABELS,
  TASK_NOTIFICATION_EVENTS,
  type LeadNotificationEvent,
  type NotificationDto,
} from '@qarabic/shared';
import { Button } from '@qarabic/ui/components/button';
import { Popover, PopoverContent, PopoverTrigger } from '@qarabic/ui/components/popover';
import { cn } from '@qarabic/ui/lib/utils';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import { useNow, useUiLocale, useViewerTz } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import {
  fetchNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  notificationKeys,
} from '@/lib/api/notifications';
import { dayAndClock, relativeTime } from '@/lib/schedule-time';

const TASK_EVENTS = new Set<string>(TASK_NOTIFICATION_EVENTS);

/**
 * The bell in the top bar (`/me/notifications`): the unread count on the button, the latest alerts
 * in a shadcn `Popover`; opening one marks it read. N5 writes the lead alerts; M8 the task,
 * announcement and class-reminder ones (each opens its record).
 */
export function NotificationBell() {
  const t = useTranslations('bell');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const me = useCurrentUser();
  const now = useNow(60_000);
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const list = useQuery({
    queryKey: notificationKeys.list,
    queryFn: ({ signal }) => fetchNotifications(signal),
    refetchInterval: 60_000,
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: notificationKeys.list });
  const readOne = useMutation({ mutationFn: markNotificationRead, onSettled: refresh });
  const readAll = useMutation({ mutationFn: markAllNotificationsRead, onSettled: refresh });
  const unread = list.data?.meta.unread ?? 0;
  const rows = list.data?.data ?? [];

  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const text = (n: NotificationDto) => {
    const name = str(n.data.parentName);
    if (n.kind === 'lead' && n.event in LEAD_NOTIFICATION_LABELS)
      return `${LEAD_NOTIFICATION_LABELS[n.event as LeadNotificationEvent][locale]}: ${name}`;
    if (n.kind === 'task' && TASK_EVENTS.has(n.event))
      return t(`task.${n.event}`, { title: str(n.data.title), by: str(n.data.by) });
    if (n.kind === 'announcement') return t('announcement', { title: str(n.data.title) });
    if (n.kind === 'class_reminder') {
      const at = str(n.data.startsAt);
      return t('classReminder', {
        student: str(n.data.student),
        when: at ? dayAndClock(at, tz, locale) : '',
      });
    }
    return t('other');
  };
  const num = (v: unknown) => (typeof v === 'number' ? v : null);
  const href = (n: NotificationDto) => {
    const portal = me.role?.kind === 'teacher' || me.role?.kind === 'parent';
    if (n.kind === 'lead' && num(n.data.leadId)) return `/leads/${num(n.data.leadId)}`;
    if (n.kind === 'task' && num(n.data.taskId)) return `/tasks/${num(n.data.taskId)}`;
    if (n.kind === 'announcement') return '/announcements';
    if (n.kind === 'class_reminder' && num(n.data.sessionId))
      return `${portal ? '/my-classes' : '/today'}?session=${num(n.data.sessionId)}`;
    return null;
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative size-9"
          aria-label={t('open', { count: unread })}
        >
          <BellIcon />
          {unread > 0 && (
            <span
              aria-hidden
              className="absolute -top-0.5 -end-0.5 flex min-w-4.5 items-center justify-center rounded-full bg-destructive px-1 text-[0.6875rem] leading-4.5 font-bold text-white tabular-nums"
            >
              {unread > 9 ? '9+' : unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(22rem,calc(100vw-2rem))] p-0">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="font-bold">{t('title')}</h2>
          {unread > 0 && (
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0"
              onClick={() => readAll.mutate()}
            >
              {t('readAll')}
            </Button>
          )}
        </div>
        {list.isError ? (
          <p className="p-4 text-sm text-destructive">{t('error')}</p>
        ) : rows.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">{list.isPending ? '…' : t('empty')}</p>
        ) : (
          <ul aria-label={t('title')} className="max-h-96 divide-y overflow-y-auto">
            {rows.map((n) => {
              const to = href(n);
              const body = (
                <>
                  <span className={cn('text-sm', !n.readAt && 'font-semibold')}>
                    {!n.readAt && <span className="sr-only">{t('unread')} </span>}
                    {text(n)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {relativeTime(n.createdAt, now, locale)}
                  </span>
                </>
              );
              return (
                <li key={n.id} className={cn(!n.readAt && 'bg-accent/40')}>
                  {to ? (
                    <Link
                      href={to}
                      className="flex flex-col gap-0.5 px-4 py-3 outline-none hover:bg-subtle focus-visible:bg-subtle"
                      onClick={() => {
                        if (!n.readAt) readOne.mutate(n.id);
                        setOpen(false);
                      }}
                    >
                      {body}
                    </Link>
                  ) : (
                    <div className="flex flex-col gap-0.5 px-4 py-3">{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
