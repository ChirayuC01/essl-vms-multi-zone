"use client";

import { useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";

// Small shared vocabulary of building blocks. Every colour comes from a CSS
// variable (see globals.css), so per-client branding in Phase 6 never has to
// touch a component.

export function Card({
  title,
  action,
  children,
  className = "",
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] ${className}`}
    >
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
          <h2 className="text-sm font-semibold tracking-wide">{title}</h2>
          {action}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Accordion({
  title,
  summary,
  children,
  initiallyOpen = false,
  className = "",
}: {
  title: ReactNode;
  summary?: ReactNode;
  children: ReactNode;
  initiallyOpen?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className={`group rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] ${className}`}
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3">
        <span className="text-sm font-semibold tracking-wide">{title}</span>
        <span className="flex min-w-0 items-center gap-2">
          {summary}
          <span aria-hidden="true" className="shrink-0 text-sm transition-transform group-open:rotate-180">▾</span>
        </span>
      </summary>
      <div className="border-t border-[var(--border)] p-4">{children}</div>
    </details>
  );
}

type Tone = "ok" | "warn" | "danger" | "info" | "neutral";

const TONE_STYLE: Record<Tone, string> = {
  ok: "bg-[var(--ok-bg)] text-[var(--ok)]",
  warn: "bg-[var(--warn-bg)] text-[var(--warn)]",
  danger: "bg-[var(--danger-bg)] text-[var(--danger)]",
  info: "bg-[var(--info-bg)] text-[var(--info)]",
  neutral: "bg-[var(--neutral-bg)] text-[var(--text-muted)]",
};

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${TONE_STYLE[tone]}`}
    >
      {children}
    </span>
  );
}

/** Command status → tone. FAILED must never be quiet. */
export function commandTone(status: string): Tone {
  if (status === "SUCCESS") return "ok";
  if (status === "FAILED") return "danger";
  if (status === "RETRY") return "warn";
  if (status === "SENT") return "info";
  return "neutral";
}

/** Entry state → tone. PROVISIONED means "can open the barrier right now". */
export function entryTone(state: string): Tone {
  if (state === "PROVISIONED") return "ok";
  if (state === "INSIDE") return "info";
  if (state === "PENDING_PROVISION" || state === "PENDING_DEPROVISION") return "warn";
  return "neutral";
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "danger";
  loading?: boolean;
}

export function Button({
  variant = "secondary",
  loading = false,
  disabled,
  children,
  className = "",
  ...rest
}: ButtonProps) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-[var(--radius)] px-3 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50";
  const variants = {
    primary: "bg-[var(--brand)] text-[var(--brand-contrast)] hover:bg-[var(--brand-hover)]",
    secondary:
      "border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-muted)]",
    danger: "bg-[var(--danger)] text-white hover:opacity-90",
  };
  return (
    <button
      className={`${base} ${variants[variant]} ${className}`}
      disabled={disabled || loading}
      {...rest}
    >
      {loading && (
        <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
      )}
      {children}
    </button>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-[var(--text-muted)]">{hint}</span>}
    </label>
  );
}

const CONTROL =
  "w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm outline-none focus:border-[var(--brand)]";

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${CONTROL} ${props.className ?? ""}`} />;
}

export function PasswordInput(props: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="flex gap-2">
      <Input {...props} type={visible ? "text" : "password"} />
      <Button
        type="button"
        aria-label={`${visible ? "Hide" : "Show"} password`}
        aria-pressed={visible}
        onClick={() => setVisible((value) => !value)}
      >
        {visible ? "Hide" : "Show"}
      </Button>
    </div>
  );
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${CONTROL} ${props.className ?? ""}`} />;
}

export function Alert({ tone = "danger", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <div
      className={`rounded-[var(--radius)] px-3 py-2 text-sm ${TONE_STYLE[tone]}`}
      role={tone === "danger" ? "alert" : undefined}
    >
      {children}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-[var(--text-muted)]">{children}</p>;
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-[var(--text-muted)]">{label}</div>
      <div className="mt-0.5 text-lg font-semibold">{value}</div>
      {sub && <div className="text-xs text-[var(--text-muted)]">{sub}</div>}
    </div>
  );
}

export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[600px] text-sm">
        <thead>
          <tr className="border-b border-[var(--border)] text-left text-xs uppercase tracking-wide text-[var(--text-muted)]">
            {head.map((h) => (
              <th key={h} className="px-2 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <section className="w-full max-w-md rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] shadow-xl">
        <header className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <h2 className="font-semibold">{title}</h2>
          <Button type="button" onClick={onClose} aria-label="Close">Close</Button>
        </header>
        <div className="p-4">{children}</div>
      </section>
    </div>
  );
}
