"use client";

import { useEffect, useRef, useState } from "react";
import { getApiBase, getToken, type Command, type Entry, type Punch } from "./api";

// Live updates over SSE. EventSource reconnects by itself, so there is no
// retry logic here — only the connection state, so the UI can say plainly
// whether it is currently live rather than showing stale data as if it were
// current.

export interface StreamHandlers {
  onPunch?: (punch: Punch) => void;
  onCommand?: (command: StreamCommand) => void;
  onEntry?: (entry: StreamEntry) => void;
}

/** The stream carries a lighter command shape than the REST list. */
export type StreamCommand = Pick<
  Command,
  "id" | "type" | "status" | "deviceCmdId" | "personId" | "entryId" | "lastError"
> & { targetDeviceId: string };

export type StreamEntry = Pick<Entry, "id" | "personId" | "state" | "dayBlocked">;

export function useEventStream(handlers: StreamHandlers): { connected: boolean } {
  const [connected, setConnected] = useState(false);
  // Held in a ref so re-renders (which recreate the handler closures) do not
  // tear down and rebuild the connection on every keystroke elsewhere. Written
  // in an effect, never during render — a ref mutated while rendering is not
  // guaranteed to be the value the committed tree sees.
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    const token = getToken();
    if (!token) return;

    const source = new EventSource(`${getApiBase()}/api/events?token=${encodeURIComponent(token)}`);

    const parse = <T,>(event: MessageEvent, run: ((value: T) => void) | undefined): void => {
      if (!run) return;
      try {
        run(JSON.parse(event.data) as T);
      } catch {
        /* a malformed frame must not kill the stream */
      }
    };

    source.addEventListener("ready", () => setConnected(true));
    source.addEventListener("punch", (e) => parse<Punch>(e as MessageEvent, handlersRef.current.onPunch));
    source.addEventListener("command", (e) =>
      parse<StreamCommand>(e as MessageEvent, handlersRef.current.onCommand),
    );
    source.addEventListener("entry", (e) =>
      parse<StreamEntry>(e as MessageEvent, handlersRef.current.onEntry),
    );
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);

    return () => {
      source.close();
      setConnected(false);
    };
  }, []);

  return { connected };
}
