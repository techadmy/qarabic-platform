'use client';

import { Button } from '@qarabic/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@qarabic/ui/components/dropdown-menu';
import {
  ArrowLeftRightIcon,
  EllipsisVerticalIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  UserXIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';
import { PageHeader } from '@/components/page-header';
import { EmptyState, ErrorState, ForbiddenState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { isApiError } from '@/lib/api/client';
import type { PeopleKind } from '@/lib/api/people';
import { useDirection } from '@/lib/use-direction';
import { ArchiveDialog } from './archive-dialog';
import { ArchivedBanner, ProfileAvatar, ProfileSkeleton } from './detail';
import { RestoreButton } from './people-list';
import { PersonSheet, type SheetTarget } from './person-sheet';
import { StatusDialog } from './status-dialog';

export type ProfileRecord = {
  id: number;
  name: string;
  subtitle?: ReactNode;
  status: { value: string; reason: string | null };
  archive: {
    reason: string | null;
    archivedAt: string;
    by: { id: number; name: string } | null;
  } | null;
};

/**
 * Profile = workbench (K6, docs/28 §2): header with the name, status chip and the actions
 * («تعديل», «تغيير الحالة», the family's «أضف طالب» as the one primary button, «حذف» in the ⋯
 * menu); archived records are read-only with a banner and «استعادة». Loading, 403, 404 and error
 * states. The page body (key facts, sections) comes as children.
 */
export function ProfileShell({
  kind,
  backHref,
  backLabel,
  query,
  record,
  canManage,
  sheetTarget,
  addStudentFor,
  activeStudents,
  children,
}: {
  kind: PeopleKind;
  backHref?: string;
  backLabel: string;
  query: { isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown };
  record: ProfileRecord | undefined;
  canManage: boolean;
  sheetTarget?: SheetTarget;
  /** Family profile: «أضف طالب» with the family chosen. */
  addStudentFor?: number;
  activeStudents?: number;
  children: (open: { edit: (section?: string) => void }) => ReactNode;
}) {
  const t = useTranslations('people');
  const dir = useDirection();
  const [editing, setEditing] = useState<{ section?: string } | null>(null);
  const [statusOpen, setStatusOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [addingStudent, setAddingStudent] = useState(false);

  if (isApiError(query.error, 403)) return <ForbiddenState />;
  if (isApiError(query.error, 404)) {
    return (
      <EmptyState
        icon={UserXIcon}
        role="alert"
        title={t('notFoundTitle')}
        description={t('notFound')}
      />
    );
  }
  if (query.isError) return <ErrorState onRetry={() => void query.refetch()} />;
  if (query.isPending || !record) return <ProfileSkeleton />;

  const archived = !!record.archive;
  const manage = canManage && !archived;

  return (
    <>
      <PageHeader
        back={backHref ? { href: backHref, label: backLabel } : undefined}
        leading={<ProfileAvatar name={record.name} />}
        title={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>{record.name}</span>
            <StatusBadge kind={kind} status={record.status.value} />
          </span>
        }
        meta={record.subtitle}
        actions={
          manage ? (
            <>
              <Button variant="outline" className="h-10" onClick={() => setEditing({})}>
                <PencilIcon />
                {t('edit')}
              </Button>
              <Button variant="outline" className="h-10" onClick={() => setStatusOpen(true)}>
                <ArrowLeftRightIcon />
                {t('status.change')}
              </Button>
              <DropdownMenu dir={dir}>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-lg" aria-label={t('moreActions')}>
                    <EllipsisVerticalIcon />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem variant="destructive" onSelect={() => setArchiveOpen(true)}>
                    <Trash2Icon />
                    {t('archive.action')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              {addStudentFor !== undefined && (
                <Button className="h-10" onClick={() => setAddingStudent(true)}>
                  <PlusIcon />
                  {t('addStudent')}
                </Button>
              )}
            </>
          ) : undefined
        }
      />
      {record.archive && (
        <ArchivedBanner
          archive={record.archive}
          action={
            canManage ? (
              <RestoreButton
                kind={kind}
                record={{ id: record.id, name: record.name, reason: record.archive.reason }}
              />
            ) : undefined
          }
        />
      )}
      {children({ edit: (section) => manage && setEditing({ section }) })}
      {manage && sheetTarget && (
        <PersonSheet
          target={sheetTarget}
          open={editing !== null}
          section={editing?.section}
          onOpenChange={(open) => !open && setEditing(null)}
        />
      )}
      {manage && addStudentFor !== undefined && (
        <PersonSheet
          target={{ kind: 'students', familyId: addStudentFor }}
          open={addingStudent}
          onOpenChange={setAddingStudent}
        />
      )}
      {manage && (
        <>
          <StatusDialog
            key={`status-${record.status.value}`}
            kind={kind}
            record={{
              id: record.id,
              name: record.name,
              status: record.status.value,
              reason: record.status.reason,
            }}
            open={statusOpen}
            onOpenChange={setStatusOpen}
            activeStudents={activeStudents}
          />
          <ArchiveDialog
            key={`archive-${record.status.value}`}
            kind={kind}
            record={{ id: record.id, name: record.name, status: record.status.value }}
            open={archiveOpen}
            onOpenChange={setArchiveOpen}
          />
        </>
      )}
    </>
  );
}
