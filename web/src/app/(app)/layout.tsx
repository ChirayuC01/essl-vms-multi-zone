"use client";

import { useEffect } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui";
import { AlertBadge } from "@/components/alerts";
import { getApiBase, type Branding, type Health } from "@/lib/api";
import { useApi } from "@/lib/swr";

// `permission` hides a nav entry a role cannot use. Courtesy, not security —
// the API refuses these independently, and treating a hidden link as
// protection is how client-side checks quietly become load-bearing.
const NAV: { href: string; label: string; permission?: string }[] = [
  { href: "/", label: "Dashboard", permission: "dashboard:view" },
  { href: "/inside", label: "Inside Now", permission: "onsite:view" },
  { href: "/requests", label: "Requests", permission: "visit_requests:view" },
  { href: "/walk-in", label: "Walk-in", permission: "walkins:create" },
  { href: "/provision", label: "Provision", permission: "passes:create" },
  { href: "/people", label: "People", permission: "people:view" },
  { href: "/commands", label: "Command Queue", permission: "commands:view" },
  { href: "/devices", label: "Devices", permission: "devices:view" },
  { href: "/reports", label: "Reports", permission: "reports:view" },
  { href: "/directory", label: "Directory", permission: "directory:view" },
  { href: "/pass-types", label: "Pass types", permission: "pass_types:view" },
  { href: "/settings", label: "Settings", permission: "settings:view" },
  { href: "/operators", label: "Operators", permission: "operators:view" },
  { href: "/access", label: "Access", permission: "access:view" },
  { href: "/outbox", label: "Outbox", permission: "messages:view" },
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, loading, signOut, can } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const { data: branding } = useApi<Branding>("/api/branding");
  const { data: health } = useApi<Health>("/health", { revalidateOnFocus: false });

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  useEffect(() => {
    if (branding?.organizationName) document.title = `${branding.organizationName} · VMS`;
  }, [branding?.organizationName]);

  // A forced password change is enforced by the API, which refuses every
  // other route. Redirecting is so the operator sees the reason instead of a
  // dashboard where each panel fails on its own.
  useEffect(() => {
    if (!loading && user?.mustChangePassword && pathname !== "/change-password") {
      router.replace("/change-password");
    }
  }, [loading, user, pathname, router]);

  // Render nothing rather than a flash of the console to someone who is not
  // signed in. The real guard is the API, which rejects every request without
  // a token; this is only about not showing an empty shell.
  if (loading || !user) {
    return (
      <main className="flex flex-1 items-center justify-center">
        <p className="text-sm text-[var(--text-muted)]">{loading ? "Loading…" : "Redirecting…"}</p>
      </main>
    );
  }

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="border-b border-[var(--border)] bg-[var(--surface)]">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          {branding?.logoUrl && (
            // eslint-disable-next-line @next/next/no-img-element -- runtime-configured cross-origin asset
            <img src={`${getApiBase()}${branding.logoUrl}`} alt="" className="h-8 w-8 object-contain" />
          )}
          <div className="flex items-baseline gap-1.5">
            <span className="font-semibold">{branding?.organizationName ?? "VMS"}</span>
            {health?.version && (
              <span className="text-[10px] text-[var(--text-muted)]" title="VMS version">
                v{health.version}
              </span>
            )}
          </div>
          <nav className="flex flex-1 flex-wrap gap-1">
            {NAV.filter((item) => !item.permission || can(item.permission)).map((item) => {
              const active =
                item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`rounded-[var(--radius)] px-3 py-1.5 text-sm transition-colors ${
                    active
                      ? "bg-[var(--brand)] text-[var(--brand-contrast)]"
                      : "hover:bg-[var(--surface-muted)]"
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
          <AlertBadge />
          <Link
            href="/profile"
            className="text-xs text-[var(--text-muted)] hover:underline"
            title="My profile"
          >
            {user.name ?? user.email} · {user.role}
          </Link>
          <Button onClick={signOut}>Sign out</Button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 p-4">{children}</main>
    </div>
  );
}
