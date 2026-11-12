'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { forgotPasswordSchema } from '@qarabic/shared';
import { Alert, AlertDescription, AlertTitle } from '@qarabic/ui/components/alert';
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
import { Spinner } from '@qarabic/ui/components/spinner';
import { useMutation } from '@tanstack/react-query';
import { AlertCircleIcon, MailCheckIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { Controller, useForm } from 'react-hook-form';
import type { z } from 'zod';
import { forgotPassword } from '@/lib/api/auth';
import { isApiError } from '@/lib/api/client';
import { useValidationMessages } from '@/lib/forms/validation-messages';
import { AUTH_CARD_CLASS, AuthCardHeader } from './auth-page';

const forgotSchema = forgotPasswordSchema;
type ForgotInput = z.input<typeof forgotSchema>;
type ForgotOutput = z.output<typeof forgotSchema>;

/** Same block family as the login form (shadcn `login-01` Card + Field). */
export function ForgotPasswordForm() {
  const t = useTranslations('auth');
  const messages = useValidationMessages();
  const mutation = useMutation({ mutationFn: (v: ForgotOutput) => forgotPassword(v.email) });
  const form = useForm<ForgotInput, unknown, ForgotOutput>({
    resolver: zodResolver(forgotSchema, messages),
    defaultValues: { email: '' },
    // Validate on submit, then on change. Blur validation moved the links under the autofocused
    // email field while the user was clicking them (the error line shifts the layout).
    mode: 'onSubmit',
  });

  return (
    <div className="flex flex-col gap-6">
      <Card className={AUTH_CARD_CLASS}>
        <AuthCardHeader title={t('forgotTitle')} description={t('forgotHint')} />
        <CardContent>
          {mutation.isSuccess ? (
            <FieldGroup>
              <Alert>
                <MailCheckIcon />
                <AlertTitle>{t('linkSentTitle')}</AlertTitle>
                <AlertDescription>{t('linkSent')}</AlertDescription>
              </Alert>
              <FieldDescription className="text-center">
                <Link href="/login">{t('backToLogin')}</Link>
              </FieldDescription>
            </FieldGroup>
          ) : (
            <form noValidate onSubmit={form.handleSubmit((v) => mutation.mutate(v))}>
              <FieldGroup>
                {mutation.isError && (
                  <Alert variant="destructive">
                    <AlertCircleIcon />
                    <AlertDescription>
                      {isApiError(mutation.error, 429) ? t('tooManyAttempts') : t('genericError')}
                    </AlertDescription>
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
                        autoComplete="email"
                        autoFocus
                        placeholder="name@example.com"
                        className="h-10 md:text-body"
                        aria-invalid={fieldState.invalid}
                      />
                      {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                    </Field>
                  )}
                />
                <Field>
                  <Button
                    type="submit"
                    className="h-11 text-body font-semibold"
                    disabled={mutation.isPending}
                  >
                    {mutation.isPending && <Spinner />}
                    {mutation.isPending ? t('sending') : t('sendLink')}
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
