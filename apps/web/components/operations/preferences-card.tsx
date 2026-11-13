'use client';

import {
  NOTIFICATION_CHANNEL_LABELS,
  NOTIFICATION_KIND_LABELS,
  type NotificationKind,
  type NotificationPreferenceDto,
} from '@qarabic/shared';
import { Button } from '@qarabic/ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@qarabic/ui/components/card';
import { Skeleton } from '@qarabic/ui/components/skeleton';
import { Spinner } from '@qarabic/ui/components/spinner';
import { Switch } from '@qarabic/ui/components/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@qarabic/ui/components/table';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { useUiLocale } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { ErrorState } from '@/components/states';
import {
  fetchNotificationPreferences,
  operationsKeys,
  saveNotificationPreferences,
} from '@/lib/api/operations';
import { useBeforeUnload } from '@/lib/forms/use-unsaved-guard';
import { kindsFor } from '@/lib/operations/notifications';
import { useOperationsError } from './ops-bits';

const CHANNELS = [
  { key: 'inApp', channel: 'in_app' },
  { key: 'email', channel: 'email' },
  { key: 'push', channel: 'push' },
  { key: 'whatsapp', channel: 'whatsapp' },
] as const;

/** Channels that can be off for the whole academy, each with its own note under the table. */
const GATED = ['push', 'whatsapp'] as const;

/**
 * «الإشعارات» on «حسابي» (M8 notification centre): per kind, in the app / by email / mobile push /
 * by WhatsApp. Channels the academy has switched off (`channels`: push until the server's push
 * driver is on, WhatsApp until B50) show disabled, each with its reason.
 */
export function PreferencesCard() {
  const t = useTranslations('operations.preferences');
  const locale = useUiLocale();
  const me = useCurrentUser();
  const queryClient = useQueryClient();
  const message = useOperationsError();
  const query = useQuery({
    queryKey: operationsKeys.preferences,
    queryFn: ({ signal }) => fetchNotificationPreferences(signal),
  });
  const [draft, setDraft] = useState<NotificationPreferenceDto[] | null>(null);
  const save = useMutation({
    mutationFn: saveNotificationPreferences,
    onSuccess: (r) => {
      queryClient.setQueryData(operationsKeys.preferences, r);
      setDraft(null);
      toast.success(t('saved'));
    },
    onError: (e) => toast.error(message(e)),
  });
  const kinds = kindsFor(me);
  const noteId = useId();
  const noteFor = (channel: string) => `${noteId}-${channel}`;
  // Toggled but not saved: leaving the page asks first (§5.6).
  useBeforeUnload(!!draft);
  const rows = (draft ?? query.data?.data ?? []).filter((p) => kinds.includes(p.kind));
  const channels = query.data?.channels;
  const set = (kind: NotificationKind, key: (typeof CHANNELS)[number]['key'], on: boolean) =>
    setDraft((d) =>
      (d ?? query.data!.data).map((p) => (p.kind === kind ? { ...p, [key]: on } : p)),
    );

  return (
    <Card className="shadow-none">
      <CardHeader className="border-b">
        <CardTitle className="text-base font-bold">
          <h2>{t('title')}</h2>
        </CardTitle>
        <CardDescription>{t('hint')}</CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        {query.isError ? (
          <ErrorState onRetry={() => void query.refetch()} />
        ) : !query.data ? (
          <Skeleton className="h-32" />
        ) : (
          <Table aria-label={t('title')}>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="whitespace-normal">{t('kind')}</TableHead>
                {CHANNELS.map((c) => (
                  // Channel names wrap so all four channels fit on a phone (no sideways scroll).
                  <TableHead key={c.key} className="w-16 px-1 text-center whitespace-normal">
                    {NOTIFICATION_CHANNEL_LABELS[c.channel][locale]}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((p) => (
                <TableRow key={p.kind}>
                  <TableCell className="font-medium whitespace-normal">
                    {NOTIFICATION_KIND_LABELS[p.kind][locale]}
                  </TableCell>
                  {CHANNELS.map((c) => {
                    const off = channels?.[c.channel] === false;
                    const label = t('switchLabel', {
                      kind: NOTIFICATION_KIND_LABELS[p.kind][locale],
                      channel: NOTIFICATION_CHANNEL_LABELS[c.channel][locale],
                    });
                    return (
                      <TableCell key={c.key} className="text-center">
                        <Switch
                          checked={!off && p[c.key]}
                          disabled={off || save.isPending}
                          aria-label={label}
                          aria-describedby={
                            off && (GATED as readonly string[]).includes(c.channel)
                              ? noteFor(c.channel)
                              : undefined
                          }
                          onCheckedChange={(v) => set(p.kind, c.key, v)}
                        />
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {GATED.map(
          (c) =>
            channels?.[c] === false && (
              <p key={c} id={noteFor(c)} className="mt-3 text-sm text-muted-foreground">
                {t(c === 'push' ? 'pushOff' : 'whatsappOff')}
              </p>
            ),
        )}
      </CardContent>
      <CardFooter className="justify-end gap-2 border-t">
        {draft && (
          <Button variant="outline" onClick={() => setDraft(null)} disabled={save.isPending}>
            {t('reset')}
          </Button>
        )}
        <Button disabled={!draft || save.isPending} onClick={() => draft && save.mutate(draft)}>
          {save.isPending && <Spinner />}
          {t('save')}
        </Button>
      </CardFooter>
    </Card>
  );
}
