"use client";
/* eslint-disable @next/next/no-img-element -- the logo is served by the runtime API, not a build-time image host. */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, getApiBase, type Branding, type SetupStatus } from "@/lib/api";
import { useApi } from "@/lib/swr";
import { useAuth } from "@/lib/auth";
import { Alert, Button, Field, Input, PasswordInput } from "@/components/ui";

export default function LoginPage() {
  const { user, loading, signIn } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const { data: branding } = useApi<Branding>("/api/branding");

  useEffect(() => {
    if (branding?.organizationName) document.title = `${branding.organizationName} · VMS`;
  }, [branding?.organizationName]);

  useEffect(() => {
    if (!loading && user) router.replace("/");
  }, [loading, user, router]);

  // A brand-new install has no operator to sign in as — send it straight to
  // the wizard instead of a login form for an account that doesn't exist.
  useEffect(() => {
    api<SetupStatus>("/api/setup/status")
      .then((status) => {
        if (status.needsSetup) router.replace("/setup");
      })
      .catch(() => {
        // Backend unreachable or erroring — let the normal login form show
        // and fail in the usual way rather than silently redirecting.
      });
  }, [router]);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await signIn(email, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "sign in failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm space-y-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-6"
      >
        <div>
          {branding?.logoUrl && <img src={`${getApiBase()}${branding.logoUrl}`} alt="" className="mb-3 h-16 max-w-full object-contain" />}
          <h1 className="text-lg font-semibold">{branding?.organizationName ?? "Visitor Management System"}</h1>
          <p className="mt-1 text-sm text-[var(--text-muted)]">Sign in to continue</p>
        </div>

        {error && <Alert>{error}</Alert>}

        <Field label="Email">
          <Input
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="admin@vms.local"
          />
        </Field>

        <Field label="Password">
          <PasswordInput
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>

        <Button type="submit" variant="primary" loading={submitting} className="w-full">
          Sign in
        </Button>
      </form>
    </main>
  );
}
