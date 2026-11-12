'use client';

import {
  BILLING_SETTING_RULES,
  SESSION_STAGE_LABELS,
  updateBillingSettingsSchema,
  type BillingSettingsDto,
  type SessionStage,
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
import { Checkbox } from '@qarabic/ui/components/checkbox';
import { Field, FieldDescription, FieldLabel } from '@qarabic/ui/components/field';
import { Input } from '@qarabic/ui/components/input';
import { Label } from '@qarabic/ui/components/label';
import { Skeleton } from '@qarabic/ui/components/skeleton';
import { Spinner } from '@qarabic/ui/components/spinner';
import { Switch } from '@qarabic/ui/components/switch';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { InfoIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/page-header';
import { useUiLocale } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { ErrorState, ForbiddenState } from '@/components/states';
import { isApiError } from '@/lib/api/client';
import { billingKeys, fetchBillingSettings, updateBillingSettings } from '@/lib/api/billing';
import { can } from '@/lib/auth/use-me';
import { parseDayList } from '@/lib/billing/labels';
import { FormRow, NUMBER_INPUT, useBillingError } from './billing-bits';

const STAGES = BILLING_SETTING_RULES['billing.deducting_stages'].element.options as SessionStage[];

/**
 * «إعدادات الفوترة» (`GET/PUT /settings/billing`; `settings.view`, edit with `settings.manage`):
 * which class stages count against a package (B24), the automatic reminder days around the due
 * date, the default due days. Emails to parents stay off in this phase (D140): shown, not editable
 * here. Only changed keys are sent.
 */
export function BillingSettingsView() {
  const t = useTranslations('billing.settings');
  const me = useCurrentUser();
  const allowed = can(me, 'settings.view');
  const settings = useQuery({
    queryKey: billingKeys.settings,
    queryFn: ({ signal }) => fetchBillingSettings(signal),
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
          <Skeleton className="h-64" />
          <Skeleton className="h-40" />
        </div>
      ) : (
        <SettingsForm key={JSON.stringify(settings.data)} initial={settings.data} />
      )}
    </>
  );
}

function SettingsForm({ initial }: { initial: BillingSettingsDto }) {
  const t = useTranslations('billing.settings');
  const locale = useUiLocale();
  const me = useCurrentUser();
  const queryClient = useQueryClient();
  const message = useBillingError();
  const readOnly = !can(me, 'settings.manage');
  const ids = { days: useId(), due: useId(), notify: useId() };
  const [stages, setStages] = useState<string[]>(initial['billing.deducting_stages']);
  const [days, setDays] = useState(initial['billing.reminder_days'].join(', '));
  const [due, setDue] = useState(String(initial['billing.default_due_days']));
  const [touched, setTouched] = useState(false);
  const save = useMutation({
    mutationFn: updateBillingSettings,
    onSuccess: (data) => {
      queryClient.setQueryData(billingKeys.settings, data);
      toast.success(t('saved'));
    },
  });
  const dayList = parseDayList(days);
  const dueNumber = /^\d{1,2}$/.test(due.trim()) ? Number(due) : Number.NaN;
  const errors = {
    days: dayList === null || dayList.some((d) => d < -30 || d > 60) || dayList.length > 10,
    due: !(dueNumber >= 0 && dueNumber <= 90),
  };

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (errors.days || errors.due) return;
        const next = {
          'billing.deducting_stages': STAGES.filter((s) => stages.includes(s)),
          'billing.reminder_days': dayList!,
          'billing.default_due_days': dueNumber,
        };
        const changed = Object.fromEntries(
          Object.entries(next).filter(
            ([k, x]) =>
              JSON.stringify(x) !== JSON.stringify(initial[k as keyof BillingSettingsDto]),
          ),
        );
        if (!Object.keys(changed).length) {
          toast.info(t('nothingChanged'));
          return;
        }
        const parsed = updateBillingSettingsSchema.safeParse(changed);
        if (parsed.success) save.mutate(parsed.data);
      }}
    >
      <Card className="shadow-none">
        <CardHeader className="border-b">
          <CardTitle className="text-base font-bold">
            <h2>{t('usageTitle')}</h2>
          </CardTitle>
          <CardDescription>{t('usageHint')}</CardDescription>
        </CardHeader>
        <CardContent>
          <fieldset>
            <legend className="mb-3 text-sm font-medium">{t('stages')}</legend>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {STAGES.map((s) => {
                const id = `stage-${s}`;
                return (
                  <div key={s} className="flex items-center gap-2">
                    <Checkbox
                      id={id}
                      checked={stages.includes(s)}
                      disabled={readOnly}
                      onCheckedChange={(on) =>
                        setStages((xs) => (on ? [...xs, s] : xs.filter((x) => x !== s)))
                      }
                    />
                    <Label htmlFor={id} className="font-medium">
                      {SESSION_STAGE_LABELS[s]?.[locale] ?? s}
                    </Label>
                  </div>
                );
              })}
            </div>
          </fieldset>
        </CardContent>
      </Card>

      <Card className="shadow-none">
        <CardHeader className="border-b">
          <CardTitle className="text-base font-bold">
            <h2>{t('remindersTitle')}</h2>
          </CardTitle>
          <CardDescription>{t('remindersHint')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <FormRow
              id={ids.days}
              label={t('reminderDays')}
              error={touched && errors.days ? t('reminderDaysInvalid') : null}
              hint={t('reminderDaysHint')}
            >
              <Input
                id={ids.days}
                dir="ltr"
                value={days}
                disabled={readOnly}
                onChange={(e) => setDays(e.target.value)}
                aria-invalid={touched && errors.days}
                className={NUMBER_INPUT}
              />
            </FormRow>
            <FormRow
              id={ids.due}
              label={t('defaultDueDays')}
              error={touched && errors.due ? t('defaultDueDaysInvalid') : null}
              hint={t('defaultDueDaysHint')}
            >
              <Input
                id={ids.due}
                inputMode="numeric"
                dir="ltr"
                value={due}
                disabled={readOnly}
                onChange={(e) => setDue(e.target.value)}
                aria-invalid={touched && errors.due}
                className={NUMBER_INPUT}
              />
            </FormRow>
          </div>
          <Field orientation="horizontal" className="justify-between rounded-lg border p-3">
            <div className="flex flex-col gap-0.5">
              <FieldLabel htmlFor={ids.notify}>{t('notifyParents')}</FieldLabel>
              <FieldDescription>{t('notifyParentsHint')}</FieldDescription>
            </div>
            <Switch id={ids.notify} checked={initial['billing.notify_parents']} disabled />
          </Field>
          {!initial['billing.notify_parents'] && (
            <Alert>
              <InfoIcon />
              <AlertDescription>{t('notifyOff')}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {save.isError && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{message(save.error)}</AlertDescription>
        </Alert>
      )}
      {!readOnly && (
        <Button type="submit" className="h-10 self-start" disabled={save.isPending}>
          {save.isPending && <Spinner />}
          {t('save')}
        </Button>
      )}
    </form>
  );
}
