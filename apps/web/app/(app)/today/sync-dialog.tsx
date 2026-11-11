'use client';

import { Alert, AlertDescription } from '@qarabic/ui/components/alert';
import { Button } from '@qarabic/ui/components/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@qarabic/ui/components/dialog';
import { Skeleton } from '@qarabic/ui/components/skeleton';
import { Spinner } from '@qarabic/ui/components/spinner';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircleIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { useUiLocale, useViewerTz } from '@/components/sessions/times';
import { generateSessions, sessionKeys } from '@/lib/api/sessions';
import { refreshClasses } from '@/lib/sessions/cache';
import { useClassError } from '@/lib/sessions/errors';
import { clock, dayLabel } from '@/lib/schedule-time';

/**
 * «مزامنة حصص اليوم» (schedule.manage, docs/15 §6.1 "Day generation"): a dry run lists what will
 * be added, then «أنشئ الحصص» creates them. It never deletes or changes a class (D40).
 */
export function SyncDialog({
  date,
  open,
  onOpenChange,
}: {
  date: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('today.sync');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const queryClient = useQueryClient();
  const message = useClassError();
  const preview = useQuery({
    queryKey: [...sessionKeys.all, 'generate-preview', date],
    queryFn: () => generateSessions({ date, dryRun: true }),
    enabled: open,
    gcTime: 0,
  });
  const run = useMutation({
    mutationFn: () => generateSessions({ date, dryRun: false }),
    onSuccess: (r) => {
      refreshClasses(queryClient);
      onOpenChange(false);
      toast.success(t('done', { count: r.created.length }));
    },
  });
  const rows = preview.data?.toCreate ?? [];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>
            {t('description', { date: dayLabel(date, locale) })}
          </DialogDescription>
        </DialogHeader>
        {preview.isPending ? (
          <Skeleton className="h-24" />
        ) : preview.isError ? (
          <Alert variant="destructive">
            <AlertCircleIcon />
            <AlertDescription>{message(preview.error)}</AlertDescription>
          </Alert>
        ) : rows.length === 0 ? (
          <p className="text-muted-foreground">{t('nothing')}</p>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="font-medium">{t('toCreate', { count: rows.length })}</p>
            <ul className="max-h-64 divide-y overflow-y-auto rounded-md border text-sm">
              {rows.map((r, i) => (
                <li key={i} className="flex justify-between gap-3 px-3 py-2">
                  <span>
                    <bdi>{r.student.name}</bdi> · <bdi>{r.teacher.name}</bdi>
                  </span>
                  <bdi className="text-muted-foreground">{clock(r.startsAt, tz, locale)}</bdi>
                </li>
              ))}
            </ul>
          </div>
        )}
        {run.isError && (
          <Alert variant="destructive" role="alert">
            <AlertCircleIcon />
            <AlertDescription>{message(run.error)}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">{t('close')}</Button>
          </DialogClose>
          <Button disabled={!rows.length || run.isPending} onClick={() => run.mutate()}>
            {run.isPending && <Spinner />}
            {t('confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
