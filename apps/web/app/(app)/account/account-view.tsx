'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { cleanCredential, newPasswordSchema, updateMeSchema, type Me } from '@qarabic/shared';
import { Alert, AlertDescription } from '@qarabic/ui/components/alert';
import { Button } from '@qarabic/ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@qarabic/ui/components/card';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@qarabic/ui/components/field';
import { RadioGroup, RadioGroupItem } from '@qarabic/ui/components/radio-group';
import { Spinner } from '@qarabic/ui/components/spinner';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertCircleIcon, MonitorIcon, MoonIcon, SunIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useTheme } from 'next-themes';
import { useState, useSyncExternalStore } from 'react';
import { Controller, useForm, type FieldValues } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { PasswordInput } from '@/components/auth/password-input';
import { SelectField, TextField } from '@/components/forms/fields';
import { PhoneField, TimeZoneField } from '@/components/forms/people-fields';
import { PageHeader } from '@/components/page-header';
import { useCurrentUser } from '@/components/shell/app-shell';
import { updateMe } from '@/lib/api/auth';
import { isApiError } from '@/lib/api/client';
import { meQueryKey } from '@/lib/auth/use-me';
import { applyServerErrors } from '@/lib/forms/server-errors';
import { useSchemaResolver, useValidationMessages } from '@/lib/forms/validation-messages';
import { useSwitchLocale } from '@/hooks/use-switch-locale';
import { PreferencesCard } from '@/components/operations/preferences-card';

/**
 * «حسابي» (`/account`): own name, phone, language and time zone (`PATCH /me`), the theme
 * (light / dark / system, kept on this device) and a password change with the current password.
 * Three shadcn Cards, like the settings pages of the shadcn examples.
 */
export function AccountView() {
  const t = useTranslations('account');
  const me = useCurrentUser();
  const locale = useLocale() === 'en' ? 'en' : 'ar';
  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        meta={
          <>
            <bdi dir="ltr">{me.email}</bdi>
            {me.role &&
              ` · ${locale === 'ar' ? me.role.labelAr : (me.role.labelEn ?? me.role.labelAr)}`}
          </>
        }
      />
      <div className="grid max-w-3xl gap-4">
        <ProfileCard me={me} />
        <AppearanceCard />
        <PreferencesCard />
        <PasswordCard />
      </div>
    </>
  );
}

const PROFILE_FIELDS = ['name', 'phone', 'locale', 'timezone'] as const;

function ProfileCard({ me }: { me: Me }) {
  const t = useTranslations('account');
  const tv = useTranslations('validation');
  const queryClient = useQueryClient();
  const { switchTo } = useSwitchLocale();
  const resolver = useSchemaResolver(
    updateMeSchema as unknown as z.ZodType<Record<string, unknown>, FieldValues>,
  );
  const [banner, setBanner] = useState<string | null>(null);
  const form = useForm<FieldValues, unknown, Record<string, unknown>>({
    resolver,
    mode: 'onBlur',
    reValidateMode: 'onChange',
    defaultValues: { name: me.name, phone: me.phone, locale: me.locale, timezone: me.timezone },
  });
  const save = useMutation({
    mutationFn: updateMe,
    onSuccess: (updated) => {
      queryClient.setQueryData(meQueryKey, updated);
      form.reset({
        name: updated.name,
        phone: updated.phone,
        locale: updated.locale,
        timezone: updated.timezone,
      });
      toast.success(t('saved'));
      if (updated.locale !== me.locale) switchTo(updated.locale);
    },
    onError: (error) => {
      if (applyServerErrors(form, error, (k) => tv(k), PROFILE_FIELDS))
        return setBanner(t('fixErrors'));
      setBanner(t('error'));
    },
  });
  // Read during render so react-hook-form tracks it (formState is a subscription proxy).
  const dirtyFields = form.formState.dirtyFields as Record<string, boolean>;
  const onSubmit = form.handleSubmit((values) => {
    setBanner(null);
    const dirty = dirtyFields;
    const body = Object.fromEntries(Object.entries(values).filter(([k]) => dirty[k]));
    if (Object.keys(body).length === 0) return;
    save.mutate(body);
  });
  const c = form.control;
  return (
    <Card className="shadow-none">
      <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
        <CardHeader className="border-b">
          <CardTitle className="text-base font-bold">{t('profile')}</CardTitle>
          <CardDescription>{t('profileHint')}</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup className="gap-4">
            {banner && (
              <Alert variant="destructive" role="alert">
                <AlertCircleIcon />
                <AlertDescription>{banner}</AlertDescription>
              </Alert>
            )}
            <TextField
              control={c}
              name="name"
              label={t('name')}
              required
              inputProps={{ autoComplete: 'name' }}
            />
            <PhoneField control={c} name="phone" label={t('phone')} defaultCountry="EG" />
            <div className="grid gap-4 sm:grid-cols-2">
              <SelectField
                control={c}
                name="locale"
                label={t('language')}
                options={[
                  { value: 'ar', label: 'العربية' },
                  { value: 'en', label: 'English' },
                ]}
              />
              <TimeZoneField control={c} name="timezone" label={t('timezone')} />
            </div>
          </FieldGroup>
        </CardContent>
        <CardFooter className="border-t">
          <Button type="submit" className="h-10 px-5" disabled={save.isPending}>
            {save.isPending && <Spinner />}
            {save.isPending ? t('saving') : t('save')}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

/** Theme: light, dark or the system setting (next-themes), as a shadcn RadioGroup of choice cards. */
function AppearanceCard() {
  const t = useTranslations('account');
  const { theme, setTheme } = useTheme();
  // next-themes knows the stored theme only in the browser.
  const mounted = useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false,
  );
  const options = [
    { value: 'light', label: t('themeLight'), icon: SunIcon },
    { value: 'dark', label: t('themeDark'), icon: MoonIcon },
    { value: 'system', label: t('themeSystem'), icon: MonitorIcon },
  ];
  return (
    <Card className="shadow-none">
      <CardHeader className="border-b">
        <CardTitle className="text-base font-bold">{t('appearance')}</CardTitle>
        <CardDescription>{t('appearanceHint')}</CardDescription>
      </CardHeader>
      <CardContent>
        <FieldSet>
          <FieldLegend variant="label">{t('theme')}</FieldLegend>
          <RadioGroup
            value={mounted ? (theme ?? 'system') : 'system'}
            onValueChange={setTheme}
            className="grid gap-3 sm:grid-cols-3"
          >
            {options.map((o) => (
              <FieldLabel key={o.value} htmlFor={`theme-${o.value}`}>
                <Field orientation="horizontal">
                  <RadioGroupItem value={o.value} id={`theme-${o.value}`} aria-label={o.label} />
                  <o.icon className="size-4 text-muted-foreground" aria-hidden />
                  <span className="font-medium">{o.label}</span>
                </Field>
              </FieldLabel>
            ))}
          </RadioGroup>
        </FieldSet>
      </CardContent>
    </Card>
  );
}

const passwordFormSchema = z
  .object({
    currentPassword: z.string().transform(cleanCredential).pipe(z.string().min(1)),
    password: newPasswordSchema,
    confirmation: z.string().transform(cleanCredential),
  })
  .refine((v) => v.password === v.confirmation, {
    path: ['confirmation'],
    params: { mismatch: true },
  });
type PasswordIn = z.input<typeof passwordFormSchema>;
type PasswordOut = z.output<typeof passwordFormSchema>;

function PasswordCard() {
  const t = useTranslations('account');
  const tv = useTranslations('validation');
  const messages = useValidationMessages();
  const [banner, setBanner] = useState<string | null>(null);
  const form = useForm<PasswordIn, unknown, PasswordOut>({
    resolver: zodResolver(passwordFormSchema, {
      error: (issue) => (issue.code === 'custom' ? tv('passwordsMatch') : messages.error(issue)),
    }),
    defaultValues: { currentPassword: '', password: '', confirmation: '' },
    mode: 'onSubmit',
  });
  const save = useMutation({
    mutationFn: (v: PasswordOut) =>
      updateMe({ currentPassword: v.currentPassword, password: v.password }),
    onSuccess: () => {
      form.reset();
      toast.success(t('passwordChanged'));
    },
    onError: (error) => {
      if (isApiError(error) && error.code === 'wrong_password') {
        form.setError('currentPassword', { type: 'server', message: tv('wrongPassword') });
        form.setFocus('currentPassword');
        return;
      }
      if (isApiError(error, 429)) return setBanner(t('tooMany'));
      setBanner(t('error'));
    },
  });
  const fields = [
    { name: 'currentPassword', label: t('currentPassword'), autoComplete: 'current-password' },
    {
      name: 'password',
      label: t('newPassword'),
      autoComplete: 'new-password',
      hint: t('passwordHint'),
    },
    { name: 'confirmation', label: t('confirmPassword'), autoComplete: 'new-password' },
  ] as const;
  return (
    <Card className="shadow-none">
      <form
        noValidate
        onSubmit={form.handleSubmit((v) => {
          setBanner(null);
          save.mutate(v);
        })}
        className="flex flex-col gap-4"
      >
        <CardHeader className="border-b">
          <CardTitle className="text-base font-bold">{t('password')}</CardTitle>
          <CardDescription>{t('passwordCardHint')}</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup className="gap-4">
            {banner && (
              <Alert variant="destructive" role="alert">
                <AlertCircleIcon />
                <AlertDescription>{banner}</AlertDescription>
              </Alert>
            )}
            {fields.map((f) => (
              <Controller
                key={f.name}
                name={f.name}
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor={`account-${f.name}`}>{f.label}</FieldLabel>
                    <PasswordInput
                      {...field}
                      id={`account-${f.name}`}
                      autoComplete={f.autoComplete}
                      aria-invalid={fieldState.invalid}
                    />
                    {'hint' in f && <FieldDescription>{f.hint}</FieldDescription>}
                    {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                  </Field>
                )}
              />
            ))}
          </FieldGroup>
        </CardContent>
        <CardFooter className="border-t">
          <Button type="submit" className="h-10 px-5" disabled={save.isPending}>
            {save.isPending && <Spinner />}
            {t('changePassword')}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
