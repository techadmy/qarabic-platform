'use client';

import {
  createLeadSchema,
  LEAD_SOURCE_LABELS,
  MANUAL_LEAD_SOURCES,
  type CreateLeadInput,
} from '@qarabic/shared';
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
import { Spinner } from '@qarabic/ui/components/spinner';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm, type Control } from 'react-hook-form';
import { toast } from 'sonner';
import { SelectField } from '@/components/forms/fields';
import { useUiLocale, useViewerTz } from '@/components/sessions/times';
import { createLead, crmKeys } from '@/lib/api/crm';
import { applyServerErrors } from '@/lib/forms/server-errors';
import { useSchemaResolver } from '@/lib/forms/validation-messages';
import { useCrmError } from './crm-bits';
import { LeadFields, toLeadBody, type LeadFormValues } from './lead-fields';

type Values = LeadFormValues & { source: (typeof MANUAL_LEAD_SOURCES)[number] | null };
const FIELDS = [
  'parentName',
  'phone',
  'email',
  'countryCode',
  'timezone',
  'children',
  'courseInterest',
  'source',
];

/** «طلب جديد» (docs/26 §9.2): a lead from a call, WhatsApp or a visit; assigned to whoever adds it. */
export function NewLeadDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('crm.form');
  const tv = useTranslations('validation');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const router = useRouter();
  const queryClient = useQueryClient();
  const message = useCrmError();
  const [error, setError] = useState<string | null>(null);
  const resolver = useSchemaResolver(createLeadSchema);
  const form = useForm<Values>({
    resolver: resolver as never,
    mode: 'onTouched',
    defaultValues: {
      parentName: '',
      phone: null,
      email: null,
      countryCode: null,
      timezone: tz,
      children: [{ name: '', age: null, gender: null }],
      courseInterest: null,
      source: 'phone',
    },
  });
  const create = useMutation({
    mutationFn: (body: CreateLeadInput) => createLead(body),
    onSuccess: (lead) => {
      void queryClient.invalidateQueries({ queryKey: crmKeys.all });
      toast.success(t('created'));
      onOpenChange(false);
      router.push(`/leads/${lead.id}`);
    },
    onError: (e) => {
      if (!applyServerErrors(form, e, (k) => tv(k), FIELDS)) setError(message(e));
    },
  });
  const submit = form.handleSubmit((v) => {
    setError(null);
    create.mutate(toLeadBody(v) as unknown as CreateLeadInput);
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl" showCloseButton={false}>
        <form noValidate onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t('newTitle')}</DialogTitle>
            <DialogDescription>{t('newHint')}</DialogDescription>
          </DialogHeader>
          <SelectField
            control={form.control}
            name="source"
            label={t('source')}
            required
            options={MANUAL_LEAD_SOURCES.map((s) => ({
              value: s,
              label: LEAD_SOURCE_LABELS[s][locale],
            }))}
          />
          <LeadFields control={form.control as unknown as Control<LeadFormValues>} />
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
            <Button type="submit" disabled={create.isPending}>
              {create.isPending && <Spinner />}
              {t('create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
