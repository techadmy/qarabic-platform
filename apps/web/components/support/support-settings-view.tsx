'use client';

import {
  ROLES,
  SYSTEM_ROLES,
  TICKET_CATEGORIES,
  TICKET_CATEGORY_LABELS,
  TICKET_QUEUE_LABELS,
  TICKET_QUEUES,
  TICKET_SUBCATEGORIES,
  TICKET_SUBCATEGORY_LABELS,
  type SupportSettingsDto,
  type TicketQueue,
  type UpdateSupportSettingsInput,
} from '@qarabic/shared';
import { Alert, AlertDescription } from '@qarabic/ui/components/alert';
import { Button } from '@qarabic/ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@qarabic/ui/components/card';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@qarabic/ui/components/dropdown-menu';
import { Field, FieldError, FieldLabel } from '@qarabic/ui/components/field';
import { Input } from '@qarabic/ui/components/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@qarabic/ui/components/select';
import { Skeleton } from '@qarabic/ui/components/skeleton';
import { Spinner } from '@qarabic/ui/components/spinner';
import { Switch } from '@qarabic/ui/components/switch';
import { ToggleGroup, ToggleGroupItem } from '@qarabic/ui/components/toggle-group';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDownIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { TimeZoneField } from '@/components/forms/people-fields';
import { PageHeader } from '@/components/page-header';
import { useUiLocale } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { ErrorState, ForbiddenState } from '@/components/states';
import { isApiError } from '@/lib/api/client';
import { fetchRoles } from '@/lib/api/roles';
import { fetchSupportSettings, supportKeys, updateSupportSettings } from '@/lib/api/support';
import { can } from '@/lib/auth/use-me';
import { useDirection } from '@/lib/use-direction';
import { STAFF_WEEK, weekdayName } from '@/lib/schedule-time';
import { useSupportError } from '@/lib/support/errors';

const SAME = '__same__';

function RolesMenu({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string[];
  options: { value: string; label: string }[];
  disabled: boolean;
  onChange: (v: string[]) => void;
}) {
  const t = useTranslations('support.settings');
  const dir = useDirection();
  const names = value.map((v) => options.find((o) => o.value === v)?.label ?? v);
  return (
    <DropdownMenu dir={dir}>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button
          variant="outline"
          className="h-auto min-h-10 w-full justify-between text-start whitespace-normal"
        >
          <span className="sr-only">{label}: </span>
          <span>{names.length ? names.join('، ') : t('rolesNone')}</span>
          <ChevronDownIcon aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        {options.map((o) => (
          <DropdownMenuCheckboxItem
            key={o.value}
            checked={value.includes(o.value)}
            onSelect={(e) => e.preventDefault()}
            onCheckedChange={(checked) =>
              onChange(checked ? [...value, o.value] : value.filter((v) => v !== o.value))
            }
          >
            {o.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function QueueSelect({
  id,
  value,
  disabled,
  onChange,
  sameLabel,
}: {
  id: string;
  value: string;
  disabled: boolean;
  onChange: (v: string) => void;
  sameLabel?: string;
}) {
  const locale = useUiLocale();
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger id={id} className="h-10! w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper">
        {sameLabel && <SelectItem value={SAME}>{sameLabel}</SelectItem>}
        {TICKET_QUEUES.map((q) => (
          <SelectItem key={q} value={q}>
            {TICKET_QUEUE_LABELS[q][locale]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * «إعدادات الدعم» (docs/32 §5; `settings.view`, edit with `settings.manage`): the queues with
 * their member roles, restricted flag and first-reply target in working hours; the routing of
 * topics to queues; the working week. Only changed keys are sent (PUT replaces each key).
 */
export function SupportSettingsView() {
  const t = useTranslations('support.settings');
  const me = useCurrentUser();
  const allowed = can(me, 'settings.view');
  const settings = useQuery({
    queryKey: supportKeys.settings,
    queryFn: ({ signal }) => fetchSupportSettings(signal),
    enabled: allowed,
  });
  if (!allowed || isApiError(settings.error, 403)) {
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
      {settings.isError ? (
        <ErrorState onRetry={() => void settings.refetch()} />
      ) : !settings.data ? (
        <div className="flex flex-col gap-4" aria-busy="true">
          <Skeleton className="h-72" />
          <Skeleton className="h-48" />
        </div>
      ) : (
        <SettingsForm key={JSON.stringify(settings.data)} initial={settings.data} />
      )}
    </>
  );
}

type FormValues = { timezone: string };

function SettingsForm({ initial }: { initial: SupportSettingsDto }) {
  const t = useTranslations('support.settings');
  const locale = useUiLocale();
  const me = useCurrentUser();
  const queryClient = useQueryClient();
  const message = useSupportError();
  const readOnly = !can(me, 'settings.manage');
  const startId = useId();
  const endId = useId();
  const [members, setMembers] = useState(initial['support.queue_members']);
  const [restricted, setRestricted] = useState(initial['support.restricted_queues']);
  const [sla, setSla] = useState<Partial<Record<TicketQueue, string>>>(
    Object.fromEntries(
      TICKET_QUEUES.map((q) => [q, String(initial['support.sla_hours'][q] ?? '')]),
    ),
  );
  const [routing, setRouting] = useState(initial['support.queue_by_category']);
  const [days, setDays] = useState(initial['support.working_hours'].days.map(String));
  const [start, setStart] = useState(initial['support.working_hours'].start);
  const [end, setEnd] = useState(initial['support.working_hours'].end);
  const [touched, setTouched] = useState(false);
  const form = useForm<FormValues>({
    defaultValues: { timezone: initial['support.working_hours'].timezone },
  });
  const roles = useQuery({
    queryKey: ['roles', 'list'],
    queryFn: ({ signal }) => fetchRoles(signal),
    enabled: can(me, 'roles.view'),
  });
  const roleOptions = roles.data
    ? roles.data
        .filter((r) => r.kind !== 'parent' && r.kind !== 'teacher')
        .map((r) => ({
          value: r.name,
          label: locale === 'en' ? (r.labelEn ?? r.labelAr) : r.labelAr,
        }))
    : ROLES.filter(
        (r) => SYSTEM_ROLES[r].kind !== 'parent' && SYSTEM_ROLES[r].kind !== 'teacher',
      ).map((r) => ({ value: r, label: SYSTEM_ROLES[r][locale] }));

  const slaInvalid = (q: TicketQueue) => {
    const n = Number(sla[q]);
    return !(sla[q] ?? '').trim() || !Number.isFinite(n) || n <= 0 || n > 720;
  };
  const timeInvalid = !(start < end);

  const save = useMutation({
    mutationFn: (body: UpdateSupportSettingsInput) => updateSupportSettings(body),
    onSuccess: (data) => {
      queryClient.setQueryData(supportKeys.settings, data);
      toast.success(t('saved'));
    },
    onError: (e) => toast.error(message(e)),
  });

  function submit() {
    setTouched(true);
    if (TICKET_QUEUES.some(slaInvalid) || timeInvalid) return;
    const working = {
      timezone: form.getValues('timezone'),
      days: days.map(Number).sort((a, b) => a - b),
      start,
      end,
    };
    const slaHours = Object.fromEntries(TICKET_QUEUES.map((q) => [q, Number(sla[q])]));
    const next: UpdateSupportSettingsInput = {
      'support.queue_members': members,
      'support.restricted_queues': restricted,
      'support.sla_hours': slaHours,
      'support.queue_by_category': routing,
      'support.working_hours': working,
    };
    const changed = Object.fromEntries(
      Object.entries(next).filter(
        ([k, v]) =>
          JSON.stringify(v) !==
          JSON.stringify(
            k === 'support.working_hours'
              ? { ...initial[k], days: [...initial[k].days].sort((a, b) => a - b) }
              : initial[k as keyof SupportSettingsDto],
          ),
      ),
    ) as UpdateSupportSettingsInput;
    if (Object.keys(changed).length === 0) {
      toast.info(t('noChanges'));
      return;
    }
    save.mutate(changed);
  }

  return (
    <div className="flex flex-col gap-4">
      {readOnly && (
        <Alert>
          <AlertDescription>{t('readOnly')}</AlertDescription>
        </Alert>
      )}
      <Card className="shadow-none">
        <CardHeader className="border-b">
          <CardTitle className="text-base font-bold">{t('queues')}</CardTitle>
          <CardDescription>{t('membersHint')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div role="table" aria-label={t('queues')} className="flex flex-col divide-y">
            <div
              role="row"
              className="hidden gap-4 pb-2 text-sm text-muted-foreground md:grid md:grid-cols-[10rem_1fr_8rem_12rem]"
            >
              <span role="columnheader">{t('queue')}</span>
              <span role="columnheader">{t('members')}</span>
              <span role="columnheader">{t('restricted')}</span>
              <span role="columnheader">{t('sla')}</span>
            </div>
            {TICKET_QUEUES.map((q) => {
              const label = TICKET_QUEUE_LABELS[q][locale];
              const invalid = touched && slaInvalid(q);
              return (
                <div
                  role="row"
                  key={q}
                  className="grid grid-cols-1 items-center gap-3 py-3 md:grid-cols-[10rem_1fr_8rem_12rem] md:gap-4"
                >
                  <span role="rowheader" className="font-semibold">
                    {label}
                  </span>
                  <div role="cell">
                    <RolesMenu
                      label={`${t('members')} — ${label}`}
                      value={members[q] ?? []}
                      options={roleOptions}
                      disabled={readOnly}
                      onChange={(v) => setMembers({ ...members, [q]: v })}
                    />
                  </div>
                  <div role="cell" className="flex items-center gap-2">
                    <Switch
                      checked={restricted.includes(q)}
                      disabled={readOnly}
                      aria-label={`${t('restricted')} — ${label}`}
                      onCheckedChange={(on) =>
                        setRestricted(on ? [...restricted, q] : restricted.filter((x) => x !== q))
                      }
                    />
                    <span className="text-sm md:sr-only">{t('restricted')}</span>
                  </div>
                  <div role="cell">
                    <Field data-invalid={invalid}>
                      <Input
                        type="number"
                        inputMode="decimal"
                        min={1}
                        max={720}
                        dir="ltr"
                        className="h-10"
                        aria-label={`${t('sla')} — ${label}`}
                        aria-invalid={invalid}
                        disabled={readOnly}
                        value={sla[q] ?? ''}
                        onChange={(e) => setSla({ ...sla, [q]: e.target.value })}
                      />
                      {invalid && <FieldError>{t('hoursInvalid')}</FieldError>}
                    </Field>
                  </div>
                </div>
              );
            })}
          </div>
          <p className="mt-3 text-sm text-muted-foreground">{t('restrictedHint')}</p>
        </CardContent>
      </Card>

      <Card className="shadow-none">
        <CardHeader className="border-b">
          <CardTitle className="text-base font-bold">{t('routing')}</CardTitle>
          <CardDescription>{t('routingHint')}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-x-6 gap-y-5 md:grid-cols-2">
          {TICKET_CATEGORIES.map((cat) => (
            <fieldset key={cat} className="flex flex-col gap-3">
              <legend className="sr-only">{TICKET_CATEGORY_LABELS[cat][locale]}</legend>
              {[cat, ...TICKET_SUBCATEGORIES[cat].map((sub) => `${cat}.${sub}`)].map((key) => {
                const sub = key.includes('.');
                const subKey = key.split('.')[1] as keyof typeof TICKET_SUBCATEGORY_LABELS;
                const label = sub
                  ? TICKET_SUBCATEGORY_LABELS[subKey][locale]
                  : TICKET_CATEGORY_LABELS[cat][locale];
                const id = `routing-${key}`;
                return (
                  <Field key={key} className={sub ? 'border-s-2 ps-3' : undefined}>
                    <FieldLabel htmlFor={id} className={sub ? 'font-normal' : 'font-semibold'}>
                      {label}
                    </FieldLabel>
                    <QueueSelect
                      id={id}
                      value={routing[key] ?? (sub ? SAME : 'general')}
                      disabled={readOnly}
                      sameLabel={
                        sub
                          ? t('sameAsTopic', { topic: TICKET_CATEGORY_LABELS[cat][locale] })
                          : undefined
                      }
                      onChange={(v) => {
                        const next = { ...routing };
                        if (v === SAME) delete next[key];
                        else next[key] = v as TicketQueue;
                        setRouting(next);
                      }}
                    />
                  </Field>
                );
              })}
            </fieldset>
          ))}
        </CardContent>
      </Card>

      <Card className="shadow-none">
        <CardHeader className="border-b">
          <CardTitle className="text-base font-bold">{t('working')}</CardTitle>
          <CardDescription>{t('workingHint')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <TimeZoneField control={form.control} name="timezone" label={t('timezone')} required />
          <Field>
            <FieldLabel>{t('days')}</FieldLabel>
            <ToggleGroup
              type="multiple"
              variant="outline"
              spacing={0}
              value={days}
              disabled={readOnly}
              onValueChange={setDays}
              aria-label={t('days')}
              className="flex-wrap"
            >
              {STAFF_WEEK.map((d) => (
                <ToggleGroupItem
                  key={d}
                  value={String(d)}
                  className="h-9 px-3 data-[state=on]:bg-accent data-[state=on]:font-semibold data-[state=on]:text-accent-foreground"
                >
                  {weekdayName(d, locale)}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Field>
          <div className="grid max-w-md grid-cols-2 gap-3">
            <Field>
              <FieldLabel htmlFor={startId}>{t('start')}</FieldLabel>
              <Input
                id={startId}
                type="time"
                dir="ltr"
                className="h-10"
                disabled={readOnly}
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </Field>
            <Field data-invalid={touched && timeInvalid}>
              <FieldLabel htmlFor={endId}>{t('end')}</FieldLabel>
              <Input
                id={endId}
                type="time"
                dir="ltr"
                className="h-10"
                disabled={readOnly}
                value={end}
                aria-invalid={touched && timeInvalid}
                onChange={(e) => setEnd(e.target.value)}
              />
              {touched && timeInvalid && <FieldError>{t('endAfterStart')}</FieldError>}
            </Field>
          </div>
        </CardContent>
      </Card>
      {!readOnly && (
        <div className="flex justify-end">
          <Button onClick={submit} disabled={save.isPending}>
            {save.isPending && <Spinner />}
            {t('save')}
          </Button>
        </div>
      )}
    </div>
  );
}
