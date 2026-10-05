// Single point of contact with the backend.
//
// The API lives on a different origin (the backend also serves the device
// endpoints and must run independently of this UI), so requests go out
// cross-origin with a bearer token rather than through a Next proxy. That
// keeps the SSE stream a direct connection, which is the one thing a proxy
// tends to quietly buffer.

// window.__VMS_API_BASE__ is injected by the root layout from the
// server-side-only API_BASE_URL env var, read fresh at request time — unlike
// NEXT_PUBLIC_API_URL, which webpack inlines at build time and can't change
// after the installer packages the app. Falls through to NEXT_PUBLIC_API_URL
// for `npm run dev`, where no such script is injected.
declare global {
  interface Window {
    __VMS_API_BASE__?: string;
  }
}

// The installed web service and backend share one machine. `localhost` is
// correct when the console is opened there, but in a browser on another LAN
// device it means that other device. Keep the configured protocol/port and
// use the hostname that actually served the page.
export function getApiBase(): string {
  const configured =
    (typeof window !== "undefined" && window.__VMS_API_BASE__) ||
    process.env.NEXT_PUBLIC_API_URL ||
    "http://localhost:47102";
  return typeof window !== "undefined" && /^https?:\/\/(?:localhost|127\.0\.0\.1)(?=[:/]|$)/i.test(configured)
    ? configured.replace(/^(https?:\/\/)(?:localhost|127\.0\.0\.1)/i, `$1${window.location.hostname}`)
    : configured;
}
const TOKEN_KEY = "vms.token";

export interface Health {
  status: string;
  version: string;
  database: string;
  postgres: string;
}

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (typeof window === "undefined") return;
  if (token) window.localStorage.setItem(TOKEN_KEY, token);
  else window.localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Raw binary body (photo upload) — sent as-is with its own content type. */
  blob?: { data: Blob | ArrayBuffer; contentType: string };
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const apiBase = getApiBase();
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  let body: BodyInit | undefined;
  if (options.blob) {
    headers["Content-Type"] = options.blob.contentType;
    body = options.blob.data as BodyInit;
  } else if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(`${apiBase}${path}`, {
      method: options.method ?? "GET",
      headers,
      ...(body === undefined ? {} : { body }),
    });
  } catch {
    // A dead backend and a dead network look identical from here; say the
    // useful thing rather than surfacing "Failed to fetch".
    throw new ApiError(0, `cannot reach the VMS backend at ${apiBase}`);
  }

  const isJson = response.headers.get("content-type")?.includes("application/json");
  const payload = isJson ? await response.json() : await response.text();

  if (response.status === 401) {
    setToken(null);
    if (path === "/api/auth/login") {
      const message =
        typeof payload === "object" && payload !== null && "error" in payload
          ? String((payload as { error: unknown }).error)
          : "invalid email or password";
      throw new ApiError(401, message);
    }
    if (typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
      window.location.href = "/login";
    }
    throw new ApiError(401, "session expired — sign in again");
  }

  if (response.status === 402 && typeof window !== "undefined" && !window.location.pathname.startsWith("/license")) {
    window.location.href = "/license";
  }

  if (response.status === 204) return undefined as T;

  if (!response.ok) {
    const message =
      typeof payload === "object" && payload !== null && "error" in payload
        ? String((payload as { error: unknown }).error)
        : `request failed (${response.status})`;
    throw new ApiError(response.status, message);
  }
  return payload as T;
}

// ---------------------------------------------------------------------------
// Shapes returned by the backend (kept in step with backend/src/api/*)
// ---------------------------------------------------------------------------

export interface Paged<T> {
  total: number;
  page: number;
  pageSize: number;
  items: T[];
}

export interface Person {
  id: string;
  name: string;
  category: "EMPLOYEE" | "VISITOR";
  companyId: string | null;
  company: DirectoryItem | null;
  departmentId: string | null;
  department: DirectoryItem | null;
  mobile: string | null;
  /** Null only for people registered before this field was mandatory. */
  aadharNumber: string | null;
  panNumber: string | null;
  esslUserId: string;
  isActive: boolean;
  resignedAt: string | null;
  resignedReason: string | null;
  hasPhoto: boolean;
  profileComplete: boolean;
  needsDetails: boolean;
  createdAt: string;
}

export interface PersonDetail extends Person {
  /** Enrolled at the terminal by someone else; on the device but unmanaged. */
  adoptedFromDevice: boolean;
  biometric: {
    photoUrl: string;
    photoSizeBytes: number | null;
    algorithmVersion: string | null;
    hasCachedTemplate: boolean;
    capturedAt: string;
  } | null;
  entries: Entry[];
  employeeAccess: EmployeeDeviceAccess[];
}

export interface DirectoryItem {
  id: string;
  name: string;
  isActive: boolean;
}

export interface DirectoryList { items: DirectoryItem[] }

export interface Zone extends DirectoryItem {
  parentZoneId: string | null;
  /** Whether this zone's exit is code-gated by default on a single-entry pass. */
  exitCodeDefault: boolean;
  gates: { IN: number; OUT: number; BOTH: number };
  /** Set while the zone lacks an entry or exit terminal. */
  warning: string | null;
}

export interface ZoneList { items: Zone[] }

export interface EmployeeDeviceAccess {
  id: string;
  desiredAccess: boolean;
  provisioned: boolean;
  assignedAt: string;
  removedAt: string | null;
  removalReason: string | null;
  device: { id: string; name: string | null; serialNo: string };
}

export type EntryState =
  | "REGISTERED"
  | "PENDING_PROVISION"
  | "PROVISIONED"
  | "INSIDE"
  | "PENDING_DEPROVISION";

export interface Entry {
  id: string;
  personId: string;
  state: EntryState;
  dayBlocked: boolean;
  retentionPolicy: string;
  retentionExpiresAt: string | null;
  entryMode: string;
  /** Null only on entries authorized before the field existed. */
  purposeOfVisit: string | null;
  personToMeetId: string | null;
  personToMeet: { id: string; name: string | null; email: string } | null;
  expectedInAt: string | null;
  inAt: string | null;
  outAt: string | null;
  createdAt: string;
  person?: { id: string; name: string; company: string | null; esslUserId: string };
}

export type CommandStatus = "PENDING" | "SENT" | "SUCCESS" | "FAILED" | "RETRY";

export interface Command {
  id: string;
  type: string;
  status: CommandStatus;
  device: { id: string; serialNo: string | null; name: string | null };
  deviceCmdId: number | null;
  attempts: number;
  lastError: string | null;
  payload: unknown;
  entryId: string | null;
  personId: string | null;
  person: { name: string; esslUserId: string } | null;
  initiatedById: string | null;
  createdAt: string;
  sentAt: string | null;
  completedAt: string | null;
}

export interface SetupStatus {
  needsSetup: boolean;
}

export interface LicenseStatus {
  installed: boolean;
  kind: "TRIAL" | "PAID" | null;
  plan: string | null;
  expiresAt: string | null;
  expired: boolean;
  expiringSoon: boolean;
  daysRemaining: number | null;
}

export interface Branding {
  organizationName: string;
  logoUrl: string | null;
}

export interface Device {
  id: string;
  name: string | null;
  serialNo: string;
  ip: string | null;
  role: string;
  zoneId: string | null;
  timezoneOffsetMinutes: number;
  firmwareVersion: string | null;
  algorithmVersion: string | null;
  maxFaces: number | null;
  facesUsed: number;
  normalGroupId: number;
  blockedGroupId: number;
  duplicatePunchPeriodMinutes: number | null;
  duplicatePunchWarning: string | null;
  employeeIdPatterns: string[];
  visitorIdPatterns: string[];
  lastSeenAt: string | null;
  online: boolean;
  queue: { pending: number; sent: number; retry: number; failed: number };
}

export interface DeviceList {
  items: Device[];
  unregistered: { serialNo: string; firstSeenAt: string; lastSeenAt: string; requests: number }[];
}

export interface ReportColumn {
  key: string;
  label: string;
}

export interface ReportSummary {
  key: string;
  title: string;
  description: string;
  group: string;
  filters: string[];
  columns: ReportColumn[];
}

export interface AuditFacets {
  actions: string[];
  actors: { id: string; email: string }[];
}

export interface AuditEntry {
  createdAt: string;
  action: string;
  actor: string;
  entityType: string | null;
  detail: unknown;
}

export interface AuditList {
  total: number;
  items: AuditEntry[];
}

export interface ReportList {
  total: number;
  items: ReportSummary[];
}

export interface ReportRun {
  key: string;
  title: string;
  description: string;
  columns: ReportColumn[];
  total: number;
  page: number;
  pageSize: number;
  rows: Record<string, unknown>[];
}

export interface OperatorAccount {
  id: string;
  email: string;
  name: string | null;
  phone: string | null;
  role: string;
  isActive: boolean;
  mustChangePassword: boolean;
  passwordChangedAt: string | null;
  createdAt: string;
}

export interface OperatorOption {
  id: string;
  email: string;
  name: string | null;
  phone: string | null;
}

export interface OperatorList {
  total: number;
  items: OperatorAccount[];
}

export interface OperatorOptionList {
  total: number;
  items: OperatorOption[];
}

export type AlertSeverity = "critical" | "warning" | "info";

export interface Alert {
  id: string;
  severity: AlertSeverity;
  title: string;
  detail: string;
  /** What to do about it. An alert without one is just noise. */
  action: string;
  entityType?: string;
  entityId?: string;
}

export interface AlertList {
  total: number;
  critical: number;
  warning: number;
  items: Alert[];
}

/** One row of the inside-now board. */
export interface BoardEntry {
  id: string;
  state: EntryState;
  dayBlocked: boolean;
  entryMode: string;
  /** Null only on entries authorized before the field existed. */
  purposeOfVisit: string | null;
  inAt: string | null;
  outAt: string | null;
  retentionPolicy: string;
  retentionExpiresAt: string | null;
  person: { id: string; name: string; company: string | null; esslUserId: string };
}

export interface Board {
  /**
   * The server's clock at the moment the board was built. "Overdue" and
   * "here for 3h" are judged against this rather than the browser's clock,
   * so a gate PC whose time has drifted cannot invent or hide an expiry.
   */
  serverTime: string;
  inside: BoardEntry[];
  dayBlocked: BoardEntry[];
}

export interface Punch {
  id: string;
  esslUserId: string;
  deviceId: string;
  deviceSerialNo: string;
  deviceName: string | null;
  punchedAtUtc: string;
  punchedAtDevice: string;
  receivedAt: string;
  verifyMode: number | null;
  statusCode: number | null;
  person: { id: string; name: string } | null;
}

/** Site settings (GET/PATCH /api/settings). Changing them is Admin-only and audited. */
export interface SiteSettings {
  entryLoadLeadMinutes: number;
  unloadAfterPunchMinutes: number;
  walkInRequiresHostClear: boolean;
  outageGapMinutes: number;
  visitorIdPrefix: string;
  linkExpiryHours: number;
  otpTtlMinutes: number;
  otpMaxAttempts: number;
  documentMaxMb: number;
  documentMaxCount: number;
  documentTypes: string[];
  privacyNoticeText: string;
  /** Server-set when the notice text changes; read-only. */
  privacyNoticeVersion: string | null;
}

/** An operator role (GET /api/roles). `key` is immutable; `name` is editable. */
export interface Role {
  id: string;
  key: string;
  name: string;
  description: string | null;
  /** The Administrator role: always holds everything, never edited. */
  isSystem: boolean;
  isActive: boolean;
  activeUsers: number;
}
export interface RoleList { items: Role[] }

export type AccessAction = "view" | "create" | "update" | "delete";
/** One feature row of the access grid (GET /api/access/catalogue). */
export interface AccessResource {
  key: string;
  label: string;
  group: string;
  actions: AccessAction[];
  notes?: Partial<Record<AccessAction, string>>;
}
export interface AccessCatalogue { items: AccessResource[] }

export interface RoleAccess { role: string; editable: boolean; permissions: string[] }
export interface PermissionOverride { permission: string; effect: "ALLOW" | "DENY" }
export interface OperatorAccess {
  role: string;
  editable: boolean;
  roleGrants: string[];
  overrides: PermissionOverride[];
  effective: string[];
}
