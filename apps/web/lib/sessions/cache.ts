import type { BoardDto, SessionDetailDto, SessionDto } from '@qarabic/shared';
import type { QueryClient } from '@tanstack/react-query';
import { requestKeys } from '@/lib/api/requests';
import { scheduleKeys } from '@/lib/api/schedule';
import { sessionKeys } from '@/lib/api/sessions';

/**
 * After a write: the returned class goes into every board and its detail at once (no flicker),
 * then the lists, enrollments and requests refetch in the background.
 */
export function upsertSession(queryClient: QueryClient, s: SessionDto) {
  for (const [key, data] of queryClient.getQueriesData<BoardDto>({
    queryKey: [...sessionKeys.all, 'board'],
  })) {
    if (!data) continue;
    queryClient.setQueryData<BoardDto>(key, {
      ...data,
      sessions: data.sessions.map((row) => (row.id === s.id ? s : row)),
    });
  }
  queryClient.setQueryData<SessionDetailDto>(sessionKeys.detail(s.id), (old) =>
    old ? { ...old, ...s } : old,
  );
  void queryClient.invalidateQueries({ queryKey: sessionKeys.all });
  void queryClient.invalidateQueries({ queryKey: scheduleKeys.all });
  void queryClient.invalidateQueries({ queryKey: requestKeys.all });
}

export function refreshClasses(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: sessionKeys.all });
  void queryClient.invalidateQueries({ queryKey: scheduleKeys.all });
  void queryClient.invalidateQueries({ queryKey: requestKeys.all });
}
