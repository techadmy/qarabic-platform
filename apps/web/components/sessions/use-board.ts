'use client';

import type { BoardDto } from '@qarabic/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchBoard, sessionKeys } from '@/lib/api/sessions';
import { mergeRows } from '@/lib/sessions/board';

/** Live polling every 15 s (D42); paused while the tab is hidden. */
export const BOARD_POLL_MS = 15_000;

/**
 * The Today board, live (docs/15 §5.9, §6.1): the first answer is the whole day; every 15 s the
 * next asks `since=cursor` and upserts the changed rows by id (removed ones leave). An unchanged
 * board is a 304 the browser answers from its cache.
 */
export function useBoard(date: string, tz: string, enabled = true) {
  const queryClient = useQueryClient();
  const key = sessionKeys.board(date, tz);
  return useQuery({
    queryKey: key,
    queryFn: async ({ signal }): Promise<BoardDto> => {
      const previous = queryClient.getQueryData<BoardDto>(key);
      const since = previous?.cursor ?? undefined;
      const next = await fetchBoard({ date, tz, since }, signal);
      if (!previous || !since) return next;
      return { ...next, sessions: mergeRows(previous.sessions, next.sessions) };
    },
    enabled,
    refetchInterval: BOARD_POLL_MS,
    refetchIntervalInBackground: false,
  });
}
