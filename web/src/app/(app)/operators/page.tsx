"use client";

import { useState } from "react";
import Link from "next/link";
import { api, ApiError, type OperatorAccount, type OperatorList, type RoleList } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useApi, refresh } from "@/lib/swr";
import { formatDateTime } from "@/lib/format";
import { Alert, Badge, Button, Card, Empty, Field, Input, Modal, PasswordInput, Select, Table } from "@/components/ui";

// Operator management (Phase 4 Milestone 18).
//
// There is no email on-premise — many sites have no outbound internet at all
// — so a reset link is not an option. An admin types a temporary password and
// reads it out; the account is then forced to change it before it can do
// anything else. That flow is why the password is shown here in plain text at
// the moment it is set: it has to be communicable, and it is worthless within
// a few minutes because the operator must replace it.

export default function OperatorsPage() {
  const { user, can } = useAuth();
  const { data, error } = useApi<OperatorList>(can("operators:view") ? "/api/operators" : null);
  const { data: roleList } = useApi<RoleList>(can("operators:view") ? "/api/roles" : null);
  const roles = roleList?.items ?? [];
  const roleName = (key: string) => roles.find((r) => r.key === key)?.name ?? key;
  // Inactive roles stay listed for an operator who still holds one, but are never offered.
  const roleOptions = (current?: string) =>
    roles.filter((r) => r.isActive || r.key === current).map((r) => <option key={r.key} value={r.key}>{r.name}</option>);
  const [busy, setBusy] = useState(false);
  const mayUpdate = can("operators:update");
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<OperatorAccount | null>(null);
  const [resetting, setResetting] = useState<OperatorAccount | null>(null);

  if (!can("operators:view")) {
    return (
      <Card title="Operators">
        <Empty>Your role does not include operator management.</Empty>
      </Card>
    );
  }

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    setProblem(null);
    setNotice(null);
    try {
      await fn();
      setNotice(label);
      await refresh("/api/operators");
      return true;
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "something went wrong");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const create = async (form: HTMLFormElement) => {
    const fd = new FormData(form);
    const temporaryPassword = String(fd.get("temporaryPassword"));
    await run(
      `Created. Give them this password now — they must change it at first sign-in: ${temporaryPassword}`,
      () =>
        api("/api/operators", {
          method: "POST",
          body: {
            email: String(fd.get("email")),
            name: String(fd.get("name")),
            phone: String(fd.get("phone")),
            role: String(fd.get("role")),
            temporaryPassword,
          },
        }),
    );
    form.reset();
  };

  return (
    <div className="space-y-4">
      {problem && <Alert>{problem}</Alert>}
      {notice && <Alert tone="ok">{notice}</Alert>}

      {can("operators:create") && <Card title="Add an operator">
        <form
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault();
            void create(e.currentTarget);
          }}
        >
          <Field label="Email">
            <Input name="email" type="email" required placeholder="name@site.local" />
          </Field>
          <Field label="Name" hint="Optional">
            <Input name="name" maxLength={100} placeholder="Operator name" />
          </Field>
          <Field label="Phone number" hint="Optional">
            <Input name="phone" type="tel" maxLength={30} placeholder="Phone number" />
          </Field>
          <Field label="Role">
            <Select name="role" defaultValue="SECURITY">
              {roleOptions()}
            </Select>
          </Field>
          <Field label="Temporary password">
            <PasswordInput name="temporaryPassword" minLength={10} required placeholder="at least 10 characters" />
          </Field>
          <div className="flex items-end">
            <Button type="submit" disabled={busy}>
              Add operator
            </Button>
          </div>
        </form>
        <p className="mt-3 text-xs text-[var(--text-muted)]">
          There is no email on this system, so you set the first password and tell them. They cannot
          do anything until they replace it.
        </p>
      </Card>}

      <Card title={`Operators (${data?.total ?? 0})`}>
        {error && <Alert>failed to load</Alert>}
        {!data ? (
          <Empty>Loading…</Empty>
        ) : (
          <Table head={["Operator", "Phone", "Role", "Status", "Password", "Added", ""]}>
            {data.items.map((op) => {
              const self = op.id === user?.id;
              return (
                <tr key={op.id} className="border-b border-[var(--border)] last:border-0">
                  <td className="px-2 py-2">
                    <div>{op.name ?? "—"}</div>
                    <div className="text-xs text-[var(--text-muted)]">{op.email}</div>
                    {self && <span className="ml-2 text-xs text-[var(--text-muted)]">you</span>}
                  </td>
                  <td className="px-2 py-2">{op.phone ?? "—"}</td>
                  <td className="px-2 py-2">
                    {/* Your own role is not editable here: demoting yourself could
                        leave no administrator, and the API refuses it too. */}
                    {self ? (
                      <Badge tone={op.role === "ADMIN" ? "info" : "neutral"}>{roleName(op.role)}</Badge>
                    ) : (
                      <Select
                        className="py-1 text-sm"
                        value={op.role}
                        disabled={busy || !mayUpdate}
                        onChange={(e) => {
                          const role = e.target.value;
                          void run(`${op.email} is now ${roleName(role)}.`, () =>
                            api(`/api/operators/${op.id}`, { method: "PATCH", body: { role } }),
                          );
                        }}
                      >
                        {roleOptions(op.role)}
                      </Select>
                    )}
                  </td>
                  <td className="px-2 py-2">
                    <Badge tone={op.isActive ? "ok" : "danger"}>
                      {op.isActive ? "active" : "disabled"}
                    </Badge>
                  </td>
                  <td className="px-2 py-2 text-xs text-[var(--text-muted)]">
                    {op.mustChangePassword
                      ? "must change at next sign-in"
                      : op.passwordChangedAt
                        ? `changed ${formatDateTime(op.passwordChangedAt)}`
                        : "never changed"}
                  </td>
                  <td className="px-2 py-2 text-xs text-[var(--text-muted)]">
                    {formatDateTime(op.createdAt)}
                  </td>
                  <td className="px-2 py-2">
                    <div className="flex flex-wrap justify-end gap-2">
                      <Button
                        disabled={busy || !mayUpdate}
                        onClick={() => setEditing(op)}
                      >
                        Edit details
                      </Button>
                      {can("access:view") && (
                        <Link
                          href={`/operators/${op.id}/access`}
                          className="rounded-[var(--radius)] border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-[var(--surface-muted)]"
                        >
                          Access
                        </Link>
                      )}
                      {/* Self-actions are hidden, not merely refused: an admin
                          who disables their own account has no way back in,
                          and the API refuses these too. */}
                      {!self && (
                        <>
                          <Button
                            disabled={busy || !mayUpdate}
                            onClick={() =>
                              void run(`${op.email} is now ${op.isActive ? "disabled" : "active"}.`, () =>
                                api(`/api/operators/${op.id}`, {
                                  method: "PATCH",
                                  body: { isActive: !op.isActive },
                                }),
                              )
                            }
                          >
                            {op.isActive ? "Disable" : "Re-enable"}
                          </Button>
                        </>
                      )}
                      <Button
                        disabled={busy || !mayUpdate}
                        onClick={() => setResetting(op)}
                      >
                        Reset password
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </Table>
        )}
        <p className="mt-3 text-xs text-[var(--text-muted)]">
          Operators are disabled, never deleted — the audit log and every queued command record who
          acted, and removing the account would orphan that history. Disabling takes effect
          immediately, including for anyone already signed in.
        </p>
      </Card>

      {editing && (
        <Modal title={`Edit ${editing.email}`} onClose={() => setEditing(null)}>
          <form
            className="space-y-3"
            onSubmit={async (event) => {
              event.preventDefault();
              const fd = new FormData(event.currentTarget);
              const ok = await run(`Updated details for ${editing.email}.`, () =>
                api(`/api/operators/${editing.id}`, {
                  method: "PATCH",
                  body: { name: String(fd.get("name")), phone: String(fd.get("phone")) },
                }),
              );
              if (ok) setEditing(null);
            }}
          >
            {problem && <Alert>{problem}</Alert>}
            <Field label="Email"><Input value={editing.email} disabled /></Field>
            <Field label="Name" hint="Optional"><Input name="name" maxLength={100} defaultValue={editing.name ?? ""} /></Field>
            <Field label="Phone number" hint="Optional"><Input name="phone" type="tel" maxLength={30} defaultValue={editing.phone ?? ""} /></Field>
            <Button type="submit" variant="primary" loading={busy}>Save details</Button>
          </form>
        </Modal>
      )}

      {resetting && (
        <Modal title={`Reset password for ${resetting.email}`} onClose={() => setResetting(null)}>
          <form
            className="space-y-3"
            onSubmit={async (event) => {
              event.preventDefault();
              const fd = new FormData(event.currentTarget);
              const temporaryPassword = String(fd.get("temporaryPassword"));
              if (temporaryPassword !== String(fd.get("confirmPassword"))) {
                setProblem("the two temporary passwords do not match");
                return;
              }
              const ok = await run(`Password reset. Tell them: ${temporaryPassword}`, () =>
                api(`/api/operators/${resetting.id}/reset-password`, {
                  method: "POST",
                  body: { temporaryPassword },
                }),
              );
              if (ok) setResetting(null);
            }}
          >
            {problem && <Alert>{problem}</Alert>}
            <Alert tone="warn">They will be forced to change this password at next sign-in.</Alert>
            <Field label="Temporary password"><PasswordInput name="temporaryPassword" minLength={10} required autoComplete="new-password" /></Field>
            <Field label="Retype temporary password"><PasswordInput name="confirmPassword" minLength={10} required autoComplete="new-password" /></Field>
            <Button type="submit" variant="primary" loading={busy}>Reset password</Button>
          </form>
        </Modal>
      )}
    </div>
  );
}
