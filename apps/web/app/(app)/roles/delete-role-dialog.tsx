'use client';

import type { RoleDto } from '@qarabic/shared';
import { Alert, AlertDescription } from '@qarabic/ui/components/alert';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@qarabic/ui/components/alert-dialog';
import { Button } from '@qarabic/ui/components/button';
import { Spinner } from '@qarabic/ui/components/spinner';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertCircleIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { isApiError } from '@/lib/api/client';
import { deleteRole } from '@/lib/api/roles';
import { roleName } from './columns';

/** Delete a custom role (D31 confirm; the API refuses a role in use with `role_in_use`). */
export function DeleteRoleDialog({
  role,
  open,
  onOpenChange,
  redirectTo,
}: {
  role: RoleDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  redirectTo?: string;
}) {
  const t = useTranslations('roles');
  const locale = useLocale();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const name = roleName(role, locale);
  const inUse = role.usersCount > 0;
  const remove = useMutation({
    mutationFn: () => deleteRole(role.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['roles'] });
      onOpenChange(false);
      toast.success(t('deleteDialog.done', { name }));
      if (redirectTo) router.push(redirectTo);
    },
    onError: (e) => {
      if (isApiError(e) && e.code === 'role_in_use') {
        setError(
          t('errors.role_in_use', { count: Number(e.error?.data?.usersCount ?? role.usersCount) }),
        );
      } else if (
        isApiError(e) &&
        e.code &&
        ['system_role', 'cannot_edit_own_role'].includes(e.code)
      ) {
        setError(t(`errors.${e.code}`));
      } else {
        setError(t('errors.generic'));
      }
    },
  });
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('deleteDialog.title', { name })}</AlertDialogTitle>
          <AlertDialogDescription>
            {inUse ? t('errors.role_in_use', { count: role.usersCount }) : t('deleteDialog.body')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertCircleIcon />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>{inUse ? t('close') : t('cancel')}</AlertDialogCancel>
          {!inUse && (
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              {remove.isPending && <Spinner />}
              {t('deleteDialog.confirm')}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
