'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { loginSchema } from '@qarabic/shared';
import { Alert, AlertDescription, AlertTitle } from '@qarabic/ui/components/alert';
import { Button } from '@qarabic/ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@qarabic/ui/components/card';
import { Checkbox } from '@qarabic/ui/components/checkbox';
import { Field, FieldError, FieldGroup, FieldLabel } from '@qarabic/ui/components/field';
import { Input } from '@qarabic/ui/components/input';
import { Spinner } from '@qarabic/ui/components/spinner';
import { cn } from '@qarabic/ui/lib/utils';
import { AlertCircleIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import type { ComponentProps } from 'react';
import { Controller, useForm } from 'react-hook-form';
import type { z } from 'zod';
import { isApiError } from '@/lib/api/client';
import { useLogin } from '@/lib/auth/use-me';
import { useValidationMessages } from '@/lib/forms/validation-messages';
import { PasswordInput } from './password-input';

type LoginInput = z.input<typeof loginSchema>;
type LoginOutput = z.output<typeof loginSchema>;

/**
 * Official shadcn `login-01` form (Card + Field), wired to react-hook-form and the shared
 * `loginSchema`. The schema cleans both values with `cleanCredential`, so a password pasted with
 * invisible bidi marks still signs in.
 */
export function LoginForm({ className, ...props }: ComponentProps<'div'>) {
  const t = useTranslations('auth');
  const messages = useValidationMessages();
  const login = useLogin();
  const form = useForm<LoginInput, unknown, LoginOutput>({
    resolver: zodResolver(loginSchema, messages),
    defaultValues: { email: '', password: '', remember: true },
    // Validate on submit, then on change. Blur validation moved the links under the autofocused
    // email field while the user was clicking them (the error line shifts the layout).
    mode: 'onSubmit',
  });

  const onSubmit = form.handleSubmit((values) => login.mutate(values));

  const errorText = !login.error
    ? null
    : isApiError(login.error, 422) || isApiError(login.error, 401)
      ? t('invalidCredentials')
      : isApiError(login.error, 429)
        ? t('tooManyAttempts')
        : t('genericError');

  return (
    <div className={cn('flex flex-col gap-6', className)} {...props}>
      <Card>
        <CardHeader>
          <CardTitle>
            <h1>{t('loginTitle')}</h1>
          </CardTitle>
          <CardDescription>{t('loginDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form noValidate onSubmit={onSubmit}>
            <FieldGroup>
              {errorText && (
                <Alert variant="destructive">
                  <AlertCircleIcon />
                  <AlertTitle>{t('errorTitle')}</AlertTitle>
                  <AlertDescription>{errorText}</AlertDescription>
                </Alert>
              )}
              <Controller
                name="email"
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="email">{t('email')}</FieldLabel>
                    <Input
                      {...field}
                      id="email"
                      type="email"
                      dir="ltr"
                      autoComplete="username"
                      autoFocus
                      placeholder="name@example.com"
                      aria-invalid={fieldState.invalid}
                    />
                    {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                  </Field>
                )}
              />
              <Controller
                name="password"
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <div className="flex items-center">
                      <FieldLabel htmlFor="password">{t('password')}</FieldLabel>
                      <Link
                        href="/forgot-password"
                        className="ms-auto inline-block text-sm underline-offset-4 hover:underline"
                      >
                        {t('forgot')}
                      </Link>
                    </div>
                    <PasswordInput
                      {...field}
                      id="password"
                      autoComplete="current-password"
                      aria-invalid={fieldState.invalid}
                    />
                    {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                  </Field>
                )}
              />
              <Controller
                name="remember"
                control={form.control}
                render={({ field }) => (
                  <Field orientation="horizontal">
                    <Checkbox
                      id="remember"
                      name={field.name}
                      checked={field.value}
                      onCheckedChange={(checked) => field.onChange(checked === true)}
                    />
                    <FieldLabel htmlFor="remember" className="font-normal">
                      {t('remember')}
                    </FieldLabel>
                  </Field>
                )}
              />
              <Field>
                <Button type="submit" disabled={login.isPending}>
                  {login.isPending && <Spinner />}
                  {login.isPending ? t('loggingIn') : t('login')}
                </Button>
              </Field>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
