'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { cleanCredential, newPasswordSchema, resetPasswordSchema } from '@qarabic/shared';
import { Alert, AlertDescription, AlertTitle } from '@qarabic/ui/components/alert';
import { Button } from '@qarabic/ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@qarabic/ui/components/card';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@qarabic/ui/components/field';
import { Spinner } from '@qarabic/ui/components/spinner';
import { useMutation } from '@tanstack/react-query';
import { AlertCircleIcon, CircleCheckIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { resetPassword } from '@/lib/api/auth';
import { isApiError } from '@/lib/api/client';
import { useValidationMessages } from '@/lib/forms/validation-messages';
import { PasswordInput } from './password-input';

export const PASSWORD_MIN = 8;

/**
 * The shared `newPasswordSchema` (8–128, cleaned) validates the password; the confirmation is a
 * client-side check only. The API receives `{ token, password }` (`resetPasswordSchema`).
 */
const resetFormSchema = z
  .object({ password: newPasswordSchema, confirmation: z.string().transform(cleanCredential) })
  .refine((v) => v.password === v.confirmation, {
    path: ['confirmation'],
    params: { mismatch: true },
  });
type ResetFormInput = z.input<typeof resetFormSchema>;
type ResetFormOutput = z.output<typeof resetFormSchema>;

/** The API rejects a used, expired or unknown token with 422 `invalid_reset_token`. */
function isInvalidToken(error: unknown): boolean {
  return (
    isApiError(error, 422) && (error.code === 'invalid_reset_token' || !!error.error?.errors?.token)
  );
}

/** Same block family as the login form (shadcn `login-01` Card + Field). */
export function ResetPasswordForm({ token }: { token: string }) {
  const t = useTranslations('auth');
  const tv = useTranslations('validation');
  const messages = useValidationMessages();
  const mutation = useMutation({
    mutationFn: (v: ResetFormOutput) =>
      resetPassword(resetPasswordSchema.parse({ token, password: v.password })),
  });
  const form = useForm<ResetFormInput, unknown, ResetFormOutput>({
    resolver: zodResolver(resetFormSchema, {
      error: (issue) => (issue.code === 'custom' ? tv('passwordsMatch') : messages.error(issue)),
    }),
    defaultValues: { password: '', confirmation: '' },
    // Validate on submit, then on change. Blur validation moved the links under the autofocused
    // field while the user was clicking them (the error line shifts the layout).
    mode: 'onSubmit',
  });

  const linkMalformed = !resetPasswordSchema.shape.token.safeParse(token).success;
  const linkInvalid = linkMalformed || isInvalidToken(mutation.error);

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>
            <h1>{t('resetTitle')}</h1>
          </CardTitle>
          <CardDescription>{t('resetHint')}</CardDescription>
        </CardHeader>
        <CardContent>
          {mutation.isSuccess ? (
            <FieldGroup>
              <Alert>
                <CircleCheckIcon />
                <AlertTitle>{t('resetDoneTitle')}</AlertTitle>
                <AlertDescription>{t('resetDone')}</AlertDescription>
              </Alert>
              <Button asChild>
                <Link href="/login">{t('login')}</Link>
              </Button>
            </FieldGroup>
          ) : (
            <form noValidate onSubmit={form.handleSubmit((v) => mutation.mutate(v))}>
              <FieldGroup>
                {linkInvalid ? (
                  <Alert variant="destructive">
                    <AlertCircleIcon />
                    <AlertDescription>
                      <p>
                        {t('resetInvalidLink')}{' '}
                        <Link href="/forgot-password">{t('requestNewLink')}</Link>
                      </p>
                    </AlertDescription>
                  </Alert>
                ) : (
                  mutation.isError && (
                    <Alert variant="destructive">
                      <AlertCircleIcon />
                      <AlertDescription>
                        {isApiError(mutation.error, 429) ? t('tooManyAttempts') : t('genericError')}
                      </AlertDescription>
                    </Alert>
                  )
                )}
                <Controller
                  name="password"
                  control={form.control}
                  render={({ field, fieldState }) => (
                    <Field data-invalid={fieldState.invalid}>
                      <FieldLabel htmlFor="password">{t('newPassword')}</FieldLabel>
                      <PasswordInput
                        {...field}
                        id="password"
                        autoComplete="new-password"
                        autoFocus
                        aria-invalid={fieldState.invalid}
                      />
                      {fieldState.invalid ? (
                        <FieldError errors={[fieldState.error]} />
                      ) : (
                        <FieldDescription>
                          {tv('passwordMin', { count: PASSWORD_MIN })}
                        </FieldDescription>
                      )}
                    </Field>
                  )}
                />
                <Controller
                  name="confirmation"
                  control={form.control}
                  render={({ field, fieldState }) => (
                    <Field data-invalid={fieldState.invalid}>
                      <FieldLabel htmlFor="confirmation">{t('confirmPassword')}</FieldLabel>
                      <PasswordInput
                        {...field}
                        id="confirmation"
                        autoComplete="new-password"
                        aria-invalid={fieldState.invalid}
                      />
                      {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                    </Field>
                  )}
                />
                <Field>
                  <Button type="submit" disabled={mutation.isPending || linkMalformed}>
                    {mutation.isPending && <Spinner />}
                    {mutation.isPending ? t('saving') : t('resetSubmit')}
                  </Button>
                  <FieldDescription className="text-center">
                    <Link href="/login">{t('backToLogin')}</Link>
                  </FieldDescription>
                </Field>
              </FieldGroup>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
