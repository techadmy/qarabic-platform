'use client';

import { referralSchema, type ReferralInput } from '@qarabic/shared';
import { Alert, AlertDescription } from '@qarabic/ui/components/alert';
import { Button } from '@qarabic/ui/components/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@qarabic/ui/components/dialog';
import { FieldGroup } from '@qarabic/ui/components/field';
import { Spinner } from '@qarabic/ui/components/spinner';
import { useMutation } from '@tanstack/react-query';
import { UserPlusIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { NumberField, TextareaField, TextField } from '@/components/forms/fields';
import { PhoneField } from '@/components/forms/people-fields';
import { useCurrentUser } from '@/components/shell/app-shell';
import { sendReferral } from '@/lib/api/crm';
import { can } from '@/lib/auth/use-me';
import { applyServerErrors } from '@/lib/forms/server-errors';
import { useSchemaResolver } from '@/lib/forms/validation-messages';
import { useCrmError } from './crm-bits';

type Values = {
  parentName: string;
  phone: string | null;
  email: string | null;
  childrenCount: number | null;
  message: string | null;
};

/**
 * «رشّح صديقًا» on the parent home (docs/26 §9.7): a parent sends a friend's contact; it becomes a
 * lead with source «ترشيح». The answer never says whether the family was already known.
 */
export function ReferralSection() {
  const t = useTranslations('crm.refer');
  const me = useCurrentUser();
  const [open, setOpen] = useState(false);
  if (!can(me, 'leads.refer')) return null;
  return (
    <section aria-labelledby="home-refer" className="flex flex-col gap-2">
      <h2 id="home-refer" className="text-lg font-bold">
        {t('title')}
      </h2>
      <div className="flex flex-col gap-3 rounded-lg border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-muted-foreground">{t('body')}</p>
        <Button variant="outline" className="shrink-0" onClick={() => setOpen(true)}>
          <UserPlusIcon />
          {t('open')}
        </Button>
      </div>
      {open && <ReferralDialog onClose={() => setOpen(false)} />}
    </section>
  );
}

function ReferralDialog({ onClose }: { onClose: () => void }) {
  const t = useTranslations('crm.refer');
  const tv = useTranslations('validation');
  const message = useCrmError();
  const [error, setError] = useState<string | null>(null);
  const resolver = useSchemaResolver(referralSchema);
  const form = useForm<Values>({
    resolver: resolver as never,
    mode: 'onTouched',
    defaultValues: { parentName: '', phone: null, email: null, childrenCount: null, message: null },
  });
  const send = useMutation({
    mutationFn: (body: ReferralInput) => sendReferral(body),
    onSuccess: () => {
      toast.success(t('sent'));
      onClose();
    },
    onError: (e) => {
      if (
        !applyServerErrors(form, e, (k) => tv(k), ['parentName', 'phone', 'email', 'childrenCount'])
      )
        setError(message(e));
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg" showCloseButton={false}>
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(e) =>
            void form.handleSubmit((v) => {
              setError(null);
              send.mutate(v as ReferralInput);
            })(e)
          }
        >
          <DialogHeader>
            <DialogTitle>{t('dialogTitle')}</DialogTitle>
            <DialogDescription>{t('dialogHint')}</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <TextField control={form.control} name="parentName" label={t('name')} required />
            <PhoneField control={form.control} name="phone" label={t('phone')} />
            <TextField
              control={form.control}
              name="email"
              label={t('email')}
              inputProps={{ type: 'email', dir: 'ltr' }}
            />
            <NumberField
              control={form.control}
              name="childrenCount"
              label={t('children')}
              min={1}
              max={10}
            />
            <TextareaField control={form.control} name="message" label={t('note')} />
          </FieldGroup>
          {error && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {t('cancel')}
              </Button>
            </DialogClose>
            <Button type="submit" disabled={send.isPending}>
              {send.isPending && <Spinner />}
              {t('send')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
