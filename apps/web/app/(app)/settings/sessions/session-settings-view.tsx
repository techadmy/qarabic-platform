'use client';

import {
  SESSION_SETTING_RULES,
  sessionSettingsSchema,
  type SessionSettingKey,
  type SessionSettingsDto,
  type ZoomHostDto,
} from '@qarabic/shared';
import { Alert, AlertDescription } from '@qarabic/ui/components/alert';
import { Button } from '@qarabic/ui/components/button';
import { Card, CardContent } from '@qarabic/ui/components/card';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@qarabic/ui/components/field';
import { Input } from '@qarabic/ui/components/input';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from '@qarabic/ui/components/input-group';
import { Skeleton } from '@qarabic/ui/components/skeleton';
import { Spinner } from '@qarabic/ui/components/spinner';
import { Switch } from '@qarabic/ui/components/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@qarabic/ui/components/tabs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { AlertCircleIcon, PlusIcon, VideoIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { DataTable } from '@/components/data-table';
import { TimeZoneField } from '@/components/forms/people-fields';
import { PageHeader } from '@/components/page-header';
import { ToneBadge } from '@/components/sessions/badges';
import { ReasonDialog } from '@/components/sessions/reason-dialog';
import { useCurrentUser } from '@/components/shell/app-shell';
import { EmptyState, ErrorState, ForbiddenState } from '@/components/states';
import { isApiError } from '@/lib/api/client';
import {
  createZoomHost,
  fetchSessionSettings,
  fetchZoomHosts,
  sessionKeys,
  updateSessionSettings,
  updateZoomHost,
} from '@/lib/api/sessions';
import { can } from '@/lib/auth/use-me';
import { applyServerErrors } from '@/lib/forms/server-errors';
import { useValidationMessages } from '@/lib/forms/validation-messages';

/** Unit of each number rule (its key's suffix). */
function unitOf(key: string): 'minutes' | 'hours' | 'days' {
  if (key.endsWith('_min')) return 'minutes';
  if (key.endsWith('_hours')) return 'hours';
  return 'days';
}
/** On / off rules (shadcn `Switch`). */
const BOOLEAN_KEYS: SessionSettingKey[] = ['reports.parent_sees_rating'];
const NUMBER_KEYS = (Object.keys(SESSION_SETTING_RULES) as SessionSettingKey[]).filter(
  (k) => k !== 'academy.timezone' && !BOOLEAN_KEYS.includes(k),
);
/** The flat key as a form field name (dots would nest in react-hook-form). */
const field = (key: string) => key.replace(/\./g, '__');

/**
 * «إعدادات الحصص» (settings.view; edit with settings.manage; the current app's
 * `SessionSettingsPage`): shadcn `Tabs` with the class rules — one number per rule with its unit,
 * range and help, from `SESSION_SETTING_RULES` — and the Zoom hosts. Only changed keys are sent.
 */
export function SessionSettingsView() {
  const t = useTranslations('sessionSettings');
  const me = useCurrentUser();
  const allowed = can(me, 'settings.view');
  const canManage = can(me, 'settings.manage');
  const query = useQuery({
    queryKey: sessionKeys.settings,
    queryFn: ({ signal }) => fetchSessionSettings(signal),
    enabled: allowed,
  });
  if (!allowed || isApiError(query.error, 403)) {
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  }
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <Tabs defaultValue="rules" className="gap-4">
        <TabsList>
          <TabsTrigger value="rules">{t('tabs.rules')}</TabsTrigger>
          {canManage && <TabsTrigger value="zoom">{t('tabs.zoom')}</TabsTrigger>}
        </TabsList>
        <TabsContent value="rules">
          {query.isError ? (
            <ErrorState onRetry={() => void query.refetch()} />
          ) : query.isPending ? (
            <Skeleton className="h-96" />
          ) : (
            <RulesForm settings={query.data} editable={canManage} />
          )}
        </TabsContent>
        {canManage && (
          <TabsContent value="zoom">
            <ZoomHosts />
          </TabsContent>
        )}
      </Tabs>
    </>
  );
}

type Values = Record<string, number | string | boolean>;

function RulesForm({ settings, editable }: { settings: SessionSettingsDto; editable: boolean }) {
  const t = useTranslations('sessionSettings');
  const tv = useTranslations('validation');
  const queryClient = useQueryClient();
  const initial = useMemo(
    () => Object.fromEntries(Object.entries(settings).map(([k, v]) => [field(k), v])) as Values,
    [settings],
  );
  const messages = useValidationMessages();
  // The shared schema checks every rule (range, whole number, known zone) with our messages.
  const form = useForm<Values>({
    defaultValues: initial,
    resolver: (values) => {
      const flat = Object.fromEntries(
        Object.entries(values).map(([k, v]) => [k.replace(/__/g, '.'), v]),
      );
      const parsed = sessionSettingsSchema.safeParse(flat, messages);
      if (parsed.success) return { values, errors: {} };
      const errors: Record<string, { type: string; message: string }> = {};
      for (const issue of parsed.error.issues) {
        const name = field(String(issue.path[0] ?? ''));
        errors[name] ??= { type: issue.code, message: issue.message };
      }
      return { values: {}, errors };
    },
  });
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (changed: Record<string, unknown>) => updateSessionSettings(changed as never),
    onSuccess: (next) => {
      queryClient.setQueryData(sessionKeys.settings, next);
      form.reset(Object.fromEntries(Object.entries(next).map(([k, v]) => [field(k), v])) as Values);
      toast.success(t('saved'));
    },
    onError: (e) => {
      const mapped = applyServerErrors(
        {
          setError: (name, err) => form.setError(field(String(name)), err),
          setFocus: (name) => form.setFocus(field(String(name))),
        },
        e,
        (key) => tv(key),
        Object.keys(SESSION_SETTING_RULES),
      );
      if (!mapped) setError(t('saveFailed'));
    },
  });
  const onSubmit = form.handleSubmit((values) => {
    setError(null);
    const changed: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values)) {
      const key = k.replace(/__/g, '.');
      if (v !== initial[k]) changed[key] = v;
    }
    if (Object.keys(changed).length) save.mutate(changed);
  });

  return (
    <Card className="shadow-none">
      <CardContent>
        <form noValidate onSubmit={onSubmit} className="flex flex-col gap-6">
          <FieldGroup className="gap-0 divide-y">
            {NUMBER_KEYS.map((key) => {
              const rule = SESSION_SETTING_RULES[key] as unknown as {
                minValue: number;
                maxValue: number;
              };
              const unit = unitOf(key);
              const name = field(key);
              return (
                <Controller
                  key={key}
                  name={name}
                  control={form.control}
                  render={({ field: f, fieldState }) => (
                    <Field
                      orientation="responsive"
                      data-invalid={fieldState.invalid}
                      className="py-3 @md/field-group:grid @md/field-group:grid-cols-[1fr_12rem] @md/field-group:items-start"
                    >
                      <div className="flex flex-col gap-1">
                        <FieldLabel htmlFor={name}>{t(`rules.${name}.label`)}</FieldLabel>
                        <FieldDescription>
                          {t(`rules.${name}.help`)}{' '}
                          {t('range', {
                            min: rule.minValue,
                            max: rule.maxValue,
                            unit: t(`units.${unit}`),
                          })}
                        </FieldDescription>
                      </div>
                      <div className="flex flex-col gap-1">
                        <InputGroup className="h-10">
                          <InputGroupInput
                            id={name}
                            ref={f.ref}
                            name={f.name}
                            type="number"
                            inputMode="numeric"
                            dir="ltr"
                            min={rule.minValue}
                            max={rule.maxValue}
                            disabled={!editable}
                            value={f.value === '' || f.value === undefined ? '' : String(f.value)}
                            onChange={(e) =>
                              f.onChange(e.target.value === '' ? '' : Number(e.target.value))
                            }
                            onBlur={f.onBlur}
                            aria-invalid={fieldState.invalid}
                            className="text-start"
                          />
                          <InputGroupAddon align="inline-end">
                            <InputGroupText>{t(`units.${unit}`)}</InputGroupText>
                          </InputGroupAddon>
                        </InputGroup>
                        {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                      </div>
                    </Field>
                  )}
                />
              );
            })}
            {BOOLEAN_KEYS.map((key) => {
              const name = field(key);
              return (
                <Controller
                  key={key}
                  name={name}
                  control={form.control}
                  render={({ field: f }) => (
                    <Field
                      orientation="horizontal"
                      className="items-start justify-between gap-4 py-3"
                    >
                      <div className="flex flex-col gap-1">
                        <FieldLabel htmlFor={name}>{t(`rules.${name}.label`)}</FieldLabel>
                        <FieldDescription>{t(`rules.${name}.help`)}</FieldDescription>
                      </div>
                      <Switch
                        id={name}
                        ref={f.ref}
                        checked={!!f.value}
                        onCheckedChange={f.onChange}
                        disabled={!editable}
                      />
                    </Field>
                  )}
                />
              );
            })}
            <div className="py-3">
              <TimeZoneField
                control={form.control}
                name={field('academy.timezone')}
                label={t('rules.academy__timezone.label')}
                required
              />
            </div>
          </FieldGroup>
          {error && (
            <Alert variant="destructive" role="alert">
              <AlertCircleIcon />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {editable && (
            <div className="flex gap-2">
              <Button type="submit" disabled={!form.formState.isDirty || save.isPending}>
                {save.isPending && <Spinner />}
                {t('save')}
              </Button>
              {form.formState.isDirty && (
                <Button type="button" variant="outline" onClick={() => form.reset(initial)}>
                  {t('discard')}
                </Button>
              )}
            </div>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

function ZoomHosts() {
  const t = useTranslations('sessionSettings.zoom');
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [zoomUserId, setZoomUserId] = useState('');
  const [email, setEmail] = useState('');
  const [label, setLabel] = useState('');
  const query = useQuery({
    queryKey: sessionKeys.zoomHosts,
    queryFn: ({ signal }) => fetchZoomHosts(signal),
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: sessionKeys.zoomHosts });
  const toggle = useMutation({
    mutationFn: (h: ZoomHostDto) => updateZoomHost(h.id, { isActive: !h.isActive }),
    onSuccess: (h) => {
      refresh();
      toast.success(h.isActive ? t('activated') : t('deactivated'));
    },
    onError: () => toast.error(t('failed')),
  });
  const add = useMutation({
    mutationFn: () =>
      createZoomHost({
        zoomUserId: zoomUserId.trim(),
        email: email.trim(),
        label: label.trim() || null,
      }),
    onSuccess: () => {
      refresh();
      setAdding(false);
      setZoomUserId('');
      setEmail('');
      setLabel('');
      toast.success(t('added'));
    },
    onError: (e) => setError(isApiError(e, 422) ? t('invalid') : t('failed')),
  });
  const columns: ColumnDef<ZoomHostDto, unknown>[] = [
    {
      id: 'label',
      header: t('label'),
      cell: ({ row }) => <span className="font-semibold">{row.original.label ?? '—'}</span>,
    },
    {
      id: 'email',
      header: t('email'),
      cell: ({ row }) => <bdi dir="ltr">{row.original.email}</bdi>,
    },
    {
      id: 'user',
      header: t('userId'),
      cell: ({ row }) => <bdi dir="ltr">{row.original.zoomUserId}</bdi>,
    },
    {
      id: 'status',
      header: t('status'),
      cell: ({ row }) =>
        row.original.isActive ? (
          <ToneBadge tone="green" label={t('active')} />
        ) : (
          <ToneBadge tone="grey" label={t('inactive')} />
        ),
    },
    {
      id: 'toggle',
      header: () => <span className="sr-only">{t('toggle')}</span>,
      cell: ({ row }) => (
        <Switch
          checked={row.original.isActive}
          aria-label={t('toggleFor', { label: row.original.label ?? row.original.email })}
          disabled={toggle.isPending}
          onCheckedChange={() => toggle.mutate(row.original)}
        />
      ),
      meta: { className: 'text-end' },
    },
  ];
  return (
    <Card className="gap-0 py-0 shadow-none">
      <div className="flex items-center justify-between gap-2 border-b p-4">
        <p className="text-sm text-muted-foreground">{t('hint')}</p>
        <Button
          onClick={() => {
            setError(null);
            setAdding(true);
          }}
        >
          <PlusIcon />
          {t('add')}
        </Button>
      </div>
      {query.isError ? (
        <div className="p-4">
          <ErrorState onRetry={() => void query.refetch()} />
        </div>
      ) : !query.isPending && !query.data.length ? (
        <div className="p-4">
          <EmptyState icon={VideoIcon} title={t('empty')} description={t('emptyHint')} />
        </div>
      ) : (
        <DataTable
          bare
          columns={columns}
          data={query.data ?? []}
          label={t('title')}
          emptyText={t('empty')}
          loading={query.isPending}
        />
      )}
      <ReasonDialog
        open={adding}
        onOpenChange={setAdding}
        title={t('add')}
        confirmLabel={t('add')}
        busy={add.isPending}
        error={error}
        extra={
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="zoom-label">{t('label')}</FieldLabel>
              <Input
                id="zoom-label"
                className="h-10"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="zoom-email">{t('email')}</FieldLabel>
              <Input
                id="zoom-email"
                type="email"
                dir="ltr"
                className="h-10"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="zoom-user">{t('userId')}</FieldLabel>
              <Input
                id="zoom-user"
                dir="ltr"
                className="h-10"
                value={zoomUserId}
                onChange={(e) => setZoomUserId(e.target.value)}
              />
            </Field>
          </FieldGroup>
        }
        onConfirm={() => {
          if (!zoomUserId.trim() || !/^\S+@\S+\.\S+$/.test(email.trim())) {
            setError(t('invalid'));
            return;
          }
          add.mutate();
        }}
      />
    </Card>
  );
}
