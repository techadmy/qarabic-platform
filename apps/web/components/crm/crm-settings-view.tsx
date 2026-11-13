'use client';

import {
  CRM_SHIFT_SOURCES,
  ROLES,
  SYSTEM_ROLES,
  updateCrmSettingsSchema,
  type CrmSettingsDto,
  type UpdateCrmSettingsInput,
} from '@qarabic/shared';
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
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@qarabic/ui/components/field';
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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDownIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useId, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Combobox } from '@/components/forms/fields';
import { TimeSelect } from '@/components/forms/date-time';
import { PageHeader } from '@/components/page-header';
import { useUiLocale } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { ErrorState, ForbiddenState } from '@/components/states';
import { isApiError } from '@/lib/api/client';
import { crmKeys, fetchCrmSettings, fetchLeadAssignees, updateCrmSettings } from '@/lib/api/crm';
import { can } from '@/lib/auth/use-me';
import { timeZoneOptions, zoneSearchText } from '@/lib/time';
import { useDirection } from '@/lib/use-direction';
import { useCrmError } from './crm-bits';

/**
 * «إعدادات العملاء المحتملين» (`CRM_SETTING_RULES`; `settings.view`, edit with `settings.manage`):
 * auto-assignment (pool roles, shift source, fallback owner), the first-response time and the
 * CRM working hours, the «لا يرد» suggestion and the family confirmations (off by default, D140).
 * Only changed keys are sent.
 */
export function CrmSettingsView() {
  const t = useTranslations('crm.settings');
  const me = useCurrentUser();
  const allowed = can(me, 'settings.view');
  const settings = useQuery({
    queryKey: crmKeys.settings,
    queryFn: ({ signal }) => fetchCrmSettings(signal),
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

function SwitchRow({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled: boolean;
  onChange: (v: boolean) => void;
}) {
  const id = useId();
  return (
    <Field orientation="horizontal" className="justify-between">
      <div className="flex flex-col gap-0.5">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        {hint && <FieldDescription>{hint}</FieldDescription>}
      </div>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </Field>
  );
}

/** A whole-number setting with its range (shown as the error when out of it). */
function NumberRow({
  label,
  hint,
  value,
  min,
  max,
  error,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  error?: string;
  onChange: (raw: string) => void;
}) {
  const id = useId();
  return (
    <Field data-invalid={!!error}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        dir="ltr"
        min={min}
        max={max}
        className="h-10 text-start"
        value={Number.isNaN(value) ? '' : value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={!!error}
      />
      {hint && <FieldDescription>{hint}</FieldDescription>}
      {error && <FieldError>{error}</FieldError>}
    </Field>
  );
}

/** The trial settings' number rows: key, range. */
const TRIAL_NUMBERS = [
  ['crm.trial_offer_expiry_minutes', 15, 1440],
  ['crm.trial_offer_min_hours_before', 0, 72],
  ['crm.trial_offer_max_open_claims', 1, 20],
  ['crm.trial_late_alert_minutes', 1, 60],
  ['crm.trial_stale_remind_days', 1, 60],
  ['crm.trial_stale_lost_days', 2, 180],
] as const;

/** After a failed save: the first field marked invalid gets the focus (§5.6). */
const focusFirstError = () =>
  requestAnimationFrame(() =>
    document.querySelector<HTMLElement>('#crm-settings [aria-invalid="true"]')?.focus(),
  );

function SettingsForm({ initial }: { initial: CrmSettingsDto }) {
  const t = useTranslations('crm.settings');
  const locale = useUiLocale();
  const dir = useDirection();
  const me = useCurrentUser();
  const queryClient = useQueryClient();
  const message = useCrmError();
  const readOnly = !can(me, 'settings.manage');
  const [v, setV] = useState<CrmSettingsDto>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const ids = {
    roles: useId(),
    shift: useId(),
    admin: useId(),
    minutes: useId(),
    start: useId(),
    end: useId(),
    tz: useId(),
    attempts: useId(),
  };
  const assignees = useQuery({
    queryKey: crmKeys.assignees,
    queryFn: ({ signal }) => fetchLeadAssignees(signal),
  });
  const zones = useMemo(
    () =>
      timeZoneOptions(locale).map((z) => ({
        value: z.id,
        label: `${z.city} (${z.offset})`,
        keywords: [zoneSearchText(z)],
      })),
    [locale],
  );
  const set = <K extends keyof CrmSettingsDto>(k: K, value: CrmSettingsDto[K]) =>
    setV((x) => ({ ...x, [k]: value }));
  const save = useMutation({
    mutationFn: (body: UpdateCrmSettingsInput) => updateCrmSettings(body),
    onSuccess: (data) => {
      queryClient.setQueryData(crmKeys.settings, data);
      toast.success(t('saved'));
    },
    onError: (e) => {
      // A 422 points at fields: mark them and take the focus there, like the client check.
      const fields = isApiError(e, 422) ? Object.keys(e.error?.errors ?? {}) : [];
      if (fields.length) {
        setErrors(Object.fromEntries(fields.map((k) => [k, t('invalid')])));
        focusFirstError();
        return;
      }
      toast.error(message(e));
    },
  });
  const staffRoles = ROLES.filter((r) => SYSTEM_ROLES[r].kind === 'staff');
  const roleNames = v['crm.auto_assign_roles'].map(
    (r) => (SYSTEM_ROLES as Record<string, { ar: string; en: string }>)[r]?.[locale] ?? r,
  );
  const submit = () => {
    const changed = Object.fromEntries(
      Object.entries(v).filter(
        ([k, x]) => JSON.stringify(x) !== JSON.stringify(initial[k as keyof CrmSettingsDto]),
      ),
    );
    const parsed = updateCrmSettingsSchema.safeParse(changed);
    if (!parsed.success) {
      setErrors(
        Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), t('invalid')])),
      );
      focusFirstError();
      return;
    }
    setErrors({});
    if (!Object.keys(changed).length) {
      toast.info(t('nothingChanged'));
      return;
    }
    save.mutate(parsed.data);
  };
  const num = (
    k:
      | 'crm.first_response_minutes'
      | 'crm.unanswered_attempts_suggest_lost'
      | (typeof TRIAL_NUMBERS)[number][0],
    raw: string,
  ) => set(k, raw === '' ? (Number.NaN as never) : Number(raw));

  return (
    <form
      id="crm-settings"
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <fieldset disabled={readOnly} className="flex flex-col gap-4">
        <Card className="shadow-none">
          <CardHeader className="border-b">
            <CardTitle className="text-base font-bold">
              <h2>{t('assignTitle')}</h2>
            </CardTitle>
            <CardDescription>{t('assignHint')}</CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <SwitchRow
                label={t('autoAssign')}
                checked={v['crm.auto_assign_enabled']}
                disabled={readOnly}
                onChange={(x) => set('crm.auto_assign_enabled', x)}
              />
              <Field>
                <FieldLabel htmlFor={ids.roles}>{t('roles')}</FieldLabel>
                <DropdownMenu dir={dir}>
                  <DropdownMenuTrigger asChild disabled={readOnly}>
                    <Button
                      id={ids.roles}
                      type="button"
                      variant="outline"
                      className="h-auto min-h-10 w-full justify-between text-start whitespace-normal"
                    >
                      <span>{roleNames.length ? roleNames.join('، ') : t('rolesAll')}</span>
                      <ChevronDownIcon aria-hidden />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="min-w-56">
                    {staffRoles.map((r) => (
                      <DropdownMenuCheckboxItem
                        key={r}
                        checked={v['crm.auto_assign_roles'].includes(r)}
                        onSelect={(e) => e.preventDefault()}
                        onCheckedChange={(checked) =>
                          set(
                            'crm.auto_assign_roles',
                            checked
                              ? [...v['crm.auto_assign_roles'], r]
                              : v['crm.auto_assign_roles'].filter((x) => x !== r),
                          )
                        }
                      >
                        {SYSTEM_ROLES[r][locale]}
                      </DropdownMenuCheckboxItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
                <FieldDescription>{t('rolesHint')}</FieldDescription>
              </Field>
              <div className="grid gap-4 md:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor={ids.shift}>{t('shift')}</FieldLabel>
                  <Select
                    value={v['crm.shift_source']}
                    onValueChange={(x) =>
                      set('crm.shift_source', x as CrmSettingsDto['crm.shift_source'])
                    }
                    disabled={readOnly}
                  >
                    <SelectTrigger id={ids.shift} className="h-10! w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent position="popper">
                      {CRM_SHIFT_SOURCES.map((s) => (
                        <SelectItem key={s} value={s}>
                          {t(`shiftSources.${s}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor={ids.admin}>{t('fallback')}</FieldLabel>
                  <Select
                    value={String(v['crm.lead_admin_user_id'])}
                    onValueChange={(x) => set('crm.lead_admin_user_id', Number(x))}
                    disabled={readOnly}
                  >
                    <SelectTrigger id={ids.admin} className="h-10! w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent position="popper">
                      <SelectItem value="0">{t('fallbackNone')}</SelectItem>
                      {(assignees.data ?? []).map((a) => (
                        <SelectItem key={a.id} value={String(a.id)}>
                          {a.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FieldDescription>{t('fallbackHint')}</FieldDescription>
                </Field>
              </div>
            </FieldGroup>
          </CardContent>
        </Card>

        <Card className="shadow-none">
          <CardHeader className="border-b">
            <CardTitle className="text-base font-bold">
              <h2>{t('responseTitle')}</h2>
            </CardTitle>
            <CardDescription>{t('responseHint')}</CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <div className="grid gap-4 md:grid-cols-2">
                <Field data-invalid={!!errors['crm.first_response_minutes']}>
                  <FieldLabel htmlFor={ids.minutes}>{t('firstResponse')}</FieldLabel>
                  <Input
                    id={ids.minutes}
                    type="number"
                    inputMode="numeric"
                    dir="ltr"
                    min={5}
                    max={1440}
                    className="h-10 text-start"
                    value={
                      Number.isNaN(v['crm.first_response_minutes'])
                        ? ''
                        : v['crm.first_response_minutes']
                    }
                    onChange={(e) => num('crm.first_response_minutes', e.target.value)}
                    aria-invalid={!!errors['crm.first_response_minutes']}
                  />
                  <FieldDescription>{t('firstResponseHint')}</FieldDescription>
                  {errors['crm.first_response_minutes'] && (
                    <FieldError>{t('firstResponseRange')}</FieldError>
                  )}
                </Field>
                <Field data-invalid={!!errors['crm.unanswered_attempts_suggest_lost']}>
                  <FieldLabel htmlFor={ids.attempts}>{t('suggestLost')}</FieldLabel>
                  <Input
                    id={ids.attempts}
                    type="number"
                    inputMode="numeric"
                    dir="ltr"
                    min={1}
                    max={20}
                    className="h-10 text-start"
                    value={
                      Number.isNaN(v['crm.unanswered_attempts_suggest_lost'])
                        ? ''
                        : v['crm.unanswered_attempts_suggest_lost']
                    }
                    onChange={(e) => num('crm.unanswered_attempts_suggest_lost', e.target.value)}
                    aria-invalid={!!errors['crm.unanswered_attempts_suggest_lost']}
                  />
                  <FieldDescription>{t('suggestLostHint')}</FieldDescription>
                  {errors['crm.unanswered_attempts_suggest_lost'] && (
                    <FieldError>{t('suggestLostRange')}</FieldError>
                  )}
                </Field>
              </div>
              <div className="grid gap-4 md:grid-cols-3">
                <Field>
                  <FieldLabel htmlFor={ids.start}>{t('hoursStart')}</FieldLabel>
                  <TimeSelect
                    id={ids.start}
                    value={v['crm.working_hours_start']}
                    onChange={(x) => set('crm.working_hours_start', x)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor={ids.end}>{t('hoursEnd')}</FieldLabel>
                  <TimeSelect
                    id={ids.end}
                    value={v['crm.working_hours_end']}
                    onChange={(x) => set('crm.working_hours_end', x)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor={ids.tz}>{t('hoursZone')}</FieldLabel>
                  <Combobox
                    id={ids.tz}
                    value={v['crm.working_hours_timezone']}
                    onChange={(x) => x && set('crm.working_hours_timezone', x)}
                    options={zones}
                    placeholder={t('hoursZone')}
                    searchPlaceholder={t('searchZone')}
                  />
                </Field>
              </div>
            </FieldGroup>
          </CardContent>
        </Card>

        <Card className="shadow-none">
          <CardHeader className="border-b">
            <CardTitle className="text-base font-bold">
              <h2>{t('familyTitle')}</h2>
            </CardTitle>
            <CardDescription>{t('familyHint')}</CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <SwitchRow
                label={t('trialConfirmation')}
                checked={v['crm.trial_form_confirmation']}
                disabled={readOnly}
                onChange={(x) => set('crm.trial_form_confirmation', x)}
              />
              <SwitchRow
                label={t('webConfirmation')}
                checked={v['crm.web_lead_confirmation']}
                disabled={readOnly}
                onChange={(x) => set('crm.web_lead_confirmation', x)}
              />
            </FieldGroup>
          </CardContent>
        </Card>

        {/* T3 offers + T4 follow-up (docs/33 §3.5–3.7, §4.3). */}
        <Card className="shadow-none">
          <CardHeader className="border-b">
            <CardTitle className="text-base font-bold">
              <h2>{t('trials.title')}</h2>
            </CardTitle>
            <CardDescription>{t('trials.hint')}</CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <SwitchRow
                label={t('trials.reportRequired')}
                hint={t('trials.reportRequiredHint')}
                checked={v['crm.trial_report_required']}
                disabled={readOnly}
                onChange={(x) => set('crm.trial_report_required', x)}
              />
              <SwitchRow
                label={t('trials.reminders')}
                hint={t('trials.remindersHint')}
                checked={v['crm.trial_reminders_enabled']}
                disabled={readOnly}
                onChange={(x) => set('crm.trial_reminders_enabled', x)}
              />
              <SwitchRow
                label={t('trials.familyReminders')}
                hint={t('trials.familyRemindersHint')}
                checked={v['crm.trial_family_reminders']}
                disabled={readOnly}
                onChange={(x) => set('crm.trial_family_reminders', x)}
              />
              <div className="grid gap-4 md:grid-cols-2">
                {TRIAL_NUMBERS.map(([k, min, max]) => (
                  <NumberRow
                    key={k}
                    label={t(`trials.${k.slice(10)}`)}
                    hint={t(`trials.${k.slice(10)}Hint`)}
                    value={v[k]}
                    min={min}
                    max={max}
                    error={errors[k] ? t('trials.range', { min, max }) : undefined}
                    onChange={(raw) => num(k, raw)}
                  />
                ))}
              </div>
            </FieldGroup>
          </CardContent>
        </Card>
      </fieldset>
      {readOnly ? (
        <p className="text-sm text-muted-foreground">{t('readOnly')}</p>
      ) : (
        <Button type="submit" className="self-start" disabled={save.isPending}>
          {save.isPending && <Spinner />}
          {t('save')}
        </Button>
      )}
    </form>
  );
}
