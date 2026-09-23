"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, type SetupStatus } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Alert, Button, Field, Input, PasswordInput } from "@/components/ui";

// First-run wizard. Reachable exactly once, on a database with zero
// operators — GET /setup/status is checked on mount, and again the server
// refuses POST /setup/admin the moment any operator exists, so this page
// self-closes rather than needing to be hidden or removed later.
export default function SetupPage() {
  const { signIn } = useAuth();
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  const [logo, setLogo] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api<SetupStatus>("/api/setup/status")
      .then((status) => {
        if (cancelled) return;
        if (!status.needsSetup) {
          router.replace("/login");
          return;
        }
        setChecking(false);
      })
      .catch(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (password !== confirmPassword) {
      setError("passwords do not match");
      return;
    }
    setSubmitting(true);
    try {
      const logoBase64 = logo
        ? await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
            reader.onerror = () => reject(new Error("could not read logo"));
            reader.readAsDataURL(logo);
          })
        : undefined;
      await api("/api/setup/admin", { method: "POST", body: { email, password, organizationName, logoBase64 } });
      await signIn(email, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "setup failed");
    } finally {
      setSubmitting(false);
    }
  }

  if (checking) {
    return (
      <main className="flex flex-1 items-center justify-center">
        <p className="text-sm text-[var(--text-muted)]">Loading…</p>
      </main>
    );
  }

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm space-y-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-6"
      >
        <div>
          <h1 className="text-lg font-semibold">Set up the Visitor Management System</h1>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            No administrator account exists yet. Create the first one to continue.
          </p>
        </div>

        {error && <Alert>{error}</Alert>}

        <Field label="Organization name">
          <Input required maxLength={120} value={organizationName} onChange={(e) => setOrganizationName(e.target.value)} placeholder="Your organization" />
        </Field>

        <Field label="Organization logo" hint="Optional PNG, JPEG, or WebP; maximum 2 MB">
          <Input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => setLogo(e.target.files?.[0] ?? null)} />
        </Field>

        <Field label="Email">
          <Input
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="admin@example.com"
          />
        </Field>

        <Field label="Password" hint="at least 10 characters">
          <PasswordInput
            autoComplete="new-password"
            required
            minLength={10}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>

        <Field label="Confirm password">
          <PasswordInput
            autoComplete="new-password"
            required
            minLength={10}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
          />
        </Field>

        <Button type="submit" variant="primary" loading={submitting} className="w-full">
          Create administrator account
        </Button>
      </form>
    </main>
  );
}
