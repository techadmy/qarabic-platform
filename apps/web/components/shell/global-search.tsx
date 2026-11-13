'use client';

import {
  Command,
  CommandDialog,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@qarabic/ui/components/command';
import { Button } from '@qarabic/ui/components/button';
import { Kbd } from '@qarabic/ui/components/kbd';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@qarabic/ui/components/select';
import { useQuery } from '@tanstack/react-query';
import { SearchIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { SPLIT_VIEW_QUERY } from '@/components/list/split-view';
import { useCurrentUser } from '@/components/shell/app-shell';
import { useViewerTz } from '@/components/sessions/times';
import { fetchInvoices } from '@/lib/api/billing';
import { fetchLeads } from '@/lib/api/crm';
import { fetchPeopleList } from '@/lib/api/people';
import { useDirection } from '@/lib/use-direction';
import {
  allowedSections,
  defaultSection,
  isPeopleSection,
  isSearchShortcut,
  type SearchSection,
} from '@/lib/search/sections';

type Hit = { id: number; title: string; sub: string; href: string };
const PER_SECTION = 8;

async function search(
  section: SearchSection,
  q: string,
  tz: string,
  signal: AbortSignal,
): Promise<Hit[]> {
  if (isPeopleSection(section)) {
    const res = await fetchPeopleList(section, { q, perPage: PER_SECTION }, signal);
    return res.data.map((x) => {
      const r = x as { id: number; name?: string; parentName?: string; email?: string | null };
      const family = (x as { family?: { parentName?: string } }).family?.parentName;
      return {
        id: r.id,
        title: r.name ?? r.parentName ?? '',
        sub: family ?? r.email ?? '',
        href: `/${section}/${r.id}`,
      };
    });
  }
  if (section === 'leads') {
    const res = await fetchLeads({ q, status: 'all', tz, page: 1, perPage: PER_SECTION }, signal);
    const wide = window.matchMedia(SPLIT_VIEW_QUERY).matches;
    return res.data.map((x) => ({
      id: x.id,
      title: x.parentName,
      sub: x.phone ?? x.email ?? '',
      // Opens in the list's split view when there is room (D141 §1).
      href: wide ? `/leads?status=all&id=${x.id}` : `/leads/${x.id}`,
    }));
  }
  const res = await fetchInvoices({ q, page: 1, perPage: PER_SECTION }, signal);
  return res.data.map((x) => ({
    id: x.id,
    title: x.number ?? `#${x.id}`,
    sub: x.family.name,
    href: `/invoices/${x.id}`,
  }));
}

/**
 * The top-bar search (D141 §5): scoped to the current section by default, a section picker beside
 * the field, `/` opens it from anywhere (not while typing). shadcn `CommandDialog`; results come
 * from each list's own server search and open the record (leads in the split view when wide).
 */
export function GlobalSearch() {
  const t = useTranslations('search');
  const tn = useTranslations('nav');
  const me = useCurrentUser();
  const pathname = usePathname();
  const router = useRouter();
  const dir = useDirection();
  const tz = useViewerTz();
  const allowed = allowedSections(me.permissions);
  const here = defaultSection(pathname, allowed);
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<SearchSection | null>(here);
  const [input, setInput] = useState('');
  const [q, setQ] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!here || !isSearchShortcut(e)) return;
      e.preventDefault();
      setSection(here);
      setOpen(true);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [here]);
  useEffect(() => {
    const timer = setTimeout(() => setQ(input.trim()), 250);
    return () => clearTimeout(timer);
  }, [input]);

  const hits = useQuery({
    queryKey: ['search', section, q, tz],
    queryFn: ({ signal }) => search(section!, q, tz, signal),
    enabled: open && !!section && q.length >= 2,
  });

  if (!here) return null;
  const scopeLabel = tn(section ?? here);
  const openIt = () => {
    setSection(here);
    setOpen(true);
  };

  return (
    <>
      <Button
        variant="outline"
        onClick={openIt}
        aria-keyshortcuts="/"
        aria-label={t('trigger', { section: tn(here) })}
        className="size-9 px-0 text-muted-foreground xl:w-64 xl:justify-start xl:px-3"
      >
        <SearchIcon />
        <span className="hidden truncate xl:inline">{t('trigger', { section: tn(here) })}</span>
        <Kbd className="ms-auto hidden xl:inline-flex">/</Kbd>
      </Button>
      <CommandDialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) {
            setInput('');
            setQ('');
          }
        }}
        title={t('title')}
        description={t('description')}
        className="sm:max-w-xl"
        contentProps={{
          // The dialog would focus its first control (the section picker); `/` is for the field.
          onOpenAutoFocus: (e) => {
            e.preventDefault();
            inputRef.current?.focus();
          },
        }}
      >
        <Command
          shouldFilter={false}
          // cmdk names its input from this label.
          label={t('placeholder', { section: scopeLabel })}
        >
          <div className="flex items-center gap-2 p-1 pb-0">
            <Select
              dir={dir}
              value={section ?? here}
              onValueChange={(v) => setSection(v as SearchSection)}
            >
              <SelectTrigger aria-label={t('section')} size="sm" className="shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                {allowed.map((s) => (
                  <SelectItem key={s} value={s}>
                    {tn(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="min-w-0 flex-1 [&_[data-slot=command-input-wrapper]]:p-0">
              <CommandInput
                ref={inputRef}
                value={input}
                onValueChange={setInput}
                placeholder={t('placeholder', { section: scopeLabel })}
              />
            </div>
          </div>
          {/* The listbox holds only results (axe); hints and states sit after it. */}
          <CommandList label={t('results', { section: scopeLabel })}>
            {!!hits.data?.length && q.length >= 2 && (
              <CommandGroup heading={scopeLabel}>
                {hits.data.map((h) => (
                  <CommandItem
                    key={h.id}
                    value={String(h.id)}
                    onSelect={() => {
                      setOpen(false);
                      setInput('');
                      router.push(h.href);
                    }}
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate font-medium">{h.title}</span>
                      {h.sub && (
                        <bdi className="truncate text-caption text-muted-foreground">{h.sub}</bdi>
                      )}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
          {q.length < 2 ? (
            <p className="p-4 text-center text-sm text-muted-foreground">{t('hint')}</p>
          ) : hits.isPending ? (
            <p role="status" className="p-4 text-center text-sm text-muted-foreground">
              {t('loading')}
            </p>
          ) : hits.isError ? (
            <p role="alert" className="p-4 text-center text-sm text-destructive">
              {t('error')}
            </p>
          ) : (
            !hits.data?.length && (
              <p role="status" className="p-4 text-center text-sm text-muted-foreground">
                {t('none', { q })}
              </p>
            )
          )}
        </Command>
      </CommandDialog>
    </>
  );
}
