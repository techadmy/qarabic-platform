'use client';

import { useRecordPane } from '@/components/list/split-view';
import { cn } from '@qarabic/ui/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { InfoSection, KeyFacts } from '@/components/people/detail';
import { ProfileShell } from '@/components/people/profile-shell';
import { useCurrentUser } from '@/components/shell/app-shell';
import { StatusBadge } from '@/components/status-badge';
import { fetchPerson } from '@/lib/api/people';
import { can } from '@/lib/auth/use-me';
import { peopleKeys } from '@/lib/people/use-person-actions';
import { formatInstant, zoneLabel } from '@/lib/time';
import { roleLabel } from '../staff-view';

/** Staff member: contact + account (role, language, time zone). The API keeps no status history for staff. */
export function StaffProfile({ id }: { id: number }) {
  const pane = useRecordPane();
  const t = useTranslations('staff');
  const tp = useTranslations('people');
  const locale = useLocale() === 'en' ? 'en' : 'ar';
  const me = useCurrentUser();
  const canManage = can(me, 'users.manage');
  const query = useQuery({
    queryKey: peopleKeys.detail('staff', id),
    queryFn: ({ signal }) => fetchPerson('staff', id, signal),
    enabled: Number.isInteger(id) && id > 0,
  });
  const s = query.data;
  const editable = canManage && !s?.archive;

  return (
    <ProfileShell
      kind="staff"
      backHref="/staff"
      backLabel={t('back')}
      query={query}
      canManage={canManage}
      record={
        s && {
          id: s.id,
          name: s.name,
          subtitle: <bdi dir="ltr">{s.email}</bdi>,
          status: s.status,
          archive: s.archive,
        }
      }
      sheetTarget={s && { kind: 'staff', record: s }}
    >
      {({ edit }) =>
        s && (
          <>
            <KeyFacts
              items={[
                { label: tp('fields.role'), value: roleLabel(s.role, locale) },
                {
                  label: tp('fields.status'),
                  value: <StatusBadge kind="staff" status={s.status.value} />,
                },
              ]}
            />
            <div
              className={cn(
                'grid items-start gap-4',
                // In the split view's pane the columns follow the pane, not the screen (D141 §1).
                pane ? '@5xl:grid-cols-2' : 'lg:grid-cols-2',
              )}
            >
              <InfoSection
                title={tp('sections.contact')}
                onEdit={editable ? () => edit('contact') : undefined}
                rows={[
                  { label: tp('fields.name'), value: s.name },
                  { label: tp('fields.email'), value: <bdi dir="ltr">{s.email}</bdi> },
                  { label: tp('fields.phone'), value: s.phone && <bdi dir="ltr">{s.phone}</bdi> },
                ]}
              />
              <InfoSection
                title={tp('sections.account')}
                onEdit={editable ? () => edit('account') : undefined}
                rows={[
                  { label: tp('fields.role'), value: roleLabel(s.role, locale) },
                  { label: tp('fields.language'), value: tp(`uiLanguage.${s.locale}`) },
                  { label: tp('fields.timezone'), value: zoneLabel(s.timezone, locale) },
                  { label: tp('fields.statusReason'), value: s.status.reason },
                  {
                    label: tp('fields.createdAt'),
                    value: formatInstant(s.createdAt, me.timezone, locale),
                  },
                ]}
              />
            </div>
          </>
        )
      }
    </ProfileShell>
  );
}
