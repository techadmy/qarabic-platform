'use client';

import {
  ANNOUNCEMENT_STATUS_LABELS,
  ANNOUNCEMENT_STATUSES,
  ROLES,
  saveAnnouncementSchema,
  SYSTEM_ROLES,
  type AnnouncementDto,
  type AnnouncementStatus,
  type Role,
} from '@qarabic/shared';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@qarabic/ui/components/alert-dialog';
import { Badge } from '@qarabic/ui/components/badge';
import { Button } from '@qarabic/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@qarabic/ui/components/card';
import { Checkbox } from '@qarabic/ui/components/checkbox';
import { Field, FieldError, FieldLabel } from '@qarabic/ui/components/field';
import { Label } from '@qarabic/ui/components/label';
import { Skeleton } from '@qarabic/ui/components/skeleton';
import { Spinner } from '@qarabic/ui/components/spinner';
import { Switch } from '@qarabic/ui/components/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@qarabic/ui/components/tabs';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import {
  ArchiveIcon,
  CheckIcon,
  CircleCheckIcon,
  FilePenLineIcon,
  MegaphoneIcon,
  PencilIcon,
  PinIcon,
  PlusIcon,
  SearchXIcon,
  SendIcon,
  XIcon,
  type LucideIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useId, useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { DatePicker } from '@/components/forms/date-time';
import { TextareaField, TextField } from '@/components/forms/fields';
import { ListPagination } from '@/components/list/list-pagination';
import { StatusTabs } from '@/components/list/list-toolbar';
import { ResponsiveList } from '@/components/list/responsive-list';
import { FormDialog } from '@/components/payroll/payroll-bits';
import { PageHeader } from '@/components/page-header';
import { ToneBadge, type Tone } from '@/components/sessions/badges';
import { useUiLocale, useViewerTz } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { EmptyState, ErrorState, ForbiddenState } from '@/components/states';
import {
  announcementAction,
  type AnnouncementAction,
  fetchAnnouncements,
  markAnnouncementRead,
  operationsKeys,
  saveAnnouncement,
  type AnnouncementInput,
} from '@/lib/api/operations';
import { UNDO_MS } from '@/lib/people/use-person-actions';
import { can } from '@/lib/auth/use-me';
import { applyServerErrors } from '@/lib/forms/server-errors';
import { useBeforeUnload } from '@/lib/forms/use-unsaved-guard';
import { useSchemaResolver } from '@/lib/forms/validation-messages';
import { useListParams } from '@/lib/list-params';
import { endOfDayInstant, listText, splitInstant } from '@/lib/operations/time';
import { dateKeyIn } from '@/lib/schedule-time';
import { formatDate } from '@/lib/time';
import { useDirection } from '@/lib/use-direction';
import { useOperationsError, ViewerTime } from './ops-bits';

const STATUS: Record<AnnouncementStatus, { icon: LucideIcon; tone: Tone }> = {
  draft: { icon: FilePenLineIcon, tone: 'grey' },
  published: { icon: CircleCheckIcon, tone: 'green' },
  archived: { icon: ArchiveIcon, tone: 'neutral' },
};

function AnnouncementStatusBadge({ status }: { status: AnnouncementStatus }) {
  const locale = useUiLocale();
  const s = STATUS[status];
  const label = ANNOUNCEMENT_STATUS_LABELS[status];
  return <ToneBadge tone={s.tone} icon={s.icon} label={label[locale]} title={label.en} />;
}

/** The audience in the UI language: «الجميع» or a list of role names. */
function useAudienceText() {
  const t = useTranslations('operations.announcements');
  const locale = useUiLocale();
  return (audience: string[]) =>
    audience.length === 0
      ? t('everyone')
      : listText(
          audience.map((r) => (r in SYSTEM_ROLES ? SYSTEM_ROLES[r as Role][locale] : r)),
          locale,
        );
}

const FIELDS = ['title', 'body', 'audience', 'pinned', 'expiresAt'];

/**
 * «إعلان جديد» / «تعديل الإعلان»: the shared `saveAnnouncementSchema` (a 422 lands on its field),
 * the audience as role checkboxes (none = everyone), pin, and an end date (shown until that day, in
 * the viewer's zone). Closing with unsaved text asks first.
 */
function AnnouncementDialog({
  announcement,
  onClose,
}: {
  announcement: AnnouncementDto | null;
  onClose: () => void;
}) {
  const t = useTranslations('operations.announcements');
  const tv = useTranslations('validation');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const queryClient = useQueryClient();
  const message = useOperationsError();
  const ids = { aud: useId(), pinned: useId(), expires: useId() };
  const a = announcement;
  const [banner, setBanner] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const resolver = useSchemaResolver(saveAnnouncementSchema);
  const form = useForm<AnnouncementInput>({
    resolver: resolver as never,
    mode: 'onTouched',
    defaultValues: {
      title: a?.title ?? '',
      body: a?.body ?? '',
      audience: a?.audience ?? [],
      pinned: a?.pinned ?? false,
      expiresAt: a?.expiresAt ?? null,
    },
  });
  const dirty = form.formState.isDirty;
  useBeforeUnload(dirty);
  const save = useMutation({
    mutationFn: (v: AnnouncementInput) => saveAnnouncement(a?.id ?? null, v),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: operationsKeys.all });
      toast.success(a ? t('saved') : t('drafted'));
      onClose();
    },
    onError: (e) => {
      if (!applyServerErrors(form, e, (k) => tv(k), FIELDS)) setBanner(message(e));
    },
  });
  const submit = form.handleSubmit((v) => {
    setBanner(null);
    save.mutate(v);
  });
  return (
    <>
      <FormDialog
        open
        wide
        onOpenChange={(o) => {
          if (o) return;
          if (dirty) setDiscarding(true);
          else onClose();
        }}
        title={a ? t('editTitle') : t('newTitle')}
        description={a ? undefined : t('newHint')}
        submitLabel={a ? t('save') : t('saveDraft')}
        busy={save.isPending}
        error={banner}
        summary={Object.keys(form.formState.errors).length ? t('form.fixErrors') : null}
        onSubmit={() => void submit()}
      >
        <TextField control={form.control} name="title" label={t('fields.title')} required />
        <TextareaField control={form.control} name="body" label={t('fields.body')} rows={5} />
        <Controller
          control={form.control}
          name="audience"
          render={({ field, fieldState }) => (
            <fieldset className="flex flex-col gap-2" aria-describedby={`${ids.aud}-hint`}>
              <legend className="mb-1 font-semibold">{t('fields.audience')}</legend>
              <p id={`${ids.aud}-hint`} className="text-sm text-muted-foreground">
                {t('audienceHint')}
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                {ROLES.filter((r) => r !== 'admin').map((r) => (
                  <div key={r} className="flex items-center gap-2">
                    <Checkbox
                      id={`${ids.aud}-${r}`}
                      checked={field.value.includes(r)}
                      onCheckedChange={(v) =>
                        field.onChange(
                          v === true ? [...field.value, r] : field.value.filter((x) => x !== r),
                        )
                      }
                    />
                    <Label htmlFor={`${ids.aud}-${r}`}>{SYSTEM_ROLES[r][locale]}</Label>
                  </div>
                ))}
              </div>
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </fieldset>
          )}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Controller
            control={form.control}
            name="expiresAt"
            render={({ field, fieldState }) => {
              const date = splitInstant(field.value, tz).date;
              return (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor={ids.expires}>{t('fields.expires')}</FieldLabel>
                  <div className="flex gap-2">
                    <DatePicker
                      id={ids.expires}
                      value={date}
                      min={dateKeyIn(tz)}
                      onChange={(d) => field.onChange(endOfDayInstant(d, tz))}
                      className="flex-1"
                    />
                    {date && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-lg"
                        aria-label={t('clearExpires')}
                        onClick={() => field.onChange(null)}
                      >
                        <XIcon />
                      </Button>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">{t('expiresHint')}</p>
                  {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                </Field>
              );
            }}
          />
          <Controller
            control={form.control}
            name="pinned"
            render={({ field }) => (
              <div className="flex items-center gap-2 self-center">
                <Switch id={ids.pinned} checked={field.value} onCheckedChange={field.onChange} />
                <Label htmlFor={ids.pinned}>{t('fields.pinned')}</Label>
              </div>
            )}
          />
        </div>
      </FormDialog>
      <AlertDialog open={discarding} onOpenChange={setDiscarding}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('discardTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('discardHint')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('keepEditing')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={onClose}>
              {t('discard')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** The current announcements for the viewer's role, pinned first; «تم الاطلاع» marks one read. */
function Feed() {
  const t = useTranslations('operations.announcements');
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
                    <CardTitle className="flex flex-wrap items-center gap-2 text-base font-semibold">
                      <h2 id={`ann-${a.id}`}>{a.title}</h2>
                      {a.pinned && <ToneBadge tone="purple" icon={PinIcon} label={t('pinned')} />}
                      {!a.read && <Badge>{t('new')}</Badge>}
                    </CardTitle>
                    {a.publishedAt && (
                      <ViewerTime at={a.publishedAt} className="text-sm text-muted-foreground" />
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

/**
 * Every announcement for `announcements.manage`: drafts, published (with read counts), archived.
 * «نشر» names the audience before it notifies them; «أرشفة» acts at once with «تراجع» in the toast
 * (`POST /announcements/:id/unarchive`: back to published, or draft if it never was; D31).
 */
function Manage({ onEdit }: { onEdit: (a: AnnouncementDto) => void }) {
  const t = useTranslations('operations.announcements');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const params = useListParams();
  const queryClient = useQueryClient();
  const message = useOperationsError();
  const audienceText = useAudienceText();
  const [confirm, setConfirm] = useState<AnnouncementDto | null>(null);
  const statusParam = params.get('status') as AnnouncementStatus;
  const status = ANNOUNCEMENT_STATUSES.includes(statusParam) ? statusParam : undefined;
  const query = { scope: 'manage' as const, status, page: params.page, perPage: params.perPage };
  const list = useQuery({
    queryKey: operationsKeys.announcements(query),
    queryFn: ({ signal }) => fetchAnnouncements(query, signal),
    placeholderData: keepPreviousData,
  });
  const act = useMutation({
    mutationFn: (v: { id: number; action: AnnouncementAction }) =>
      announcementAction(v.id, v.action),
    onSuccess: (_, v) => {
      void queryClient.invalidateQueries({ queryKey: operationsKeys.all });
      setConfirm(null);
      if (v.action === 'archive') {
        toast.success(t('archived'), {
          duration: UNDO_MS,
          action: {
            label: t('undo'),
            onClick: () => act.mutate({ id: v.id, action: 'unarchive' }),
          },
        });
      } else {
        toast.success(t(v.action === 'publish' ? 'published' : 'unarchived'));
      }
    },
    // The publish dialog shows its own error; archive and its undo say it in a toast.
    onError: (e, v) => {
      if (v.action !== 'publish') toast.error(message(e));
    },
  });
  const rows = useMemo(() => list.data?.data ?? [], [list.data]);
  const meta = list.data?.meta;
  const when = (a: AnnouncementDto) =>
    a.publishedAt ? (
      <ViewerTime at={a.publishedAt} />
    ) : (
      t('draftedOn', { date: formatDate(dateKeyIn(tz, new Date(a.createdAt)), locale) ?? '' })
    );
  const until = (a: AnnouncementDto) =>
    a.expiresAt
      ? t('until', { date: formatDate(dateKeyIn(tz, new Date(a.expiresAt)), locale) ?? '' })
      : null;
  const rowActions = (a: AnnouncementDto) =>
    a.status === 'archived' ? null : (
      <span className="flex justify-end gap-1">
        {a.status === 'draft' && (
          <Button size="sm" className="h-9" onClick={() => setConfirm(a)}>
            <SendIcon />
            {t('publish')}
            <span className="sr-only">: {a.title}</span>
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-lg"
          aria-label={t('editOf', { title: a.title })}
          onClick={() => onEdit(a)}
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
      </span>
    );
  const columns: ColumnDef<AnnouncementDto, unknown>[] = [
    {
      id: 'title',
      header: t('fields.title'),
      cell: ({ row: { original: a } }) => (
        <span className="flex min-w-48 flex-col gap-1">
          <span className="flex items-center gap-1 font-semibold">
            {a.pinned && (
              <PinIcon className="size-4 text-muted-foreground" aria-label={t('pinned')} />
            )}
            {a.title}
          </span>
          <span className="text-sm text-muted-foreground">
            {when(a)}
            {until(a) && <> · {until(a)}</>}
          </span>
        </span>
      ),
    },
    {
      id: 'audience',
      header: t('fields.audience'),
      cell: ({ row: { original: a } }) => (
        <span className="min-w-40 text-sm">{audienceText(a.audience)}</span>
      ),
    },
    {
      id: 'status',
      header: t('fields.status'),
      cell: ({ row: { original: a } }) => <AnnouncementStatusBadge status={a.status} />,
    },
    {
      id: 'reads',
      header: t('fields.reads'),
      meta: { numeric: true },
      cell: ({ row: { original: a } }) => (
        <span className="tabular-nums">{a.readCount ?? '—'}</span>
      ),
    },
    {
      id: 'actions',
      header: () => <span className="sr-only">{t('actions')}</span>,
      cell: ({ row: { original: a } }) => rowActions(a),
    },
  ];
  const c = confirm;
  return (
    <>
      <Card className="gap-0 py-0 shadow-none">
        <div className="border-b p-4">
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
        </div>
        {list.isError ? (
          <div className="p-4">
            <ErrorState onRetry={() => void list.refetch()} />
          </div>
        ) : !list.isPending && rows.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={status ? SearchXIcon : MegaphoneIcon}
              role="status"
              title={status ? t('noneWithStatus') : t('noneYet')}
              description={status ? t('noneWithStatusHint') : t('noneYetHint')}
              action={
                status ? (
                  <Button variant="outline" onClick={() => params.set({ status: null })}>
                    {t('showAll')}
                  </Button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <ResponsiveList
            columns={columns}
            rows={rows}
            loading={list.isPending}
            label={t('manageTitle')}
            emptyText={t('noneYet')}
            getRowId={(a) => a.id}
            renderCard={(a) => (
              <div className="flex flex-col gap-2">
                <div className="flex items-start justify-between gap-2">
                  <span className="min-w-0 font-semibold">{a.title}</span>
                  <AnnouncementStatusBadge status={a.status} />
                </div>
                <span className="text-sm text-muted-foreground">{when(a)}</span>
                <span className="text-sm">
                  {t('fields.audience')}: {audienceText(a.audience)}
                </span>
                {a.readCount !== null && (
                  <span className="text-sm text-muted-foreground">
                    {t('readBy', { count: a.readCount })}
                  </span>
                )}
                {rowActions(a)}
              </div>
            )}
          />
        )}
        {meta && rows.length > 0 && (
          <ListPagination
            meta={meta}
            onPage={(page) => params.set({ page: page === 1 ? null : page }, { resetPage: false })}
            onPerPage={(perPage) => params.set({ perPage: perPage === 25 ? null : perPage })}
          />
        )}
      </Card>
      <AlertDialog
        open={!!c}
        onOpenChange={(o) => {
          if (!o) {
            setConfirm(null);
            act.reset();
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{c && t('publishTitle', { title: c.title })}</AlertDialogTitle>
            <AlertDialogDescription>
              {c && t('publishHint', { audience: audienceText(c.audience) })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {act.isError && (
            <p role="alert" className="text-sm text-destructive">
              {message(act.error)}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={act.isPending}>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={act.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (c) act.mutate({ id: c.id, action: 'publish' });
              }}
            >
              {act.isPending ? <Spinner /> : <SendIcon />}
              {t('publish')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/**
 * «الإعلانات» (M8; the old current / all announcements): everyone with `announcements.view`
 * reads what is current for their role; `announcements.manage` also gets «إدارة الإعلانات»
 * (drafts, publish to roles, pin, end date, archive, read counts) with «إعلان جديد» in the header.
 */
export function AnnouncementsView() {
  const t = useTranslations('operations.announcements');
  const me = useCurrentUser();
  const dir = useDirection();
  const params = useListParams();
  const [editing, setEditing] = useState<AnnouncementDto | 'new' | null>(null);
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
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t('title')}
        actions={
          tab === 'manage' && (
            <Button className="h-10" onClick={() => setEditing('new')}>
              <PlusIcon />
              {t('newTitle')}
            </Button>
          )
        }
      />
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
              {v === tab && (v === 'manage' ? <Manage onEdit={setEditing} /> : <Feed />)}
            </TabsContent>
          ))}
        </Tabs>
      ) : (
        <Feed />
      )}
      {editing && (
        <AnnouncementDialog
          announcement={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
