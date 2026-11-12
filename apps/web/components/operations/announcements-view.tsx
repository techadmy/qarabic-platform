'use client';

import {
  ANNOUNCEMENT_STATUS_LABELS,
  ANNOUNCEMENT_STATUSES,
  ROLES,
  SYSTEM_ROLES,
  type AnnouncementDto,
  type AnnouncementStatus,
  type Role,
} from '@qarabic/shared';
import { Badge } from '@qarabic/ui/components/badge';
import { Button } from '@qarabic/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@qarabic/ui/components/card';
import { Checkbox } from '@qarabic/ui/components/checkbox';
import { Input } from '@qarabic/ui/components/input';
import { Label } from '@qarabic/ui/components/label';
import { Skeleton } from '@qarabic/ui/components/skeleton';
import { Switch } from '@qarabic/ui/components/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@qarabic/ui/components/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@qarabic/ui/components/tabs';
import { Textarea } from '@qarabic/ui/components/textarea';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArchiveIcon,
  CheckIcon,
  MegaphoneIcon,
  PencilIcon,
  PinIcon,
  PlusIcon,
  SendIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { FormRow, NUMBER_INPUT } from '@/components/billing/billing-bits';
import { ListPagination } from '@/components/list/list-pagination';
import { StatusTabs } from '@/components/list/list-toolbar';
import { FormDialog } from '@/components/payroll/payroll-bits';
import { PageHeader } from '@/components/page-header';
import { ToneBadge } from '@/components/sessions/badges';
import { useUiLocale, useViewerTz } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { EmptyState, ErrorState, ForbiddenState } from '@/components/states';
import {
  announcementAction,
  fetchAnnouncements,
  markAnnouncementRead,
  operationsKeys,
  saveAnnouncement,
} from '@/lib/api/operations';
import { can } from '@/lib/auth/use-me';
import { useListParams } from '@/lib/list-params';
import { dateKeyIn, dayAndClock, zonedInstant } from '@/lib/schedule-time';
import { formatDate } from '@/lib/time';
import { useDirection } from '@/lib/use-direction';
import { useOperationsError } from './ops-bits';

function audienceText(audience: string[], locale: 'ar' | 'en', everyone: string) {
  if (audience.length === 0) return everyone;
  return audience.map((r) => (r in SYSTEM_ROLES ? SYSTEM_ROLES[r as Role][locale] : r)).join('، ');
}

function AnnouncementDialog({
  announcement,
  onClose,
}: {
  announcement: AnnouncementDto | null;
  onClose: () => void;
}) {
  const t = useTranslations('operations.announcements');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const queryClient = useQueryClient();
  const message = useOperationsError();
  const ids = { title: useId(), body: useId(), pinned: useId(), expires: useId(), aud: useId() };
  const a = announcement;
  const [title, setTitle] = useState(a?.title ?? '');
  const [body, setBody] = useState(a?.body ?? '');
  const [audience, setAudience] = useState<string[]>(a?.audience ?? []);
  const [pinned, setPinned] = useState(a?.pinned ?? false);
  const [expires, setExpires] = useState(a?.expiresAt ? dateKeyIn(tz, new Date(a.expiresAt)) : '');
  const [touched, setTouched] = useState(false);
  const errors = {
    title: title.trim().length >= 3 ? null : 'titleRequired',
    body: body.trim().length >= 3 ? null : 'bodyRequired',
  };
  const err = (k: keyof typeof errors) => (touched && errors[k] ? t(`form.${errors[k]}`) : null);
  const save = useMutation({
    mutationFn: () =>
      saveAnnouncement(a?.id ?? null, {
        title: title.trim(),
        body: body.trim(),
        audience,
        pinned,
        expiresAt: expires ? zonedInstant(expires, '23:59', tz) : null,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: operationsKeys.all });
      toast.success(a ? t('saved') : t('drafted'));
      onClose();
    },
  });
  const toggle = (role: string, on: boolean) =>
    setAudience((list) => (on ? [...list, role] : list.filter((r) => r !== role)));
  return (
    <FormDialog
      open
      wide
      onOpenChange={(o) => !o && onClose()}
      title={a ? t('editTitle') : t('newTitle')}
      description={a ? undefined : t('newHint')}
      submitLabel={a ? t('save') : t('saveDraft')}
      busy={save.isPending}
      error={save.isError ? message(save.error) : null}
      summary={touched && (errors.title || errors.body) ? t('form.fixErrors') : null}
      onSubmit={() => {
        setTouched(true);
        if (!errors.title && !errors.body) save.mutate();
      }}
    >
      <FormRow id={ids.title} label={t('fields.title')} required error={err('title')}>
        <Input
          id={ids.title}
          dir="auto"
          maxLength={200}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          aria-invalid={!!err('title')}
          className="h-10 md:text-[0.9375rem]"
        />
      </FormRow>
      <FormRow id={ids.body} label={t('fields.body')} required error={err('body')}>
        <Textarea
          id={ids.body}
          dir="auto"
          rows={5}
          maxLength={10_000}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          aria-invalid={!!err('body')}
          className="md:text-[0.9375rem]"
        />
      </FormRow>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 font-semibold">{t('fields.audience')}</legend>
        <p className="text-sm text-muted-foreground">{t('audienceHint')}</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {ROLES.filter((r) => r !== 'admin').map((r) => (
            <div key={r} className="flex items-center gap-2">
              <Checkbox
                id={`${ids.aud}-${r}`}
                checked={audience.includes(r)}
                onCheckedChange={(v) => toggle(r, v === true)}
              />
              <Label htmlFor={`${ids.aud}-${r}`}>{SYSTEM_ROLES[r][locale]}</Label>
            </div>
          ))}
        </div>
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormRow id={ids.expires} label={t('fields.expires')} hint={t('expiresHint')}>
          <Input
            id={ids.expires}
            type="date"
            dir="ltr"
            value={expires}
            onChange={(e) => setExpires(e.target.value)}
            className={NUMBER_INPUT}
          />
        </FormRow>
        <div className="flex items-center gap-2 self-end pb-2">
          <Switch id={ids.pinned} checked={pinned} onCheckedChange={setPinned} />
          <Label htmlFor={ids.pinned}>{t('fields.pinned')}</Label>
        </div>
      </div>
    </FormDialog>
  );
}

/** The current announcements for the viewer's role, pinned first; «تم الاطلاع» marks one read. */
function Feed() {
  const t = useTranslations('operations.announcements');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const params = useListParams();
  const queryClient = useQueryClient();
  const message = useOperationsError();
  const unreadId = useId();
  const unread = params.get('unread') === '1';
  const query = {
    scope: 'current' as const,
    unread: unread || undefined,
    page: params.page,
    perPage: params.perPage,
  };
  const list = useQuery({
    queryKey: operationsKeys.announcements(query),
    queryFn: ({ signal }) => fetchAnnouncements(query, signal),
    placeholderData: keepPreviousData,
  });
  const read = useMutation({
    mutationFn: markAnnouncementRead,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: operationsKeys.all }),
    onError: (e) => toast.error(message(e)),
  });
  const rows = list.data?.data ?? [];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex h-10 items-center gap-2">
        <Switch
          id={unreadId}
          checked={unread}
          onCheckedChange={(v) => params.set({ unread: v ? 1 : null })}
        />
        <Label htmlFor={unreadId} className="font-medium">
          {t('unreadOnly')}
        </Label>
      </div>
      {list.isError ? (
        <ErrorState onRetry={() => void list.refetch()} />
      ) : list.isPending ? (
        <Skeleton className="h-48" aria-busy="true" />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={MegaphoneIcon}
          role="status"
          title={unread ? t('noUnread') : t('empty')}
          description={t('emptyHint')}
        />
      ) : (
        <ul className="flex flex-col gap-3" aria-label={t('title')}>
          {rows.map((a) => (
            <li key={a.id}>
              <Card className="gap-3 shadow-none" aria-labelledby={`ann-${a.id}`}>
                <CardHeader>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <CardTitle className="flex flex-wrap items-center gap-2 text-base font-bold">
                      <h2 id={`ann-${a.id}`}>{a.title}</h2>
                      {a.pinned && <ToneBadge tone="purple" icon={PinIcon} label={t('pinned')} />}
                      {!a.read && <Badge>{t('new')}</Badge>}
                    </CardTitle>
                    {a.publishedAt && (
                      <span className="text-sm text-muted-foreground">
                        {dayAndClock(a.publishedAt, tz, locale)}
                      </span>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <p className="break-words whitespace-pre-wrap">{a.body}</p>
                  {!a.read && (
                    <Button
                      variant="outline"
                      className="h-10 self-start"
                      disabled={read.isPending}
                      onClick={() => read.mutate(a.id)}
                    >
                      <CheckIcon />
                      {t('markRead')}
                      <span className="sr-only">: {a.title}</span>
                    </Button>
                  )}
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
      {list.data && rows.length > 0 && (
        <ListPagination
          meta={list.data.meta}
          onPage={(page) => params.set({ page: page === 1 ? null : page }, { resetPage: false })}
          onPerPage={(perPage) => params.set({ perPage: perPage === 25 ? null : perPage })}
        />
      )}
    </div>
  );
}

/** Every announcement for `announcements.manage`: drafts, published (with read counts), archived. */
function Manage() {
  const t = useTranslations('operations.announcements');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const params = useListParams();
  const queryClient = useQueryClient();
  const message = useOperationsError();
  const [editing, setEditing] = useState<AnnouncementDto | 'new' | null>(null);
  const statusParam = params.get('status') as AnnouncementStatus;
  const status = ANNOUNCEMENT_STATUSES.includes(statusParam) ? statusParam : undefined;
  const query = { scope: 'manage' as const, status, page: params.page, perPage: params.perPage };
  const list = useQuery({
    queryKey: operationsKeys.announcements(query),
    queryFn: ({ signal }) => fetchAnnouncements(query, signal),
    placeholderData: keepPreviousData,
  });
  const act = useMutation({
    mutationFn: (v: { id: number; action: 'publish' | 'archive' }) =>
      announcementAction(v.id, v.action),
    onSuccess: (_, v) => {
      void queryClient.invalidateQueries({ queryKey: operationsKeys.all });
      toast.success(t(v.action === 'publish' ? 'published' : 'archived'));
    },
    onError: (e) => toast.error(message(e)),
  });
  const rows = list.data?.data ?? [];
  const meta = list.data?.meta;
  return (
    <>
      <Card className="gap-0 py-0 shadow-none">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
          <StatusTabs
            label={t('statusTabs')}
            value={status ?? ''}
            onChange={(v) => params.set({ status: v || null })}
            options={[
              { value: '', label: t('all'), count: meta?.counts.all },
              ...ANNOUNCEMENT_STATUSES.map((s) => ({
                value: s,
                label: ANNOUNCEMENT_STATUS_LABELS[s][locale],
                count: meta?.counts[s],
              })),
            ]}
          />
          <Button className="h-10" onClick={() => setEditing('new')}>
            <PlusIcon />
            {t('newTitle')}
          </Button>
        </div>
        {list.isError ? (
          <div className="p-4">
            <ErrorState onRetry={() => void list.refetch()} />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table aria-label={t('manageTitle')}>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{t('fields.title')}</TableHead>
                  <TableHead>{t('fields.audience')}</TableHead>
                  <TableHead>{t('fields.status')}</TableHead>
                  <TableHead className="text-end">{t('fields.reads')}</TableHead>
                  <TableHead>
                    <span className="sr-only">{t('actions')}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="min-w-48">
                      <span className="flex flex-col">
                        <span className="flex items-center gap-1 font-semibold">
                          {a.pinned && (
                            <PinIcon
                              className="size-4 text-muted-foreground"
                              aria-label={t('pinned')}
                            />
                          )}
                          {a.title}
                        </span>
                        <span className="text-sm text-muted-foreground">
                          {a.publishedAt
                            ? dayAndClock(a.publishedAt, tz, locale)
                            : formatDate(a.createdAt.slice(0, 10), locale)}
                          {a.expiresAt &&
                            ` · ${t('until', { date: formatDate(dateKeyIn(tz, new Date(a.expiresAt)), locale) ?? '' })}`}
                        </span>
                      </span>
                    </TableCell>
                    <TableCell className="min-w-40 text-sm">
                      {audienceText(a.audience, locale, t('everyone'))}
                    </TableCell>
                    <TableCell>
                      <Badge variant={a.status === 'published' ? 'default' : 'outline'}>
                        {ANNOUNCEMENT_STATUS_LABELS[a.status][locale]}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-end tabular-nums">{a.readCount ?? '—'}</TableCell>
                    <TableCell>
                      <span className="flex justify-end gap-1">
                        {a.status === 'draft' && (
                          <Button
                            size="sm"
                            className="h-9"
                            disabled={act.isPending}
                            onClick={() => act.mutate({ id: a.id, action: 'publish' })}
                          >
                            <SendIcon />
                            {t('publish')}
                            <span className="sr-only">: {a.title}</span>
                          </Button>
                        )}
                        {a.status !== 'archived' && (
                          <>
                            <Button
                              variant="ghost"
                              size="icon-lg"
                              aria-label={t('editOf', { title: a.title })}
                              onClick={() => setEditing(a)}
                            >
                              <PencilIcon />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-lg"
                              aria-label={t('archiveOf', { title: a.title })}
                              disabled={act.isPending}
                              onClick={() => act.mutate({ id: a.id, action: 'archive' })}
                            >
                              <ArchiveIcon />
                            </Button>
                          </>
                        )}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
                {list.isPending && (
                  <TableRow>
                    <TableCell colSpan={5}>
                      <Skeleton className="h-8" />
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        )}
        {meta && rows.length > 0 && (
          <ListPagination
            meta={meta}
            onPage={(page) => params.set({ page: page === 1 ? null : page }, { resetPage: false })}
            onPerPage={(perPage) => params.set({ perPage: perPage === 25 ? null : perPage })}
          />
        )}
      </Card>
      {editing && (
        <AnnouncementDialog
          announcement={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

/**
 * «الإعلانات» (M8; the old current / all announcements): everyone with `announcements.view`
 * reads what is current for their role; `announcements.manage` also gets «إدارة الإعلانات»
 * (drafts, publish to roles, pin, end date, archive, read counts).
 */
export function AnnouncementsView() {
  const t = useTranslations('operations.announcements');
  const me = useCurrentUser();
  const dir = useDirection();
  const params = useListParams();
  const manage = can(me, 'announcements.manage');
  const tab = manage && params.get('tab') === 'manage' ? 'manage' : 'current';
  if (!can(me, 'announcements.view')) {
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  }
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <PageHeader title={t('title')} />
      {manage ? (
        <Tabs
          value={tab}
          dir={dir}
          className="gap-4"
          onValueChange={(v) => params.set({ tab: v === 'current' ? null : v, status: null })}
        >
          <TabsList>
            <TabsTrigger value="current" className="h-9 px-3">
              {t('currentTab')}
            </TabsTrigger>
            <TabsTrigger value="manage" className="h-9 px-3">
              {t('manageTitle')}
            </TabsTrigger>
          </TabsList>
          {(['current', 'manage'] as const).map((v) => (
            <TabsContent key={v} value={v} forceMount hidden={v !== tab}>
              {v === tab && (v === 'manage' ? <Manage /> : <Feed />)}
            </TabsContent>
          ))}
        </Tabs>
      ) : (
        <Feed />
      )}
    </div>
  );
}
