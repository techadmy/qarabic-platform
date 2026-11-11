'use client';

import { Button } from '@qarabic/ui/components/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@qarabic/ui/components/command';
import { Field, FieldDescription, FieldError, FieldLabel } from '@qarabic/ui/components/field';
import { Input } from '@qarabic/ui/components/input';
import { Popover, PopoverContent, PopoverTrigger } from '@qarabic/ui/components/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@qarabic/ui/components/select';
import { Textarea } from '@qarabic/ui/components/textarea';
import { cn } from '@qarabic/ui/lib/utils';
import { CheckIcon, ChevronsUpDownIcon, XIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState, type ComponentProps, type ReactNode } from 'react';
import {
  Controller,
  type Control,
  type ControllerFieldState,
  type ControllerRenderProps,
  type FieldValues,
  type Path,
} from 'react-hook-form';

/**
 * Form fields of the People and account forms: shadcn `Field` + `FieldLabel` + control +
 * `FieldError`, wired with react-hook-form `Controller` (the shadcn Form guide for RHF). Labels
 * above the fields, required marked (UX §5.6). Comboboxes are the shadcn Combobox pattern
 * (Popover + Command).
 */

type Base<T extends FieldValues> = {
  control: Control<T>;
  name: Path<T>;
  label: string;
  required?: boolean;
  description?: ReactNode;
  className?: string;
};

function Label({ id, label, required }: { id: string; label: string; required?: boolean }) {
  const t = useTranslations('form');
  return (
    <FieldLabel htmlFor={id}>
      {label}
      {required && (
        <span className="text-destructive" aria-label={t('required')}>
          *
        </span>
      )}
    </FieldLabel>
  );
}

function FieldShell<T extends FieldValues>({
  control,
  name,
  label,
  required,
  description,
  className,
  render,
}: Base<T> & {
  render: (
    field: ControllerRenderProps<T, Path<T>>,
    state: ControllerFieldState,
    id: string,
  ) => ReactNode;
}) {
  const id = `field-${String(name)}`;
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <Field data-invalid={fieldState.invalid} className={className}>
          <Label id={id} label={label} required={required} />
          {render(field, fieldState, id)}
          {description && <FieldDescription>{description}</FieldDescription>}
          {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
        </Field>
      )}
    />
  );
}

const CONTROL = 'h-10 md:text-[0.9375rem]';

export function TextField<T extends FieldValues>({
  inputProps,
  ...props
}: Base<T> & { inputProps?: ComponentProps<typeof Input> }) {
  return (
    <FieldShell
      {...props}
      render={(field, state, id) => (
        <Input
          {...field}
          value={(field.value as string | null | undefined) ?? ''}
          id={id}
          aria-invalid={state.invalid}
          aria-required={props.required}
          className={CONTROL}
          {...inputProps}
        />
      )}
    />
  );
}

/** Whole numbers (age): "" → null, digits → number, so the shared schema sees a number. */
export function NumberField<T extends FieldValues>({
  min,
  max,
  ...props
}: Base<T> & { min?: number; max?: number }) {
  return (
    <FieldShell
      {...props}
      render={(field, state, id) => (
        <Input
          ref={field.ref}
          name={field.name}
          onBlur={field.onBlur}
          id={id}
          type="number"
          inputMode="numeric"
          dir="ltr"
          min={min}
          max={max}
          value={(field.value as number | null | undefined) ?? ''}
          onChange={(e) => field.onChange(e.target.value === '' ? null : Number(e.target.value))}
          aria-invalid={state.invalid}
          className={cn(CONTROL, 'text-start')}
        />
      )}
    />
  );
}

export function DateField<T extends FieldValues>(props: Base<T>) {
  return (
    <FieldShell
      {...props}
      render={(field, state, id) => (
        <Input
          {...field}
          value={(field.value as string | null | undefined) ?? ''}
          onChange={(e) => field.onChange(e.target.value || null)}
          id={id}
          type="date"
          dir="ltr"
          aria-invalid={state.invalid}
          className={cn(CONTROL, 'text-start')}
        />
      )}
    />
  );
}

export function TextareaField<T extends FieldValues>(props: Base<T> & { rows?: number }) {
  return (
    <FieldShell
      {...props}
      render={(field, state, id) => (
        <Textarea
          {...field}
          value={(field.value as string | null | undefined) ?? ''}
          id={id}
          rows={props.rows ?? 3}
          aria-invalid={state.invalid}
          className="md:text-[0.9375rem]"
        />
      )}
    />
  );
}

/** `short`: what the closed trigger shows when the label is long (e.g. «EG +20»). */
export type Option = {
  value: string;
  label: string;
  keywords?: string[];
  hint?: string;
  short?: string;
};

/** A short fixed list (gender, language, role, status): shadcn `Select`. */
export function SelectField<T extends FieldValues>({
  options,
  placeholder,
  clearable,
  ...props
}: Base<T> & { options: Option[]; placeholder?: string; clearable?: boolean }) {
  const t = useTranslations('form');
  const NONE = '__none__';
  return (
    <FieldShell
      {...props}
      render={(field, state, id) => (
        <Select
          name={field.name}
          value={(field.value as string | null | undefined) ?? (clearable ? NONE : '')}
          onValueChange={(v) => field.onChange(v === NONE ? null : v)}
        >
          <SelectTrigger
            ref={field.ref}
            id={id}
            onBlur={field.onBlur}
            aria-invalid={state.invalid}
            className="h-10! w-full md:text-[0.9375rem]"
          >
            <SelectValue placeholder={placeholder ?? t('choose')} />
          </SelectTrigger>
          <SelectContent position="popper">
            {clearable && <SelectItem value={NONE}>{t('none')}</SelectItem>}
            {options.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    />
  );
}

/**
 * The shadcn Combobox (Popover + Command): a searchable single choice. Values are strings in the
 * list; `parse` turns the chosen one back into the form value (ids are numbers).
 */
export function Combobox({
  id,
  value,
  onChange,
  options,
  placeholder,
  searchPlaceholder,
  invalid,
  clearable,
  onBlur,
  buttonRef,
  shouldFilter = true,
  onSearch,
  loading,
  className,
  ariaLabel,
}: {
  ariaLabel?: string;
  id: string;
  value: string | null;
  onChange: (value: string | null) => void;
  options: Option[];
  placeholder: string;
  searchPlaceholder: string;
  invalid?: boolean;
  clearable?: boolean;
  onBlur?: () => void;
  buttonRef?: (el: HTMLButtonElement | null) => void;
  /** Server search: the list is already filtered (`onSearch` receives the text). */
  shouldFilter?: boolean;
  onSearch?: (text: string) => void;
  loading?: boolean;
  className?: string;
}) {
  const t = useTranslations('form');
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.value === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div className={cn('flex gap-1', className)}>
        <PopoverTrigger asChild>
          <Button
            ref={buttonRef}
            id={id}
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-invalid={invalid}
            aria-label={ariaLabel}
            onBlur={onBlur}
            className="h-10 min-w-0 flex-1 justify-between bg-transparent px-3 font-normal md:text-[0.9375rem]"
          >
            <span className={cn('truncate', !selected && 'text-muted-foreground')}>
              {selected?.short ?? selected?.label ?? placeholder}
            </span>
            <ChevronsUpDownIcon className="text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        {clearable && selected && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-10"
            aria-label={t('clear')}
            onClick={() => onChange(null)}
          >
            <XIcon />
          </Button>
        )}
      </div>
      <PopoverContent className="w-(--radix-popover-trigger-width) min-w-64 p-0" align="start">
        <Command shouldFilter={shouldFilter}>
          <CommandInput placeholder={searchPlaceholder} onValueChange={onSearch} />
          <CommandList>
            <CommandEmpty>{loading ? t('loading') : t('noMatch')}</CommandEmpty>
            <CommandGroup>
              {options.map((o) => (
                <CommandItem
                  key={o.value}
                  value={o.value}
                  keywords={[o.label, ...(o.keywords ?? [])]}
                  onSelect={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                >
                  <CheckIcon
                    className={cn('size-4', o.value === value ? 'opacity-100' : 'opacity-0')}
                  />
                  <span className="truncate">{o.label}</span>
                  {o.hint && (
                    <span className="ms-auto text-xs text-muted-foreground" dir="ltr">
                      {o.hint}
                    </span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function ComboboxField<T extends FieldValues>({
  options,
  placeholder,
  searchPlaceholder,
  numeric,
  clearable,
  ...props
}: Base<T> & {
  options: Option[];
  placeholder?: string;
  searchPlaceholder?: string;
  /** Ids: the form value is a number. */
  numeric?: boolean;
  clearable?: boolean;
}) {
  const t = useTranslations('form');
  return (
    <FieldShell
      {...props}
      render={(field, state, id) => (
        <Combobox
          id={id}
          value={field.value === null || field.value === undefined ? null : String(field.value)}
          onChange={(v) => field.onChange(v === null ? null : numeric ? Number(v) : v)}
          options={options}
          placeholder={placeholder ?? t('choose')}
          searchPlaceholder={searchPlaceholder ?? t('search')}
          invalid={state.invalid}
          clearable={clearable}
          onBlur={field.onBlur}
          buttonRef={field.ref}
        />
      )}
    />
  );
}

/** Several choices (a teacher's courses): Popover + Command with checkmarks, chosen ones listed. */
export function MultiComboboxField<T extends FieldValues>({
  options,
  ...props
}: Base<T> & { options: Option[] }) {
  const t = useTranslations('form');
  const [open, setOpen] = useState(false);
  return (
    <FieldShell
      {...props}
      render={(field, state, id) => {
        const values = ((field.value as number[] | null | undefined) ?? []).map(String);
        const chosen = options.filter((o) => values.includes(o.value));
        const toggle = (v: string) => {
          const next = values.includes(v) ? values.filter((x) => x !== v) : [...values, v];
          field.onChange(next.map(Number));
        };
        return (
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <Button
                ref={field.ref}
                id={id}
                type="button"
                variant="outline"
                role="combobox"
                aria-expanded={open}
                aria-invalid={state.invalid}
                onBlur={field.onBlur}
                className="h-auto min-h-10 w-full justify-between bg-transparent px-3 py-2 font-normal whitespace-normal md:text-[0.9375rem]"
              >
                <span className={cn('text-start', !chosen.length && 'text-muted-foreground')}>
                  {chosen.length ? chosen.map((o) => o.label).join('، ') : t('choose')}
                </span>
                <ChevronsUpDownIcon className="text-muted-foreground" />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              className="w-(--radix-popover-trigger-width) min-w-64 p-0"
              align="start"
            >
              <Command>
                <CommandInput placeholder={t('search')} />
                <CommandList>
                  <CommandEmpty>{t('noMatch')}</CommandEmpty>
                  <CommandGroup>
                    {options.map((o) => (
                      <CommandItem
                        key={o.value}
                        value={o.value}
                        keywords={[o.label]}
                        onSelect={() => toggle(o.value)}
                      >
                        <CheckIcon
                          className={cn(
                            'size-4',
                            values.includes(o.value) ? 'opacity-100' : 'opacity-0',
                          )}
                        />
                        {o.label}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        );
      }}
    />
  );
}
