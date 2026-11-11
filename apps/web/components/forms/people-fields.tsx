'use client';

import { countryList, countryName } from '@qarabic/shared';
import { Field, FieldDescription, FieldError, FieldLabel } from '@qarabic/ui/components/field';
import { Input } from '@qarabic/ui/components/input';
import { useQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { Controller, type Control, type FieldValues, type Path } from 'react-hook-form';
import { fetchPeopleList, fetchPerson } from '@/lib/api/people';
import { peopleKeys } from '@/lib/people/use-person-actions';
import { DIAL_CODES, joinE164, splitE164 } from '@/lib/phone';
import { timeZoneOptions, zoneSearchText } from '@/lib/time';
import { Combobox, ComboboxField, type Option } from './fields';

type Base<T extends FieldValues> = {
  control: Control<T>;
  name: Path<T>;
  label: string;
  required?: boolean;
  className?: string;
};

function useUiLocale(): 'ar' | 'en' {
  return useLocale() === 'en' ? 'en' : 'ar';
}

/** Every country, named in the UI language, searchable in both languages and by code. */
export function useCountryOptions(): Option[] {
  const locale = useUiLocale();
  return useMemo(
    () =>
      countryList()
        .map((c) => ({
          value: c.code,
          label: locale === 'ar' ? c.nameAr : c.nameEn,
          keywords: [c.nameAr, c.nameEn, c.code],
        }))
        .sort((a, b) => a.label.localeCompare(b.label, locale)),
    [locale],
  );
}

export function CountryField<T extends FieldValues>(props: Base<T>) {
  const t = useTranslations('form');
  const options = useCountryOptions();
  return (
    <ComboboxField
      {...props}
      options={options}
      clearable={!props.required}
      placeholder={t('chooseCountry')}
      searchPlaceholder={t('searchCountry')}
    />
  );
}

/** Time zones searchable by city in Arabic or English, IANA id or offset (UX §5.6). */
export function TimeZoneField<T extends FieldValues>(props: Base<T>) {
  const t = useTranslations('form');
  const locale = useUiLocale();
  const options = useMemo(
    () =>
      timeZoneOptions(locale).map((z) => ({
        value: z.id,
        label: `${z.city} (${z.offset})`,
        keywords: [zoneSearchText(z)],
      })),
    [locale],
  );
  return (
    <ComboboxField
      {...props}
      options={options}
      clearable={!props.required}
      placeholder={t('chooseTimeZone')}
      searchPlaceholder={t('searchTimeZone')}
      description={t('timeZoneHelp')}
    />
  );
}

/**
 * Phone with the country calling code (UX §5.6): code picker + national number, kept in the form
 * as E.164 ("+447700900123"), which the shared `phoneSchema` validates.
 */
export function PhoneField<T extends FieldValues>({
  control,
  name,
  label,
  required,
  defaultCountry,
  className,
}: Base<T> & { defaultCountry?: string | null }) {
  const t = useTranslations('form');
  const locale = useUiLocale();
  const dialOptions = useMemo(
    () =>
      Object.entries(DIAL_CODES)
        .map(([code, dial]) => ({
          value: code,
          label: `${countryName(code, locale)} (+${dial})`,
          short: `${code} +${dial}`,
          keywords: [countryName(code, 'ar'), countryName(code, 'en'), code, `+${dial}`, dial],
        }))
        .sort((a, b) => a.label.localeCompare(b.label, locale)),
    [locale],
  );
  const id = `field-${String(name)}`;
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <PhoneControl
          id={id}
          label={label}
          required={required}
          className={className}
          value={(field.value as string | null | undefined) ?? ''}
          onChange={(v) => field.onChange(v === '' && !required ? null : v)}
          onBlur={field.onBlur}
          inputRef={field.ref}
          invalid={fieldState.invalid}
          error={fieldState.error}
          defaultCountry={defaultCountry ?? null}
          dialOptions={dialOptions}
          dialLabel={t('dialCode')}
          help={t('phoneHelp')}
          searchPlaceholder={t('searchCountry')}
        />
      )}
    />
  );
}

function PhoneControl({
  id,
  label,
  required,
  className,
  value,
  onChange,
  onBlur,
  inputRef,
  invalid,
  error,
  defaultCountry,
  dialOptions,
  dialLabel,
  help,
  searchPlaceholder,
}: {
  id: string;
  label: string;
  required?: boolean;
  className?: string;
  value: string;
  onChange: (value: string) => void;
  onBlur: () => void;
  inputRef: (el: HTMLInputElement | null) => void;
  invalid: boolean;
  error?: { message?: string };
  defaultCountry: string | null;
  dialOptions: Option[];
  dialLabel: string;
  help: string;
  searchPlaceholder: string;
}) {
  const t = useTranslations('form');
  const [parts, setParts] = useState(() => splitE164(value, defaultCountry));
  const [lastValue, setLastValue] = useState(value);
  if (value !== lastValue) {
    // The form reset or filled the value: follow it unless it is what we produced.
    setLastValue(value);
    if (value !== joinE164(parts.country, parts.national))
      setParts(splitE164(value, defaultCountry));
  }
  const update = (next: { country: string | null; national: string }) => {
    setParts(next);
    const joined = joinE164(next.country, next.national);
    setLastValue(joined);
    onChange(joined);
  };
  return (
    <Field data-invalid={invalid} className={className}>
      <FieldLabel htmlFor={id}>
        {label}
        {required && (
          <span className="text-destructive" aria-label={t('required')}>
            *
          </span>
        )}
      </FieldLabel>
      <div className="flex gap-2" dir="ltr">
        <Combobox
          id={`${id}-dial`}
          value={parts.country}
          onChange={(country) => update({ ...parts, country })}
          options={dialOptions}
          placeholder={dialLabel}
          searchPlaceholder={searchPlaceholder}
          ariaLabel={dialLabel}
          className="w-36 shrink-0"
        />
        <Input
          ref={inputRef}
          id={id}
          type="tel"
          inputMode="tel"
          autoComplete="tel-national"
          dir="ltr"
          value={parts.national}
          onChange={(e) => update({ ...parts, national: e.target.value })}
          onBlur={onBlur}
          aria-invalid={invalid}
          aria-required={required}
          aria-describedby={`${id}-help`}
          className="h-10 min-w-0 flex-1 md:text-[0.9375rem]"
        />
      </div>
      <FieldDescription id={`${id}-help`}>
        {help}
        {parts.country && DIAL_CODES[parts.country] && (
          <>
            {' '}
            <bdi dir="ltr">(+{DIAL_CODES[parts.country]})</bdi>
          </>
        )}
      </FieldDescription>
      {invalid && <FieldError errors={[error]} />}
    </Field>
  );
}

/** Family picker with server search (there are thousands of families). */
export function FamilyField<T extends FieldValues>(props: Base<T>) {
  const t = useTranslations('form');
  const [search, setSearch] = useState('');
  const query = useQuery({
    queryKey: peopleKeys.list('families', { q: search, perPage: 20, picker: true }),
    queryFn: ({ signal }) =>
      fetchPeopleList(
        'families',
        { q: search || undefined, perPage: 20, sort: 'parentName' },
        signal,
      ),
    placeholderData: (previous) => previous,
  });
  return (
    <Controller
      control={props.control}
      name={props.name}
      render={({ field, fieldState }) => (
        <FamilyPicker
          {...props}
          value={(field.value as number | null | undefined) ?? null}
          onChange={field.onChange}
          onBlur={field.onBlur}
          buttonRef={field.ref}
          invalid={fieldState.invalid}
          error={fieldState.error}
          rows={query.data?.data ?? []}
          loading={query.isFetching}
          onSearch={setSearch}
          placeholder={t('chooseFamily')}
          searchPlaceholder={t('familyHelp')}
        />
      )}
    />
  );
}

function FamilyPicker({
  name,
  label,
  required,
  className,
  value,
  onChange,
  onBlur,
  buttonRef,
  invalid,
  error,
  rows,
  loading,
  onSearch,
  placeholder,
  searchPlaceholder,
}: {
  name: string;
  label: string;
  required?: boolean;
  className?: string;
  value: number | null;
  onChange: (v: number | null) => void;
  onBlur: () => void;
  buttonRef: (el: HTMLButtonElement | null) => void;
  invalid: boolean;
  error?: { message?: string };
  rows: { id: number; parentName: string; email: string }[];
  loading: boolean;
  onSearch: (text: string) => void;
  placeholder: string;
  searchPlaceholder: string;
}) {
  const t = useTranslations('form');
  // The chosen family may not be in the current search page: fetch its name once.
  const chosen = useQuery({
    queryKey: peopleKeys.detail('families', value ?? 0),
    queryFn: ({ signal }) => fetchPerson('families', value!, signal),
    enabled: value !== null && !rows.some((r) => r.id === value),
  });
  const options: Option[] = rows.map((r) => ({
    value: String(r.id),
    label: r.parentName,
    hint: r.email,
  }));
  if (value !== null && !options.some((o) => o.value === String(value)) && chosen.data) {
    options.unshift({
      value: String(value),
      label: chosen.data.parentName,
      hint: chosen.data.email,
    });
  }
  const id = `field-${name}`;
  return (
    <Field data-invalid={invalid} className={className}>
      <FieldLabel htmlFor={id}>
        {label}
        {required && (
          <span className="text-destructive" aria-label={t('required')}>
            *
          </span>
        )}
      </FieldLabel>
      <Combobox
        id={id}
        value={value === null ? null : String(value)}
        onChange={(v) => onChange(v === null ? null : Number(v))}
        options={options}
        placeholder={placeholder}
        searchPlaceholder={searchPlaceholder}
        invalid={invalid}
        onBlur={onBlur}
        buttonRef={buttonRef}
        shouldFilter={false}
        onSearch={onSearch}
        loading={loading}
      />
      {invalid && <FieldError errors={[error]} />}
    </Field>
  );
}
