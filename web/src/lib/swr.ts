"use client";

import useSWR, { mutate as globalMutate, type SWRConfiguration } from "swr";
import { api } from "./api";

// Data fetching for the console.
//
// SWR rather than hand-rolled useEffect + useState: the token lives in the
// browser (the SSE stream needs one it can read), so server components cannot
// fetch this data, and fetching in an effect causes exactly the cascading
// renders React now warns about. SWR also gives revalidate-on-focus for free,
// which matters for a screen someone leaves open on a gate desk all day.

export function useApi<T>(path: string | null, options?: SWRConfiguration<T>) {
  return useSWR<T>(path, (key: string) => api<T>(key), {
    revalidateOnFocus: true,
    ...options,
  });
}

/**
 * Refresh every cached query whose path starts with `prefix`. Used after an
 * action and on live events — a provision touches people, entries, commands
 * and the device's face count at once, so refreshing by prefix keeps the
 * whole screen consistent instead of one card at a time.
 */
export function refresh(prefix: string): Promise<unknown> {
  return globalMutate(
    (key) => typeof key === "string" && key.startsWith(prefix),
    undefined,
    { revalidate: true },
  );
}
