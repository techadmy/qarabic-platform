'use client';

import { useQuery } from '@tanstack/react-query';
import { HouseIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { ProfileSkeleton } from '@/components/people/detail';
import { EmptyState, ErrorState } from '@/components/states';
import { fetchPeopleList } from '@/lib/api/people';
import { peopleKeys } from '@/lib/people/use-person-actions';
import { FamilyProfile } from '../families/[id]/family-profile';

/** «عائلتي» (parent portal): the parent's own family and children; the API scopes the list to it. */
export function MyFamilyView() {
  const t = useTranslations('families');
  const query = useQuery({
    queryKey: peopleKeys.list('families', { mine: true }),
    queryFn: ({ signal }) => fetchPeopleList('families', { perPage: 1 }, signal),
  });
  if (query.isError) return <ErrorState onRetry={() => void query.refetch()} />;
  if (query.isPending) return <ProfileSkeleton />;
  const family = query.data.data[0];
  if (!family) {
    return <EmptyState icon={HouseIcon} title={t('noFamilyTitle')} description={t('noFamily')} />;
  }
  return <FamilyProfile id={family.id} mine />;
}
