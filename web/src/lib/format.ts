// Presentation helpers. Timestamps arrive as UTC ISO strings and are rendered
// in India Standard Time. Client Windows hosts are sometimes configured in
// UTC, so relying on the browser's local timezone produces field-visible skew.

const IST = "Asia/Kolkata";

/** PostgreSQL `timestamp without time zone` values represent UTC in this
 * product, but some query paths serialize them without a trailing Z. Browsers
 * otherwise reinterpret those clock fields in their own local timezone. */
function instant(value: string): Date {
  const normalized = value.replace(" ", "T");
  return new Date(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(normalized)
      ? `${normalized}Z`
      : normalized,
  );
}

export function formatDateInputIst(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-IN", {
    timeZone: IST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/**
 * The last instant of the `days`-th IST calendar day counting `from`'s day as
 * day 1 — the server's pass-length rule (`passLengthProblem`).
 */
export function endOfIstDay(from: Date, days = 1): Date {
  const offset = 330 * 60_000;
  const ist = new Date(from.getTime() + offset);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + days) - offset - 1);
}

export function dayOfMonthIst(value: Date): number {
  return Number(new Intl.DateTimeFormat("en-IN", { timeZone: IST, day: "numeric" }).format(value));
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  return instant(value).toLocaleString("en-IN", {
    timeZone: IST,
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }) + " IST";
}

export function formatTime(value: string | null | undefined): string {
  if (!value) return "—";
  return instant(value).toLocaleTimeString("en-IN", {
    timeZone: IST,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }) + " IST";
}

export function formatRelative(value: string | null | undefined, now = Date.now()): string {
  if (!value) return "never";
  const seconds = Math.round((now - instant(value).getTime()) / 1000);
  if (seconds < 0) return "clock ahead";
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * How long someone has been inside, as a duration rather than a clock time.
 *
 * Judged against a reference instant supplied by the caller — the server's
 * clock, not the browser's. A gate PC with a drifted clock would otherwise
 * report someone as three hours overdue, or not overdue at all.
 */
export function formatDuration(from: string | null, until: number): string {
  if (!from) return "—";
  const minutes = Math.floor((until - instant(from).getTime()) / 60_000);
  if (minutes < 0) return "—";
  if (minutes < 1) return "just arrived";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/** Time remaining until a window closes, or how long ago it closed. */
export function formatWindow(expiresAt: string | null, now: number): string {
  if (!expiresAt) return "no expiry";
  const minutes = Math.round((instant(expiresAt).getTime() - now) / 60_000);
  if (minutes <= 0) return `lapsed ${formatDuration(expiresAt, now)} ago`;
  if (minutes < 60) return `${minutes}m left`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h left`;
  return `${Math.round(hours / 24)}d left`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "—";
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/** 15 = face on this firmware; the rest are shown as-is rather than guessed. */
export function verifyModeLabel(mode: number | null): string {
  if (mode === 15) return "face";
  if (mode === null) return "—";
  return `mode ${mode}`;
}

export function titleCase(value: string): string {
  return value
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}


// One wording per state, used by every page (pre-demo sweep, 14 Oct 2026):
// raw database words never reach an operator.

const REQUEST_STATUS: Record<string, string> = {
  SENT: "Details pending",
  SUBMITTED: "Awaiting decision",
  QUERIED: "Queried",
  CLEARED: "Cleared",
  REJECTED: "Rejected",
  CANCELLED: "Cancelled",
  EXPIRED: "Expired",
};
export const requestStatusLabel = (status: string) => REQUEST_STATUS[status] ?? titleCase(status);

const PASS_STATE: Record<string, string> = {
  PENDING_PROVISION: "Provisioning",
  PROVISIONED: "Provisioned",
  INSIDE: "Inside",
  PENDING_DEPROVISION: "De-provisioning",
  REGISTERED: "Ended",
};
export const passStateLabel = (state: string) => PASS_STATE[state] ?? titleCase(state);

export const categoryLabel = (category: string) => (category === "EMPLOYEE" ? "Employee" : category === "VISITOR" ? "Visitor" : titleCase(category));
export const entryModeLabel = (mode: string) => (mode === "SINGLE_ENTRY" ? "Single entry" : mode === "MULTI_ENTRY" ? "Multi entry" : titleCase(mode));

const COMMAND_TYPE: Record<string, string> = {
  PROVISION: "Load person",
  PUSH_PHOTO: "Load photo",
  DEPROVISION: "Remove from device",
  BLOCK: "Block",
  UNBLOCK: "Unblock",
  QUERY_USER: "Check device",
  DEVICE_INFO: "Read device info",
  CLEAR_LOGS: "Clear device logs",
};
export const commandTypeLabel = (type: string) => COMMAND_TYPE[type] ?? titleCase(type);

const COMMAND_STATUS: Record<string, string> = { PENDING: "Queued", SENT: "Sent", SUCCESS: "Done", FAILED: "Failed", RETRY: "Retrying" };
export const commandStatusLabel = (status: string) => COMMAND_STATUS[status] ?? titleCase(status);

/** Visit request status → badge tone. SUBMITTED is the one waiting on the host. */
export function requestTone(status: string): "info" | "ok" | "warn" | "danger" | "neutral" {
  if (status === "SUBMITTED") return "info";
  if (status === "CLEARED") return "ok";
  if (status === "QUERIED") return "warn";
  if (status === "REJECTED") return "danger";
  return "neutral";
}
