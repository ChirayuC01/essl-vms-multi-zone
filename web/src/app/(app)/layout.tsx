"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { AlertBadge } from "@/components/alerts";
import { getApiBase, type Branding, type Health } from "@/lib/api";
import { useApi } from "@/lib/swr";

// Sidebar navigation (owner-approved design, 14 Oct 2026): the pages in five
// groups, the site at the top, the operator at the bottom. Collapses to an
// icon rail on desktop and becomes a drawer on a phone.
//
// `permission` hides an entry a role cannot use, and a group with nothing
// left disappears. Courtesy, not security — the API refuses these
// independently, and treating a hidden link as protection is how client-side
// checks quietly become load-bearing.

interface NavItem {
  href: string;
  label: string;
  permission?: string;
  icon: string;
}
const GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: "Overview",
    items: [
      {
        href: "/",
        label: "Dashboard",
        permission: "dashboard:view",
        icon: "M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z",
      },
      {
        href: "/inside",
        label: "Inside now",
        permission: "onsite:view",
        icon: "M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M3 12h11M10 8l4 4-4 4",
      },
      {
        href: "/reports",
        label: "Reports",
        permission: "reports:view",
        icon: "M4 20V10M10 20V4M16 20v-7M22 20H2",
      },
    ],
  },
  {
    label: "Visitors",
    items: [
      {
        href: "/requests",
        label: "Requests",
        permission: "visit_requests:view",
        icon: "M3 13l3-8h12l3 8v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM3 13h5l1 3h6l1-3h5",
      },
      {
        href: "/walk-in",
        label: "Walk-in",
        permission: "walkins:create",
        icon: "M15 20v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M8.5 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM19 8v6M16 11h6",
      },
      {
        href: "/provision",
        label: "Provision",
        permission: "passes:create",
        icon: "M3 6h18v12H3zM7 14h4M7 10.5a1.5 1.5 0 1 0 3 0 1.5 1.5 0 0 0-3 0M14 10h4M14 14h3",
      },
      {
        href: "/outages",
        label: "Outages",
        permission: "outages:view",
        icon: "M13 2L4 14h7l-1 8 9-12h-7z",
      },
    ],
  },
  {
    label: "People",
    items: [
      {
        href: "/people",
        label: "People",
        permission: "people:view",
        icon: "M16 20v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 20v-1a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
      },
      {
        href: "/directory",
        label: "Directory",
        permission: "directory:view",
        icon: "M4 21V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v16M15 9h4a1 1 0 0 1 1 1v11M3 21h18M8 8h3M8 12h3M8 16h3",
      },
    ],
  },
  {
    label: "Site setup",
    items: [
      {
        href: "/devices",
        label: "Devices",
        permission: "devices:view",
        icon: "M7 3H5a2 2 0 0 0-2 2v2M17 3h2a2 2 0 0 1 2 2v2M7 21H5a2 2 0 0 1-2-2v-2M17 21h2a2 2 0 0 0 2-2v-2M9 10h.01M15 10h.01M9 15a4 4 0 0 0 6 0",
      },
      {
        href: "/zones",
        label: "Zones",
        permission: "zones:view",
        icon: "M12 3l9 5-9 5-9-5zM3 13l9 5 9-5",
      },
      {
        href: "/pass-types",
        label: "Pass types",
        permission: "pass_types:view",
        icon: "M3 9V6a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v3a3 3 0 0 0 0 6v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-3a3 3 0 0 0 0-6zM14 5v3M14 11v2M14 16v3",
      },
    ],
  },
  {
    label: "Administration",
    items: [
      {
        href: "/commands",
        label: "Command queue",
        permission: "commands:view",
        icon: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
      },
      {
        href: "/operators",
        label: "Operators",
        permission: "operators:view",
        icon: "M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21v-1a6 6 0 0 1 8-5.66M17 14v3l2 1M17 22a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
      },
      {
        href: "/access",
        label: "Access",
        permission: "access:view",
        icon: "M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6zM9 12l2 2 4-4",
      },
      {
        href: "/settings",
        label: "Settings",
        permission: "settings:view",
        icon: "M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M16 4v4M8 10v4M16 16v4",
      },
      {
        href: "/outbox",
        label: "Outbox",
        permission: "messages:view",
        icon: "M3 6h18v12H3zM3 7l9 6 9-6",
      },
    ],
  },
];

const COLLAPSED_KEY = "vms.sidebarCollapsed";

function Icon({ d, size = 20 }: { d: string; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      <path d={d} />
    </svg>
  );
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, loading, signOut, can } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const { data: branding } = useApi<Branding>("/api/branding");
  const { data: health } = useApi<Health>("/health", {
    revalidateOnFocus: false,
  });
  // Remembered per browser: a convenience, so storage may be unavailable.
  // Read on first render: the shell is never server-rendered (it waits for
  // the signed-in operator), so there is no hydration to disagree with.
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return (
        typeof window !== "undefined" &&
        window.localStorage.getItem(COLLAPSED_KEY) === "1"
      );
    } catch {
      return false; // private window or blocked storage: start expanded
    }
  });
  // The phone drawer remembers the page it was opened on, so choosing a page
  // closes it without an effect.
  const [drawerOpenOn, setDrawerOpenOn] = useState<string | null>(null);
  const drawerOpen = drawerOpenOn === pathname;
  const setDrawerOpen = (open: boolean) =>
    setDrawerOpenOn(open ? pathname : null);
  const toggleCollapsed = () => {
    setCollapsed((was) => {
      try {
        window.localStorage.setItem(COLLAPSED_KEY, was ? "0" : "1");
      } catch {
        /* ignore */
      }
      return !was;
    });
  };
  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  useEffect(() => {
    if (branding?.organizationName)
      document.title = `${branding.organizationName} · VMS`;
  }, [branding?.organizationName]);

  // A forced password change is enforced by the API, which refuses every
  // other route. Redirecting is so the operator sees the reason instead of a
  // dashboard where each panel fails on its own.
  useEffect(() => {
    if (
      !loading &&
      user?.mustChangePassword &&
      pathname !== "/change-password"
    ) {
      router.replace("/change-password");
    }
  }, [loading, user, pathname, router]);

  // Render nothing rather than a flash of the console to someone who is not
  // signed in. The real guard is the API, which rejects every request without
  // a token; this is only about not showing an empty shell.
  if (loading || !user) {
    return (
      <main className="flex flex-1 items-center justify-center">
        <p className="text-sm text-[var(--text-muted)]">
          {loading ? "Loading…" : "Redirecting…"}
        </p>
      </main>
    );
  }

  const groups = GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((item) => !item.permission || can(item.permission)),
  })).filter((g) => g.items.length > 0);
  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);
  const current = groups
    .flatMap((g) => g.items.map((item) => ({ group: g.label, item })))
    .find((x) => isActive(x.item.href));
  const initials = (user.name ?? user.email)
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

  // One menu, drawn as the desktop sidebar (`rail` = collapsed) or the phone drawer.
  const menu = (rail: boolean, onClose?: () => void) => (
    <nav
      aria-label="Main"
      className="flex h-full flex-col bg-[var(--surface)]"
      onKeyDown={
        onClose
          ? (e) => {
              if (e.key === "Escape") onClose();
            }
          : undefined
      }
    >
      <div
        className={`flex h-16 shrink-0 items-center gap-2.5 border-b border-[var(--border)] ${rail ? "justify-center px-2" : "px-4"}`}
      >
        {branding?.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- runtime-configured cross-origin asset
          <img
            src={`${getApiBase()}${branding.logoUrl}`}
            alt=""
            className="h-9 w-9 shrink-0 rounded-[10px] object-contain"
          />
        ) : (
          <span
            aria-hidden="true"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-[var(--brand)] text-[13px] font-bold text-[var(--brand-contrast)]"
          >
            VMS
          </span>
        )}
        {!rail && (
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate font-semibold">
              {branding?.organizationName ?? "VMS"}
            </span>
            <span className="text-[11px] text-[var(--text-muted)]">
              {health?.version ? ` v${health.version}` : ""}
            </span>
          </div>
        )}
        {onClose && (
          <button
            type="button"
            aria-label="Close menu"
            onClick={onClose}
            className="flex h-11 w-11 items-center justify-center rounded-[10px] hover:bg-[var(--surface-muted)]"
          >
            <Icon d="M6 6l12 12M18 6L6 18" />
          </button>
        )}
      </div>

      <div
        className={`flex flex-1 flex-col gap-4 overflow-y-auto py-3 ${rail ? "px-2.5" : "px-3"}`}
      >
        {groups.map((group, gi) => (
          <div key={group.label} className="flex flex-col gap-0.5">
            {rail ? (
              gi > 0 && (
                <div
                  aria-hidden="true"
                  className="mx-3 mb-2 h-px bg-[var(--border)]"
                />
              )
            ) : (
              <div className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--text-muted)]">
                {group.label}
              </div>
            )}
            {group.items.map((item) => {
              const active = isActive(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  aria-label={rail ? item.label : undefined}
                  title={rail ? item.label : undefined}
                  className={`flex min-h-10 items-center gap-3 rounded-lg px-3 text-sm transition-colors ${rail ? "justify-center" : ""} ${
                    active
                      ? "bg-[var(--active-bg)] font-semibold text-[var(--active-text)]"
                      : "font-medium hover:bg-[var(--surface-muted)]"
                  }`}
                >
                  <Icon d={item.icon} />
                  {!rail && (
                    <span className="flex-1 truncate">{item.label}</span>
                  )}
                </Link>
              );
            })}
          </div>
        ))}
      </div>

      <div
        className={`flex shrink-0 flex-col gap-1 border-t border-[var(--border)] py-3 ${rail ? "px-2.5" : "px-3"}`}
      >
        <Link
          href="/profile"
          title="My profile"
          className={`flex min-h-12 items-center gap-2.5 rounded-lg px-2 hover:bg-[var(--surface-muted)] ${rail ? "justify-center" : ""}`}
        >
          <span
            aria-hidden="true"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface-muted)] text-xs font-semibold"
          >
            {initials}
          </span>
          {rail ? (
            <span className="sr-only">My profile</span>
          ) : (
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-semibold">
                {user.name ?? user.email}
              </span>
              <span className="truncate text-xs text-[var(--text-muted)]">
                {user.role}
              </span>
            </span>
          )}
        </Link>
        <div className={`flex gap-1 ${rail ? "flex-col" : ""}`}>
          <button
            type="button"
            onClick={signOut}
            aria-label={rail ? "Sign out" : undefined}
            title={rail ? "Sign out" : undefined}
            className="flex min-h-10 flex-1 items-center justify-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 text-sm hover:bg-[var(--surface-muted)]"
          >
            <Icon
              d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"
              size={18}
            />
            {!rail && "Sign out"}
          </button>
          {!onClose && (
            <button
              type="button"
              onClick={toggleCollapsed}
              aria-label={rail ? "Expand menu" : "Collapse menu"}
              aria-expanded={!rail}
              title={rail ? "Expand menu" : "Collapse menu"}
              className="flex min-h-10 w-10 shrink-0 items-center justify-center self-center rounded-lg border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-muted)]"
            >
              <Icon
                d={
                  rail
                    ? "M4 4h16v16H4zM9 4v16M13 9l3 3-3 3"
                    : "M4 4h16v16H4zM9 4v16M16 9l-3 3 3 3"
                }
                size={18}
              />
            </button>
          )}
        </div>
      </div>
    </nav>
  );

  return (
    <div className="flex min-h-full flex-1">
      {/* Desktop: sticky to the viewport so the menu stays in reach on long pages. */}
      <aside
        className={`sticky top-0 hidden h-screen shrink-0 border-r border-[var(--border)] md:block ${collapsed ? "w-[72px]" : "w-[248px]"}`}
      >
        {menu(collapsed)}
      </aside>

      {/* Phone: a drawer over the dimmed page. */}
      {drawerOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <button
            type="button"
            aria-label="Close menu"
            className="absolute inset-0 h-full w-full bg-black/45"
            onClick={() => setDrawerOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 w-[300px] max-w-[85vw] shadow-2xl">
            {menu(false, () => setDrawerOpen(false))}
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-14 items-center gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-2 md:min-h-16 md:px-8">
          <button
            type="button"
            aria-label="Open menu"
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen(true)}
            className="flex h-11 w-11 items-center justify-center rounded-[10px] hover:bg-[var(--surface-muted)] md:hidden"
          >
            <Icon d="M4 6h16M4 12h16M4 18h16" size={22} />
          </button>
          {/* The page's own heading stays its h1; this is orientation only. */}
          <div className="flex min-w-0 flex-1 flex-col">
            {current && (
              <span className="hidden text-xs text-[var(--text-muted)] md:block">
                {current.group}
              </span>
            )}
            <span className="truncate text-base font-semibold">
              {current?.item.label ?? ""}
            </span>
          </div>
          <AlertBadge />
        </header>

        <main className="mx-auto w-full max-w-6xl flex-1 p-4 md:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
