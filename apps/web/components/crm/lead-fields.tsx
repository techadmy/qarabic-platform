'use client';

import { Button } from '@qarabic/ui/components/button';
import { FieldGroup, FieldLegend, FieldSet } from '@qarabic/ui/components/field';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useFieldArray, type Control } from 'react-hook-form';
import { NumberField, SelectField, TextareaField, TextField } from '@/components/forms/fields';
import { CountryField, PhoneField, TimeZoneField } from '@/components/forms/people-fields';

/** The contact + children part of a lead (create dialog and the workbench «البيانات» tab). */
export type LeadFormValues = {
  parentName: string;
  phone: string | null;
  email: string | null;
  countryCode: string | null;
  timezone: string | null;
  city?: string | null;
  children: { name: string | null; age: number | null; gender: 'male' | 'female' | null }[];
  courseInterest: string | null;
  preferredTimes?: string | null;
  message?: string | null;
};

export function LeadFields({
  control,
  withCity,
  withMessage,
}: {
  control: Control<LeadFormValues>;
  withCity?: boolean;
  withMessage?: boolean;
}) {
  const t = useTranslations('crm.form');
  const children = useFieldArray({ control, name: 'children' });
  return (
    <FieldGroup>
      <TextField control={control} name="parentName" label={t('parentName')} required />
      <div className="grid gap-4 sm:grid-cols-2">
        <PhoneField control={control} name="phone" label={t('phone')} />
        <TextField
          control={control}
          name="email"
          label={t('email')}
          inputProps={{ type: 'email', dir: 'ltr', autoComplete: 'off' }}
        />
      </div>
      <p className="-mt-2 text-sm text-muted-foreground">{t('contactHint')}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <CountryField control={control} name="countryCode" label={t('country')} />
        <TimeZoneField control={control} name="timezone" label={t('timezone')} />
      </div>
      {withCity && <TextField control={control} name="city" label={t('city')} />}
      <FieldSet>
        <FieldLegend variant="label">{t('children')}</FieldLegend>
        <div className="flex flex-col gap-3">
          {children.fields.map((f, i) => (
            <div
              key={f.id}
              className="grid items-end gap-3 rounded-lg border p-3 sm:grid-cols-[1fr_6rem_8rem_auto]"
            >
              <TextField control={control} name={`children.${i}.name`} label={t('childName')} />
              <NumberField
                control={control}
                name={`children.${i}.age`}
                label={t('age')}
                min={2}
                max={99}
              />
              <SelectField
                control={control}
                name={`children.${i}.gender`}
                label={t('gender')}
                clearable
                options={[
                  { value: 'male', label: t('male') },
                  { value: 'female', label: t('female') },
                ]}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t('removeChild', { n: i + 1 })}
                onClick={() => children.remove(i)}
              >
                <Trash2Icon />
              </Button>
            </div>
          ))}
          {children.fields.length < 10 && (
            <Button
              type="button"
              variant="outline"
              className="self-start"
              onClick={() => children.append({ name: '', age: null, gender: null })}
            >
              <PlusIcon />
              {t('addChild')}
            </Button>
          )}
        </div>
      </FieldSet>
      <TextField control={control} name="courseInterest" label={t('courseInterest')} />
      {withCity && (
        <TextField control={control} name="preferredTimes" label={t('preferredTimes')} />
      )}
      {withMessage && <TextareaField control={control} name="message" label={t('message')} />}
    </FieldGroup>
  );
}

/** Form values → the API body (blank children dropped, empty strings cleared). */
export function toLeadBody(v: LeadFormValues) {
  return {
    ...v,
    children: v.children
      .filter((c) => (c.name ?? '').trim() || c.age || c.gender)
      .map((c) => ({ name: c.name?.trim() || null, age: c.age, gender: c.gender })),
  };
}
