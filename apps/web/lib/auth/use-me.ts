'use client';

import type { Me } from '@qarabic/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { fetchMe, login, logout, type LoginPayload } from '@/lib/api/auth';

export const meQueryKey = ['auth', 'me'] as const;

export function useMe() {
  return useQuery({
    queryKey: meQueryKey,
    queryFn: ({ signal }) => fetchMe(signal),
    staleTime: 60_000,
    retry: false,
  });
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: LoginPayload) => login(payload),
    onSuccess: (me) => queryClient.setQueryData<Me | null>(meQueryKey, me),
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  const router = useRouter();
  return useMutation({
    mutationFn: logout,
    onSettled: () => {
      queryClient.clear();
      queryClient.setQueryData<Me | null>(meQueryKey, null);
      router.replace('/login');
    },
  });
}

export function can(me: Pick<Me, 'permissions'> | null | undefined, permission: string): boolean {
  return !!me?.permissions.includes(permission);
}
