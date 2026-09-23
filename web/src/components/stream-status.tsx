"use client";

/**
 * Status of the browser's event stream — NOT the device connection.
 *
 * These are easy to confuse: the dot stays green while a terminal sits
 * unplugged, because it describes this browser's link to the backend. It is
 * labelled and captioned explicitly for that reason. Device liveness is the
 * online/offline badge on the device itself.
 */
export function StreamStatus({ connected }: { connected: boolean }) {
  return (
    <span
      className="flex items-center gap-2 text-xs text-[var(--text-muted)]"
      title={
        connected
          ? "This page is receiving live updates from the server. This is not the device's connection status."
          : "Live updates are interrupted; the page is polling instead. This is not the device's connection status."
      }
    >
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${
          connected ? "bg-[var(--ok)]" : "bg-[var(--danger)]"
        }`}
      />
      {connected ? "Live updates on" : "Live updates reconnecting…"}
    </span>
  );
}
