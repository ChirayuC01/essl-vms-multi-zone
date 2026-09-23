"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Alert, Button, Card, Field, PasswordInput } from "@/components/ui";

// Changing your own password, and the forced version of it.
//
// When `mustChangePassword` is set the API refuses everything except this and
// /auth/me, so there is nothing useful to navigate to — the page says why
// rather than letting someone wander into screens that will all fail.

export default function ChangePasswordPage() {
  const { user, refresh } = useAuth();
  const router = useRouter();
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const forced = user?.mustChangePassword === true;

  const submit = async (form: HTMLFormElement) => {
    const fd = new FormData(form);
    const newPassword = String(fd.get("newPassword"));
    if (newPassword !== String(fd.get("confirm"))) {
      setProblem("the two new passwords do not match");
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await api("/api/auth/change-password", {
        method: "POST",
        body: { currentPassword: String(fd.get("currentPassword")), newPassword },
      });
      await refresh();
      setDone(true);
      router.push("/");
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-md">
      <Card title={forced ? "Choose a new password" : "Change your password"}>
        {forced && (
          <div className="mb-3">
            <Alert tone="warn">
              This password was set by an administrator, so somebody else knows it. Choose your own
              before continuing — nothing else will work until you do.
            </Alert>
          </div>
        )}
        {problem && (
          <div className="mb-3">
            <Alert>{problem}</Alert>
          </div>
        )}
        {done && (
          <div className="mb-3">
            <Alert tone="ok">Password changed.</Alert>
          </div>
        )}

        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit(e.currentTarget);
          }}
        >
          <Field label="Current password">
            <PasswordInput name="currentPassword" required autoComplete="current-password" />
          </Field>
          <Field label="New password">
            <PasswordInput
              name="newPassword"
              minLength={10}
              required
              autoComplete="new-password"
            />
          </Field>
          <Field label="New password again">
            <PasswordInput name="confirm" minLength={10} required autoComplete="new-password" />
          </Field>
          <Button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Change password"}
          </Button>
        </form>

        <p className="mt-4 text-xs text-[var(--text-muted)]">
          At least 10 characters. Length matters more than punctuation — a long phrase you can
          remember beats a short one you have to write down.
        </p>
      </Card>
    </div>
  );
}
