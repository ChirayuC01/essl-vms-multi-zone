"use client";

import { useState } from "react";
import Link from "next/link";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import { Alert, Badge, Button, Card, Field, Input, Stat } from "@/components/ui";

export default function ProfilePage() {
  const { user, refresh } = useAuth();
  const [name, setName] = useState(user?.name ?? "");
  const [phone, setPhone] = useState(user?.phone ?? "");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  if (!user) return null;

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Card
        title="My profile"
        action={<Badge tone={user.role === "ADMIN" ? "info" : "neutral"}>{user.role}</Badge>}
      >
        {problem && <div className="mb-3"><Alert>{problem}</Alert></div>}
        {saved && <div className="mb-3"><Alert tone="ok">Profile saved.</Alert></div>}
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setProblem(null);
            setSaved(false);
            try {
              await api("/api/auth/me", { method: "PATCH", body: { name, phone } });
              await refresh();
              setSaved(true);
            } catch (error) {
              setProblem(error instanceof ApiError ? error.message : "profile update failed");
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="Email address" hint="Email is the sign-in identity and cannot be changed here.">
            <Input value={user.email} disabled />
          </Field>
          <Field label="Name" hint="Optional">
            <Input value={name} maxLength={100} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field label="Phone number" hint="Optional">
            <Input type="tel" value={phone} maxLength={30} onChange={(event) => setPhone(event.target.value)} />
          </Field>
          <div className="flex items-end">
            <Button type="submit" variant="primary" loading={busy}>Save profile</Button>
          </div>
        </form>
      </Card>

      <Card title="Account security">
        <div className="grid gap-3 sm:grid-cols-2">
          <Stat label="Password last changed" value={formatDateTime(user.passwordChangedAt)} />
          <Stat label="Account created" value={formatDateTime(user.createdAt)} />
        </div>
        <Link href="/change-password" className="mt-4 inline-block">
          <Button>Change password</Button>
        </Link>
      </Card>
    </div>
  );
}
