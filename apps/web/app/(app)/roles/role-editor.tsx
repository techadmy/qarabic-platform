'use client';

import { allPermissions, createRoleSchema, updateRoleSchema, type RoleDto } from '@qarabic/shared';
import { Alert, AlertDescription } from '@qarabic/ui/components/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@qarabic/ui/components/alert-dialog';
import { Badge } from '@qarabic/ui/components/badge';
import { Button } from '@qarabic/ui/components/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@qarabic/ui/components/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@qarabic/ui/components/dropdown-menu';
import { FieldGroup } from '@qarabic/ui/components/field';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@qarabic/ui/components/input-group';
import { Skeleton } from '@qarabic/ui/components/skeleton';
import { Spinner } from '@qarabic/ui/components/spinner';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircleIcon,
  EllipsisVerticalIcon,
  InfoIcon,
  SearchIcon,
  ShieldOffIcon,
  Trash2Icon,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useForm, type FieldValues } from 'react-hook-form';
import { toast } from 'sonner';
import type { z } from 'zod';
import { TextareaField, TextField } from '@/components/forms/fields';
import { PageHeader } from '@/components/page-header';
import { useCurrentUser } from '@/components/shell/app-shell';
import { EmptyState, ErrorState, ForbiddenState } from '@/components/states';
import { isApiError } from '@/lib/api/client';
import { createRole, fetchCatalog, fetchRole, fetchRoles, updateRole } from '@/lib/api/roles';
import { can } from '@/lib/auth/use-me';
import { applyServerErrors } from '@/lib/forms/server-errors';
import { useBeforeUnload } from '@/lib/forms/use-unsaved-guard';
import { useSchemaResolver } from '@/lib/forms/validation-messages';
import { canGrant, changedCount, groupCatalog } from '@/lib/roles/matrix';
import { useDirection } from '@/lib/use-direction';
import { roleKindKey, roleName } from './columns';
import { DeleteRoleDialog } from './delete-role-dialog';
import { PermissionMatrix } from './permission-matrix';

const TOTAL = allPermissions().length;
const LABEL_FIELDS = ['labelAr', 'labelEn', 'description', 'permissions', 'copyFrom'] as const;
const REFUSALS = [
  'owner_role_locked',
  'cannot_edit_own_role',
  'permission_not_held',
  'system_role',
  'role_in_use',
];

/**
 * Role detail / edit page (docs/29 §3): name fields, the permission matrix from `roles/catalog`,
 * a sticky save bar with the number of changes, «تراجع» and «حفظ» (with a confirmation that names
 * how many users the change reaches). Owner and portal roles are read-only with a note; cells the
 * viewer cannot grant are disabled with the reason.
 */
export function RoleEditor({ id }: { id?: number }) {
  const t = useTranslations('roles');
  const router = useRouter();
  const queryClient = useQueryClient();
  const me = useCurrentUser();
  const copyFrom = Number(useSearchParams().get('copyFrom')) || null;
  const isNew = id === undefined;
  const allowed = can(me, isNew ? 'roles.manage' : 'roles.view');

  const role = useQuery({
    queryKey: ['roles', id],
    queryFn: ({ signal }) => fetchRole(id!, signal),
    enabled: allowed && !isNew,
  });
  const source = useQuery({
    queryKey: ['roles', copyFrom],
    queryFn: ({ signal }) => fetchRole(copyFrom!, signal),
    enabled: allowed && isNew && copyFrom !== null,
  });
  const catalog = useQuery({
    queryKey: ['roles', 'catalog'],
    queryFn: ({ signal }) => fetchCatalog(signal),
    enabled: allowed,
  });
  // Warm the list cache for the way back.
  useQuery({ queryKey: ['roles'], queryFn: ({ signal }) => fetchRoles(signal), enabled: allowed });

  if (!allowed || isApiError(role.error, 403) || isApiError(catalog.error, 403)) {
    return <ForbiddenState />;
  }
  if (isApiError(role.error, 404)) {
    return (
      <EmptyState
        icon={ShieldOffIcon}
        role="alert"
        title={t('editor.notFound')}
        description={t('editor.notFoundHint')}
      />
    );
  }
  if (role.isError || catalog.isError) {
    return <ErrorState onRetry={() => void Promise.all([role.refetch(), catalog.refetch()])} />;
  }
  if ((!isNew && role.isPending) || catalog.isPending || (isNew && copyFrom && source.isPending)) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  return (
    <RoleForm
      key={role.data?.id ?? `new-${copyFrom ?? ''}`}
      role={role.data ?? null}
      source={source.data ?? null}
      groups={groupCatalog(catalog.data)}
      onSaved={(saved) => {
        void queryClient.invalidateQueries({ queryKey: ['roles'] });
        queryClient.setQueryData(['roles', saved.id], saved);
        if (isNew) router.push(`/roles/${saved.id}`);
      }}
    />
  );
}

function RoleForm({
  role,
  source,
  groups,
  onSaved,
}: {
  role: RoleDto | null;
  source: RoleDto | null;
  groups: ReturnType<typeof groupCatalog>;
  onSaved: (role: RoleDto) => void;
}) {
  const t = useTranslations('roles');
  const tv = useTranslations('validation');
  const locale = useLocale();
  const dir = useDirection();
  const me = useCurrentUser();
  const router = useRouter();
  const isNew = role === null;
  const canManage = can(me, 'roles.manage');
  const isOwnerRole = role?.kind === 'owner';
  const isPortalRole = role?.kind === 'teacher' || role?.kind === 'parent';
  const ownRole = !!role && role.name === me.role?.name;
  const labelsEditable = isNew ? canManage : role.editable;
  const permsEditable = isNew ? canManage : role.permissionsEditable;
  const grantable = (p: string) => canGrant(me, { permissionsEditable: permsEditable }, p);

  // A copy keeps only what the viewer may grant (the API drops the rest too).
  const initialPermissions = useMemo(() => {
    if (role) return [...role.permissions].sort();
    if (source) return source.permissions.filter((p) => canGrant(me, null, p)).sort();
    return [];
  }, [role, source, me]);
  const skipped = source ? source.permissions.length - initialPermissions.length : 0;
  const [saved, setSaved] = useState(initialPermissions);
  const [permissions, setPermissions] = useState(initialPermissions);
  const [search, setSearch] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);

  const resolver = useSchemaResolver(
    (isNew ? createRoleSchema : updateRoleSchema) as unknown as z.ZodType<
      Record<string, unknown>,
      FieldValues
    >,
  );
  const defaults = {
    labelAr: role?.labelAr ?? (source ? t('editor.copyOf', { name: roleName(source, 'ar') }) : ''),
    labelEn: role?.labelEn ?? '',
    description: role?.description ?? '',
  };
  const form = useForm<FieldValues, unknown, Record<string, unknown>>({
    resolver,
    mode: 'onBlur',
    reValidateMode: 'onChange',
    defaultValues: isNew ? { ...defaults, permissions: [] } : defaults,
  });
  const changes = changedCount(saved, permissions);
  // Read during render so react-hook-form tracks it (formState is a subscription proxy).
  const dirtyFields = form.formState.dirtyFields as Record<string, boolean>;
  const dirty = form.formState.isDirty || changes > 0;
  useBeforeUnload(dirty);

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      isNew ? createRole(body as never) : updateRole(role.id, body as never),
    onSuccess: (result) => {
      toast.success(
        isNew ? t('editor.created', { name: roleName(result, locale) }) : t('editor.saved'),
      );
      setSaved([...result.permissions].sort());
      setPermissions([...result.permissions].sort());
      form.reset({
        labelAr: result.labelAr,
        labelEn: result.labelEn ?? '',
        description: result.description ?? '',
      });
      onSaved(result);
    },
    onError: (error) => {
      if (applyServerErrors(form, error, (k) => tv(k), LABEL_FIELDS))
        return setBanner(t('editor.fixErrors'));
      if (isApiError(error) && error.code && REFUSALS.includes(error.code)) {
        return setBanner(
          t(`errors.${error.code}`, { count: Number(error.error?.data?.usersCount ?? 0) }),
        );
      }
      setBanner(t('errors.generic'));
    },
  });

  function submit(values: Record<string, unknown>) {
    setBanner(null);
    const body: Record<string, unknown> = { ...values };
    if (isNew) body.permissions = permissions;
    else {
      for (const key of Object.keys(body)) {
        if (!dirtyFields[key]) delete body[key];
      }
      if (permsEditable && changes > 0) body.permissions = permissions;
      if (Object.keys(body).length === 0) return;
    }
    save.mutate(body);
  }

  const onSubmit = form.handleSubmit(
    (values) => {
      // Changing what an existing role may do reaches its users at once: confirm first (D31).
      if (!isNew && changes > 0 && !confirming) return setConfirming(true);
      submit(values);
    },
    () => setBanner(t('editor.fixErrors')),
  );

  const kindKey = role ? roleKindKey(role) : 'custom';
  const title = isNew ? t('editor.newTitle') : roleName(role, locale);
  const note = isOwnerRole
    ? t('editor.ownerNote')
    : isPortalRole
      ? t('editor.portalNote')
      : ownRole && !labelsEditable
        ? t('editor.ownRole')
        : !canManage
          ? t('editor.viewOnly')
          : null;
  const someNotHeld = permsEditable && me.role?.kind !== 'owner';

  return (
    <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4 pb-2">
      <PageHeader
        back={{
          href: '/roles',
          label: t('editor.back'),
          onClick: (event) => {
            if (!dirty) return;
            event.preventDefault();
            setLeaving(true);
          },
        }}
        title={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>{title}</span>
            {role && (
              <Badge
                variant={role.kind === 'owner' ? 'default' : 'outline'}
                className="h-6 rounded-md"
              >
                {t(`kindChip.${kindKey}`)}
              </Badge>
            )}
            {role?.customizedAt && (
              <Badge variant="secondary" className="h-6 rounded-md" title={t('customizedHint')}>
                {t('customized')}
              </Badge>
            )}
          </span>
        }
        meta={role ? t('usersCount', { count: role.usersCount }) : undefined}
        actions={
          role && !role.isSystem && canManage && !ownRole ? (
            <DropdownMenu dir={dir}>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="icon-lg" aria-label={t('moreActions')}>
                  <EllipsisVerticalIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(true)}>
                  <Trash2Icon />
                  {t('delete')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : undefined
        }
      />
      {note && (
        <Alert>
          <InfoIcon />
          <AlertDescription>{note}</AlertDescription>
        </Alert>
      )}
      {skipped > 0 && (
        <Alert>
          <InfoIcon />
          <AlertDescription>{t('editor.copiedSkipped', { count: skipped })}</AlertDescription>
        </Alert>
      )}
      {banner && (
        <Alert variant="destructive" role="alert">
          <AlertCircleIcon />
          <AlertDescription>{banner}</AlertDescription>
        </Alert>
      )}

      <Card className="shadow-none">
        <CardHeader className="border-b">
          <CardTitle className="text-base font-bold">{t('editor.nameSection')}</CardTitle>
        </CardHeader>
        <CardContent>
          <fieldset disabled={!labelsEditable} className="contents">
            <FieldGroup className="gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField
                  control={form.control}
                  name="labelAr"
                  label={t('editor.labelAr')}
                  required
                />
                <TextField
                  control={form.control}
                  name="labelEn"
                  label={t('editor.labelEn')}
                  inputProps={{ dir: 'ltr' }}
                />
              </div>
              <TextareaField
                control={form.control}
                name="description"
                label={t('editor.description')}
                description={t('editor.descriptionHint')}
                rows={2}
              />
            </FieldGroup>
          </fieldset>
        </CardContent>
      </Card>

      <Card className="shadow-none">
        <CardHeader className="border-b">
          <CardTitle className="text-base font-bold">{t('editor.matrix')}</CardTitle>
          <CardDescription>{t('editor.matrixHint')}</CardDescription>
          <CardAction className="text-sm font-semibold tabular-nums">
            {isOwnerRole
              ? t('allPermissions')
              : t('editor.selected', { count: permissions.length, total: TOTAL })}
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5 sm:max-w-sm">
            <label htmlFor="matrix-search" className="text-[0.8125rem] text-muted-foreground">
              {t('editor.search')}
            </label>
            <InputGroup className="h-10">
              <InputGroupAddon>
                <SearchIcon aria-hidden />
              </InputGroupAddon>
              <InputGroupInput
                id="matrix-search"
                type="search"
                value={search}
                placeholder={t('editor.searchHint')}
                onChange={(e) => setSearch(e.target.value)}
              />
            </InputGroup>
          </div>
          {someNotHeld && (
            <p className="text-sm text-muted-foreground">{t('editor.notHeldLegend')}</p>
          )}
          <PermissionMatrix
            groups={groups}
            value={isOwnerRole ? allPermissions() : permissions}
            onChange={setPermissions}
            grantable={grantable}
            readOnly={!permsEditable}
            search={search}
          />
        </CardContent>
      </Card>

      {(labelsEditable || permsEditable) && (
        <div
          role="region"
          aria-label={t('editor.saveBar')}
          className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center justify-between gap-3 border-t bg-card px-4 py-3 md:-mx-6 md:px-6"
        >
          <span className="text-sm font-medium" aria-live="polite">
            {dirty ? t('editor.changes', { count: Math.max(changes, 1) }) : t('editor.noChanges')}
          </span>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              className="h-10"
              disabled={!dirty || save.isPending}
              onClick={() => {
                setPermissions(saved);
                form.reset();
                setBanner(null);
              }}
            >
              {t('editor.discard')}
            </Button>
            <Button
              type="submit"
              className="h-10 px-5"
              disabled={save.isPending || (!isNew && !dirty)}
            >
              {save.isPending && <Spinner />}
              {isNew ? t('editor.create') : t('editor.save')}
            </Button>
          </div>
        </div>
      )}

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('editor.confirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('editor.confirmBody', { changes, users: role?.usersCount ?? 0 })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirming(false);
                void form.handleSubmit(submit)();
              }}
            >
              {t('editor.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={leaving} onOpenChange={setLeaving}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('editor.leaveTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('editor.leaveBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('editor.stay')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => router.push('/roles')}>
              {t('editor.leave')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {role && deleting && (
        <DeleteRoleDialog role={role} open onOpenChange={setDeleting} redirectTo="/roles" />
      )}
    </form>
  );
}
