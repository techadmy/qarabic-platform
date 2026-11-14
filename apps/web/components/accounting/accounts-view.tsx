'use client';

import {
  ACCOUNT_TYPE_LABELS,
  ACCOUNT_TYPES,
  createAccountSchema,
  updateAccountSchema,
  type CreateAccountInput,
  type UpdateAccountInput,
  type AccountType,
  type LedgerAccountDto,
} from '@qarabic/shared';
import { Badge } from '@qarabic/ui/components/badge';
import { Button } from '@qarabic/ui/components/button';
import { Card } from '@qarabic/ui/components/card';
import { Checkbox } from '@qarabic/ui/components/checkbox';
import { Input } from '@qarabic/ui/components/input';
import { Label } from '@qarabic/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@qarabic/ui/components/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@qarabic/ui/components/table';
import { Textarea } from '@qarabic/ui/components/textarea';
import { cn } from '@qarabic/ui/lib/utils';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileTextIcon, ListTreeIcon, PencilIcon, PlusIcon, SearchXIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useId, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  ArchivedSwitch,
  ClearFiltersButton,
  FilterSelect,
  ListToolbar,
} from '@/components/list/list-toolbar';
import { PageHeader } from '@/components/page-header';
import { FormDialog } from '@/components/payroll/payroll-bits';
import { Highlight } from '@/components/people/people-list';
import { useUiLocale } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { EmptyState, ErrorState, ForbiddenState } from '@/components/states';
import { accountingKeys, createAccount, fetchAccounts, updateAccount } from '@/lib/api/accounting';
import { isApiError } from '@/lib/api/client';
import { can } from '@/lib/auth/use-me';
import { serverFieldErrors, sharedSchemaErrors, type PlacedErrors } from '@/lib/accounting/forms';
import { depths, filterAccounts } from '@/lib/accounting/tree';
import { useListParams } from '@/lib/list-params';
import {
  accountLabel,
  CurrencySelect,
  FormRow,
  NUMBER_INPUT,
  useAccountingError,
  useFormMessage,
} from './accounting-bits';
import { Skeleton } from '@qarabic/ui/components/skeleton';

/** Tree indentation on the spacing scale (16 / 32 / 48 px). */
const INDENT = ['ps-0', 'ps-4', 'ps-8', 'ps-12'] as const;

type Editing =
  { mode: 'new'; parent?: LedgerAccountDto } | { mode: 'edit'; account: LedgerAccountDto };

function AccountDialog({
  editing,
  accounts,
  onClose,
}: {
  editing: Editing;
  accounts: LedgerAccountDto[];
  onClose: () => void;
}) {
  const t = useTranslations('accounting');
  const locale = useUiLocale();
  const queryClient = useQueryClient();
  const message = useAccountingError();
  const current = editing.mode === 'edit' ? editing.account : null;
  const ids = {
    code: useId(),
    type: useId(),
    parent: useId(),
    nameAr: useId(),
    nameEn: useId(),
    currency: useId(),
    description: useId(),
    group: useId(),
    cash: useId(),
    active: useId(),
  };
  const parent0 = editing.mode === 'new' ? editing.parent : undefined;
  const [code, setCode] = useState(current?.code ?? '');
  const [type, setType] = useState<AccountType>(current?.type ?? parent0?.type ?? 'expense');
  const [parentId, setParentId] = useState<number | null>(current?.parentId ?? parent0?.id ?? null);
  const [nameAr, setNameAr] = useState(current?.nameAr ?? '');
  const [nameEn, setNameEn] = useState(current?.nameEn ?? '');
  const [currency, setCurrency] = useState(current?.currency ?? '');
  const [description, setDescription] = useState(current?.description ?? '');
  const [isGroup, setIsGroup] = useState(current?.isGroup ?? false);
  const [isCash, setIsCash] = useState(current?.isCash ?? false);
  const [isActive, setIsActive] = useState(current?.isActive ?? true);
  const [touched, setTouched] = useState(false);
  const [server, setServer] = useState<PlacedErrors | null>(null);
  const msg = useFormMessage();
  const errors = {
    code: current || /^\d{1,10}$/.test(code.trim()) ? null : 'codeInvalid',
    nameAr: nameAr.trim().length >= 2 ? null : 'nameRequired',
    nameEn: nameEn.trim().length >= 2 ? null : 'nameRequired',
  };
  const body = current
    ? {
        nameAr: nameAr.trim(),
        nameEn: nameEn.trim(),
        parentId,
        isCash,
        isActive,
        description: description.trim() || null,
      }
    : {
        code: code.trim(),
        type,
        parentId,
        nameAr: nameAr.trim(),
        nameEn: nameEn.trim(),
        isGroup,
        isCash,
        currency: currency || null,
        description: description.trim() || null,
      };
  // The API's own rules too (shared schemas), so the dialog and the API cannot drift.
  const shared = sharedSchemaErrors(
    current ? updateAccountSchema : createAccountSchema,
    body,
    [],
  ).errors;
  const err = (k: string) => {
    const key =
      (touched ? ((errors as Record<string, string | null>)[k] ?? shared[k]) : undefined) ??
      server?.errors[k];
    return key ? msg(key) : null;
  };
  const ok = !Object.values(errors).some(Boolean) && Object.keys(shared).length === 0;
  const groups = accounts.filter((a) => a.isGroup && a.type === type && a.id !== current?.id);
  const save = useMutation({
    mutationFn: () =>
      current
        ? updateAccount(current.id, body as UpdateAccountInput)
        : createAccount(body as CreateAccountInput),
    onSuccess: (a) => {
      void queryClient.invalidateQueries({ queryKey: accountingKeys.all });
      toast.success(current ? t('accounts.saved') : t('accounts.created', { code: a.code }));
      onClose();
    },
    onError: (e) => {
      // A taken code is a field error, not a banner.
      const placed = serverFieldErrors(e);
      setServer(
        placed ??
          (isApiError(e) && e.code === 'code_taken'
            ? { errors: { code: 'codeTaken' }, lineErrors: {} }
            : null),
      );
    },
  });
  const NONE = '__none__';

  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={current ? t('accounts.editTitle', { code: current.code }) : t('accounts.newTitle')}
      description={current?.systemKey ? t('accounts.systemHint') : undefined}
      submitLabel={current ? t('accounts.save') : t('accounts.create')}
      busy={save.isPending}
      error={save.isError && !server ? message(save.error) : null}
      summary={touched && !ok ? t('form.fixErrors') : null}
      onSubmit={() => {
        setTouched(true);
        if (ok) save.mutate();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <FormRow id={ids.code} label={t('fields.code')} required={!current} error={err('code')}>
          <Input
            id={ids.code}
            inputMode="numeric"
            dir="ltr"
            maxLength={10}
            value={code}
            disabled={!!current}
            onChange={(e) => setCode(e.target.value)}
            aria-invalid={!!err('code')}
            aria-describedby={err('code') ? `${ids.code}-error` : undefined}
            className={NUMBER_INPUT}
          />
        </FormRow>
        <FormRow id={ids.type} label={t('fields.type')} required={!current}>
          <Select
            value={type}
            disabled={!!current}
            onValueChange={(v) => {
              setType(v as AccountType);
              setParentId(null);
            }}
          >
            <SelectTrigger id={ids.type} className="h-10! w-full md:text-body">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              {ACCOUNT_TYPES.map((x) => (
                <SelectItem key={x} value={x}>
                  {ACCOUNT_TYPE_LABELS[x][locale]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormRow>
      </div>
      <FormRow id={ids.parent} label={t('fields.parent')}>
        <Select
          value={parentId ? String(parentId) : NONE}
          onValueChange={(v) => setParentId(v === NONE ? null : Number(v))}
        >
          <SelectTrigger id={ids.parent} className="h-10! w-full md:text-body">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            <SelectItem value={NONE}>{t('accounts.noParent')}</SelectItem>
            {groups.map((g) => (
              <SelectItem key={g.id} value={String(g.id)}>
                {accountLabel(g, locale)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormRow>
      <FormRow id={ids.nameAr} label={t('fields.nameAr')} required error={err('nameAr')}>
        <Input
          id={ids.nameAr}
          dir="rtl"
          maxLength={120}
          value={nameAr}
          onChange={(e) => setNameAr(e.target.value)}
          aria-invalid={!!err('nameAr')}
          className="h-10 md:text-body"
        />
      </FormRow>
      <FormRow id={ids.nameEn} label={t('fields.nameEn')} required error={err('nameEn')}>
        <Input
          id={ids.nameEn}
          dir="ltr"
          maxLength={120}
          value={nameEn}
          onChange={(e) => setNameEn(e.target.value)}
          aria-invalid={!!err('nameEn')}
          className="h-10 text-start md:text-body"
        />
      </FormRow>
      {!current && (
        <FormRow id={ids.currency} label={t('accounts.currency')} hint={t('accounts.currencyHint')}>
          <CurrencySelect id={ids.currency} value={currency} onChange={setCurrency} allowAll />
        </FormRow>
      )}
      <FormRow id={ids.description} label={t('fields.description')}>
        <Textarea
          id={ids.description}
          dir="auto"
          rows={2}
          maxLength={500}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="md:text-body"
        />
      </FormRow>
      <div className="flex flex-col gap-3">
        {!current && (
          <div className="flex items-center gap-2">
            <Checkbox
              id={ids.group}
              checked={isGroup}
              onCheckedChange={(v) => setIsGroup(v === true)}
            />
            <Label htmlFor={ids.group}>{t('accounts.isGroup')}</Label>
          </div>
        )}
        {!isGroup && (
          <div className="flex items-center gap-2">
            <Checkbox
              id={ids.cash}
              checked={isCash}
              onCheckedChange={(v) => setIsCash(v === true)}
            />
            <Label htmlFor={ids.cash}>{t('accounts.isCash')}</Label>
          </div>
        )}
        {current && !current.systemKey && (
          <div className="flex items-center gap-2">
            <Checkbox
              id={ids.active}
              checked={!isActive}
              onCheckedChange={(v) => setIsActive(v !== true)}
            />
            <Label htmlFor={ids.active}>{t('accounts.archive')}</Label>
          </div>
        )}
      </div>
    </FormDialog>
  );
}

/**
 * «دليل الحسابات» (M7, docs/07 §أ.2): the chart as a tree under the five types, codes first.
 * Groups are headings, only leaves take postings; system accounts (used by the automatic entries)
 * cannot be archived. Search by code or name, a type filter and the archived switch; each leaf
 * opens its statement. «حساب جديد» and «تعديل» for accounting.manage.
 */
export function AccountsView() {
  const t = useTranslations('accounting');
  const locale = useUiLocale();
  const me = useCurrentUser();
  const params = useListParams();
  const [editing, setEditing] = useState<Editing | null>(null);
  const allowed = can(me, 'accounting.view');
  const manage = can(me, 'accounting.manage');
  const typeParam = params.get('type') as AccountType;
  const type = ACCOUNT_TYPES.includes(typeParam) ? typeParam : undefined;
  const query = useQuery({
    queryKey: accountingKeys.accounts({ only: 'all' }),
    queryFn: ({ signal }) => fetchAccounts({ only: 'all' }, signal),
    enabled: allowed,
  });
  const all = useMemo(() => query.data ?? [], [query.data]);
  const depth = useMemo(() => depths(all), [all]);
  const needle = params.q.trim();
  const rows = filterAccounts(all, { q: params.q, type, archived: params.archived });
  const filtersOn = !!(params.q || type || params.archived);

  if (!allowed || isApiError(query.error, 403)) {
    return (
      <>
        <PageHeader title={t('accounts.title')} />
        <ForbiddenState />
      </>
    );
  }
  const clearFilters = () => {
    params.setSearchInput('');
    params.set({ q: null, type: null, archived: null });
  };

  return (
    <>
      <PageHeader
        title={t('accounts.title')}
        description={t('accounts.description')}
        meta={query.data ? t('accounts.count', { count: rows.length }) : undefined}
        actions={
          manage && (
            <Button className="h-10" onClick={() => setEditing({ mode: 'new' })}>
              <PlusIcon />
              {t('accounts.new')}
            </Button>
          )
        }
      />
      <Card className="gap-0 py-0 shadow-none">
        <ListToolbar
          search={{
            label: t('accounts.searchLabel'),
            placeholder: t('accounts.search'),
            value: params.searchInput,
            onChange: params.setSearchInput,
          }}
          filters={
            <>
              <FilterSelect
                label={t('fields.type')}
                value={type ?? ''}
                onChange={(v) => params.set({ type: v || null })}
                allLabel={t('accounts.allTypes')}
                options={ACCOUNT_TYPES.map((x) => ({
                  value: x,
                  label: ACCOUNT_TYPE_LABELS[x][locale],
                }))}
              />
              <ArchivedSwitch
                checked={params.archived}
                onChange={(v) => params.set({ archived: v ? 1 : null })}
              />
              {filtersOn && <ClearFiltersButton onClick={clearFilters} />}
            </>
          }
        />
        {query.isError ? (
          <div className="p-4">
            <ErrorState onRetry={() => void query.refetch()} />
          </div>
        ) : query.isPending ? (
          <div className="flex flex-col gap-2 p-4" aria-busy="true">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={filtersOn ? SearchXIcon : ListTreeIcon}
              role="status"
              title={t('accounts.noResults')}
              description={t('accounts.noResultsHint')}
              action={
                filtersOn ? (
                  <Button variant="outline" onClick={clearFilters}>
                    {t('clear')}
                  </Button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table aria-label={t('accounts.title')}>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-28">{t('fields.code')}</TableHead>
                  <TableHead>{t('fields.name')}</TableHead>
                  <TableHead className="hidden md:table-cell">{t('accounts.flags')}</TableHead>
                  <TableHead className="w-24">
                    <span className="sr-only">{t('accounts.actions')}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              {ACCOUNT_TYPES.filter((x) => rows.some((a) => a.type === x)).map((x) => (
                <TableBody key={x} aria-label={ACCOUNT_TYPE_LABELS[x][locale]}>
                  {rows
                    .filter((a) => a.type === x)
                    .map((a) => {
                      const d = needle ? 0 : (depth.get(a.id) ?? 0);
                      const name = locale === 'en' ? a.nameEn : a.nameAr;
                      return (
                        <TableRow
                          key={a.id}
                          data-account-id={a.id}
                          className={cn(!a.parentId && 'bg-muted/50 hover:bg-muted/50')}
                        >
                          <TableCell className="tabular-nums">
                            <bdi className={cn(a.isGroup && 'font-bold')}>
                              <Highlight text={a.code} query={params.q} />
                            </bdi>
                          </TableCell>
                          <TableCell>
                            <span
                              className={cn(
                                'flex flex-col',
                                INDENT[Math.min(d, 3)],
                                a.isGroup && 'font-bold',
                              )}
                            >
                              {a.isGroup ? (
                                <Highlight text={name} query={params.q} />
                              ) : (
                                <Link
                                  href={`/accounting/accounts/${a.id}`}
                                  className="font-medium text-primary hover:underline"
                                >
                                  <Highlight text={name} query={params.q} />
                                </Link>
                              )}
                              <span className="flex flex-wrap gap-1 md:hidden">
                                <Flags a={a} />
                              </span>
                            </span>
                          </TableCell>
                          <TableCell className="hidden md:table-cell">
                            <span className="flex flex-wrap gap-1">
                              <Flags a={a} />
                            </span>
                          </TableCell>
                          <TableCell className="text-end">
                            <span className="flex justify-end gap-1">
                              {!a.isGroup && (
                                <Button
                                  variant="ghost"
                                  size="icon-lg"
                                  asChild
                                  aria-label={t('accounts.statementOf', {
                                    name: accountLabel(a, locale),
                                  })}
                                >
                                  <Link href={`/accounting/accounts/${a.id}`}>
                                    <FileTextIcon />
                                  </Link>
                                </Button>
                              )}
                              {manage && (
                                <Button
                                  variant="ghost"
                                  size="icon-lg"
                                  aria-label={t('accounts.editOf', {
                                    name: accountLabel(a, locale),
                                  })}
                                  onClick={() => setEditing({ mode: 'edit', account: a })}
                                >
                                  <PencilIcon />
                                </Button>
                              )}
                            </span>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                </TableBody>
              ))}
            </Table>
          </div>
        )}
      </Card>
      {editing && (
        <AccountDialog editing={editing} accounts={all} onClose={() => setEditing(null)} />
      )}
    </>
  );
}

function Flags({ a }: { a: LedgerAccountDto }) {
  const t = useTranslations('accounting.accounts');
  return (
    <>
      {a.isGroup && <Badge variant="secondary">{t('group')}</Badge>}
      {a.isCash && <Badge variant="outline">{t('cash')}</Badge>}
      {a.systemKey && <Badge variant="outline">{t('system')}</Badge>}
      {a.currency && (
        <Badge variant="outline">
          <bdi>{a.currency}</bdi>
        </Badge>
      )}
      {!a.isActive && <Badge variant="outline">{t('archived')}</Badge>}
    </>
  );
}
