'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * A per-browser UI preference in localStorage (D141: column choice, summary open/closed). The key
 * should carry the user id so two staff on one computer keep their own choice. Storage can be
 * missing or throw (private mode, blocked site data): the default is used and nothing breaks.
 * The first render uses the default (same as the server render); the stored value follows.
 */
export function usePersistedState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(initial);
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(key);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- read once after hydration
      if (raw !== null) setValue(JSON.parse(raw) as T);
    } catch {
      /* keep the default */
    }
  }, [key]);
  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const v = typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
        try {
          window.localStorage.setItem(key, JSON.stringify(v));
        } catch {
          /* not saved; still applied */
        }
        return v;
      });
    },
    [key],
  );
  return [value, set] as const;
}

/** `true` while the viewport matches the query (client only; `false` on the server render). */
export function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}
