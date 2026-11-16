'use client';

import { Alert, AlertDescription, AlertTitle } from '@qarabic/ui/components/alert';
import { Button } from '@qarabic/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@qarabic/ui/components/card';
import { FieldDescription } from '@qarabic/ui/components/field';
import { Skeleton } from '@qarabic/ui/components/skeleton';
import { useQuery } from '@tanstack/react-query';
import { CopyIcon, ExternalLinkIcon, TriangleAlertIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { toast } from 'sonner';
import { fetchMyZoomLink, teachingKeys } from '@/lib/api/teaching';

/*
| D151: every teacher has their personal Zoom link. Staff with `staff.manage` set and see it on the
| profile; other staff see only whether it is set; the teacher reads it in their portal.
*/

/** «نسخ» + «فتح» for a Zoom link (labelled buttons, 44 px on phones). */
export function ZoomLinkActions({ url, label }: { url: string; label?: string }) {
  const t = useTranslations('zoomLink');
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      toast.success(t('copied'));
    } catch {
      toast.error(t('copyFailed'));
    }
  }
  return (
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" size="sm" className="max-sm:h-11" onClick={copy}>
        <CopyIcon />
        {t('copy')}
        {label && <span className="sr-only">: {label}</span>}
      </Button>
      <Button asChild variant="outline" size="sm" className="max-sm:h-11">
        <a href={url} target="_blank" rel="noopener noreferrer">
          <ExternalLinkIcon />
          {t('open')}
          <span className="sr-only">
            {label ? `: ${label}` : ''} ({t('newTab')})
          </span>
        </a>
      </Button>
    </div>
  );
}

/** The link (left to right) with its actions; null → the «not set» warning text. */
export function ZoomLinkValue({ url, hasLink }: { url?: string | null; hasLink?: boolean }) {
  const t = useTranslations('zoomLink');
  if (url) {
    return (
      <div className="flex flex-col gap-2">
        <bdi dir="ltr" className="text-sm break-all">
          {url}
        </bdi>
        <ZoomLinkActions url={url} label={t('label')} />
      </div>
    );
  }
  // Readers without `staff.manage` get `hasZoomLink` only.
  if (hasLink) return <span>{t('set')}</span>;
  return (
    <span className="inline-flex items-center gap-1.5 font-medium text-status-orange-emphasis">
      <TriangleAlertIcon aria-hidden className="size-4" />
      {t('missing')}
    </span>
  );
}

/** The profile warning when a teacher has no Zoom link: their classes have nothing to join. */
export function MissingZoomLinkAlert({ onAdd }: { onAdd?: () => void }) {
  const t = useTranslations('zoomLink');
  return (
    <Alert variant="warning">
      <TriangleAlertIcon />
      <AlertTitle>{t('missingTitle')}</AlertTitle>
      <AlertDescription>
        <p>{t('missingBody')}</p>
        {onAdd && (
          <Button type="button" variant="outline" size="sm" className="mt-2" onClick={onAdd}>
            {t('add')}
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}

/** «رابط زووم الخاص بك» in the teacher portal: read-only, set by the academy. */
export function MyZoomLinkCard() {
  const t = useTranslations('zoomLink');
  const query = useQuery({
    queryKey: teachingKeys.myZoomLink,
    queryFn: ({ signal }) => fetchMyZoomLink(signal),
  });
  // A load failure hides the card: the classes still carry their own links.
  if (query.isError) return null;
  return (
    <Card className="gap-3 shadow-none">
      <CardHeader>
        <CardTitle className="text-base font-bold">{t('mine')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {query.isPending ? (
          <Skeleton className="h-16 w-full" />
        ) : query.data.url ? (
          <>
            <ZoomLinkValue url={query.data.url} />
            {query.data.meetingId && (
              <p className="text-sm text-muted-foreground">
                {t('meetingId')}: <bdi dir="ltr">{query.data.meetingId}</bdi>
              </p>
            )}
            <p className="text-sm text-muted-foreground">{t('mineNote')}</p>
          </>
        ) : (
          <p className="inline-flex items-start gap-1.5 text-sm font-medium text-status-orange-emphasis">
            <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
            {t('mineMissing')}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Under «رابط زووم المعلّم» in an enrollment form: the classes take the teacher's link; when the
 * chosen teacher has none, say so and link to their profile (D151).
 */
export function TeacherLinkNote({ teacher }: { teacher?: { id: number; hasZoomLink?: boolean } }) {
  const t = useTranslations('zoomLink');
  if (teacher?.hasZoomLink === false) {
    return (
      <p className="inline-flex flex-wrap items-center gap-x-1.5 text-sm font-medium text-status-orange-emphasis">
        <TriangleAlertIcon aria-hidden className="size-4" />
        {t('teacherMissing')}
        <Link href={`/teachers/${teacher.id}`} className="text-primary underline">
          {t('openTeacher')}
        </Link>
      </p>
    );
  }
  return <FieldDescription>{t('teacherDefault')}</FieldDescription>;
}
