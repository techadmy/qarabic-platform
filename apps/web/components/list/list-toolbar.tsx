'use client';

import { Button } from '@qarabic/ui/components/button';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@qarabic/ui/components/input-group';
import { Label } from '@qarabic/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@qarabic/ui/components/select';
import { Switch } from '@qarabic/ui/components/switch';
import { ToggleGroup, ToggleGroupItem } from '@qarabic/ui/components/toggle-group';
import { SearchIcon, XIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useId, type ReactNode } from 'react';

/**
 * The list-page standard (docs/15 §5.4.1, the current app's `ListPageToolbar`): one row with the
 * instant search (debounced, server-side) and the filters, then the status tabs with counts from
 * `meta.counts`. Built from shadcn InputGroup, Select, Switch and ToggleGroup.
 */
export function ListToolbar({
  search,
  filters,
  tabs,
}: {
  search: { label: string; placeholder: string; value: string; onChange: (value: string) => void };
  filters?: ReactNode;
  tabs?: ReactNode;
}) {
  const t = useTranslations('list');
  const id = useId();
  return (
    <div className="flex flex-col gap-3 border-b p-4">
      <div role="search" className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-0 flex-[1_1_18rem] flex-col gap-1.5">
          <Label htmlFor={id} className="text-[0.8125rem] text-muted-foreground">
            {search.label}
          </Label>
          <InputGroup className="h-10 bg-card">
            <InputGroupAddon>
              <SearchIcon aria-hidden />
            </InputGroupAddon>
            <InputGroupInput
              id={id}
              type="search"
              value={search.value}
              placeholder={search.placeholder}
              onChange={(e) => search.onChange(e.target.value)}
              className="md:text-[0.9375rem]"
            />
            {search.value && (
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  size="icon-xs"
                  aria-label={t('clearSearch')}
                  onClick={() => search.onChange('')}
                >
                  <XIcon />
                </InputGroupButton>
              </InputGroupAddon>
            )}
          </InputGroup>
        </div>
        {filters}
      </div>
      {tabs && <div className="-mx-1 overflow-x-auto px-1 pb-0.5">{tabs}</div>}
    </div>
  );
}

/** Status tabs with counts (K7): «الكل (42)», «منتظمة (24)» … */
export function StatusTabs({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string; count: number | undefined }[];
}) {
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      spacing={0}
      aria-label={label}
      value={value || 'all'}
      // Clicking the selected tab again keeps it (Radix would clear the value).
      onValueChange={(v) => v && onChange(v === 'all' ? '' : v)}
      className="bg-card"
    >
      {options.map((o) => (
        <ToggleGroupItem
          key={o.value || 'all'}
          value={o.value || 'all'}
          className="h-9 px-3 text-sm data-[state=on]:bg-accent data-[state=on]:font-semibold data-[state=on]:text-accent-foreground"
        >
          {o.label}
          {o.count !== undefined && <span className="tabular-nums"> ({o.count})</span>}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

/** A labelled shadcn `Select` filter in the toolbar row. */
export function FilterSelect({
  label,
  value,
  onChange,
  options,
  allLabel,
  className,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  /** First option that clears the filter. */
  allLabel?: string;
  className?: string;
}) {
  const id = useId();
  const ALL = '__all__';
  return (
    <div className={className ?? 'flex min-w-40 flex-col gap-1.5'}>
      <Label htmlFor={id} className="text-[0.8125rem] text-muted-foreground">
        {label}
      </Label>
      <Select
        value={value || (allLabel ? ALL : undefined)}
        onValueChange={(v) => onChange(v === ALL ? '' : v)}
      >
        <SelectTrigger id={id} className="h-10! w-full bg-card">
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper">
          {allLabel && <SelectItem value={ALL}>{allLabel}</SelectItem>}
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** «المحذوفة» switch (D128): archived records instead of the live ones. */
export function ArchivedSwitch({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const t = useTranslations('list');
  const id = useId();
  return (
    <div className="flex h-10 items-center gap-2">
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
      <Label htmlFor={id} className="font-medium">
        {t('archived')}
      </Label>
    </div>
  );
}

/** «مسح الكل» when a search or filter is active (docs/15 §5.4). */
export function ClearFiltersButton({ onClick }: { onClick: () => void }) {
  const t = useTranslations('list');
  return (
    <Button variant="ghost" className="h-10" onClick={onClick}>
      {t('clearAll')}
    </Button>
  );
}
