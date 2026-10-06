"use client";

import { use, useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { renderDevicePhoto } from "@/lib/photo";
import { Alert, Button, Card, Field, Input, Select } from "@/components/ui";

// The visitor portal (two-zone rebuild, Phase 5). Reached from the link in
// the visitor's SMS or email, on their own phone: verify the mobile, accept
// the privacy notice, fill in what the visitor type asks for, take a live
// photo, optionally attach documents, submit. Talks only to /public-api on
// this same origin (proxied to the backend).

type Rule = "required" | "optional" | "hidden";
interface State {
  organizationName: string;
  hostName: string;
  expectedAt: string;
  mobileHint: string;
  status: string;
  mobileVerified: boolean;
  visitorName?: string;
  purpose?: string;
  passTypeName?: string;
  queryText?: string | null;
  editable?: boolean;
  returning?: boolean;
  notice?: { text: string; version: string | null };
  consented?: boolean;
  fields?: Record<string, { label: string; rule: Rule }>;
  details?: Record<string, unknown>;
  hasSelfie?: boolean;
  documents?: { id: string; kind: string; fileName: string; sizeBytes: number }[];
  documentRules?: { maxMb: number; maxCount: number; types: string[] };
}

const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
const DOC_KINDS = ["Govt ID", "Vehicle papers", "Police clearance", "Credential", "Other"];
const MIME: Record<string, string> = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp", pdf: "application/pdf" };

export default function VisitorPortal({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [state, setState] = useState<State | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // What the details form currently holds, so Submit can save it first.
  const formRef = useRef<() => Record<string, unknown>>(() => ({}));

  const call = useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      const res = await fetch(`/public-api/v/${token}${path}`, { cache: "no-store", ...init });
      const body = (await res.json().catch(() => ({}))) as { error?: string; issues?: { message: string; path: string[] }[] };
      if (!res.ok) {
        const message = body.error === "validation" && body.issues ? body.issues.map((i) => i.message).join("; ") : body.error ?? "something went wrong — please try again";
        throw Object.assign(new Error(message), { status: res.status });
      }
      return body as T;
    },
    [token],
  );
  const load = useCallback(async () => {
    try {
      setState(await call<State>(""));
    } catch (err) {
      setFatal((err as Error).message);
    }
  }, [call]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- first load of the page's data
    void load();
  }, [load]);

  /** Run one portal action; true if it worked (a failure is shown on the page). */
  async function step(name: string, fn: () => Promise<unknown>): Promise<boolean> {
    setBusy(name);
    setProblem(null);
    try {
      await fn();
      return true;
    } catch (err) {
      if ((err as { status?: number }).status === 410) setFatal((err as Error).message);
      else setProblem((err as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  }
  const json = (method: string, body?: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });

  if (fatal) return <Shell><Alert>{fatal}</Alert></Shell>;
  if (!state) return <Shell><p className="text-sm text-[var(--text-muted)]">Loading…</p></Shell>;

  const header = (
    <div className="space-y-1">
      <h1 className="text-lg font-semibold">{state.organizationName}</h1>
      <p className="text-sm text-[var(--text-muted)]">Visit with {state.hostName} on {when(state.expectedAt)}</p>
    </div>
  );

  if (!state.mobileVerified) {
    return (
      <Shell>
        {header}
        {problem && <Alert>{problem}</Alert>}
        <VerifyMobile
          hint={state.mobileHint}
          busy={busy}
          onSend={() => step("send", () => call("/otp", json("POST")))}
          onVerify={(code) => step("verify", async () => setState(await call<State>("/otp/verify", json("POST", { code }))))}
        />
      </Shell>
    );
  }

  if (!state.editable) {
    const done = state.status === "SUBMITTED";
    return (
      <Shell>
        {header}
        <Alert tone={done ? "ok" : "info"}>
          {done ? `Thank you, ${state.visitorName}. Your details are with ${state.hostName}, who will confirm your visit.` : `This visit is ${state.status.toLowerCase()}. Please contact ${state.hostName} if you have questions.`}
        </Alert>
      </Shell>
    );
  }

  if (!state.consented) {
    return (
      <Shell>
        {header}
        {problem && <Alert>{problem}</Alert>}
        <Consent
          notice={state.notice!}
          busy={busy === "consent"}
          onAccept={() => step("consent", async () => { await call("/consent", json("POST", { noticeVersion: state.notice!.version, accept: true })); await load(); })}
        />
      </Shell>
    );
  }

  return (
    <Shell>
      {header}
      {state.queryText && <Alert tone="warn">{state.hostName} asked: “{state.queryText}”</Alert>}
      {state.returning && <Alert tone="info">Welcome back. We have filled in what you gave us last time — please check it is still correct.</Alert>}
      <DetailsForm
        state={state}
        formRef={formRef}
        busy={busy === "details"}
        onSave={(details) => step("details", async () => setState(await call<State>("/details", json("PUT", details))))}
      />
      <Selfie
        has={Boolean(state.hasSelfie)}
        busy={busy === "selfie"}
        onPhoto={(file) => step("selfie", async () => { await call("/selfie", { method: "POST", headers: { "content-type": "image/jpeg" }, body: file }); await load(); })}
      />
      {state.documentRules && state.documentRules.maxCount > 0 && (
        <Documents
          state={state}
          busy={busy}
          onUpload={(file, kind) => step("doc", async () => { await call(`/documents?kind=${encodeURIComponent(kind)}&fileName=${encodeURIComponent(file.name)}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: file }); await load(); })}
          onRemove={(id) => step(`rm-${id}`, async () => { await call(`/documents/${id}`, { method: "DELETE" }); await load(); })}
        />
      )}
      {problem && <Alert>{problem}</Alert>}
      <Button variant="primary" className="w-full" loading={busy === "submit"} onClick={() => void step("submit", async () => { await call("/details", json("PUT", formRef.current())); await call("/submit", json("POST")); await load(); })}>
        Submit my details
      </Button>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto w-full max-w-lg flex-1 space-y-4 p-4">{children}</main>;
}

function VerifyMobile({ hint, busy, onSend, onVerify }: { hint: string; busy: string | null; onSend: () => Promise<boolean>; onVerify: (code: string) => Promise<boolean> }) {
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState("");
  return (
    <Card title="Confirm your mobile number">
      <div className="space-y-3">
        <p className="text-sm">We will send a code by SMS to your number ending {hint.slice(-4)}.</p>
        <Button loading={busy === "send"} onClick={() => void onSend().then((ok) => ok && setSent(true))}>{sent ? "Send a new code" : "Send code"}</Button>
        {sent && (
          <div className="flex items-end gap-2">
            <Field label="Code">
              <Input inputMode="numeric" autoComplete="one-time-code" maxLength={8} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
            </Field>
            <Button variant="primary" disabled={code.length < 4} loading={busy === "verify"} onClick={() => void onVerify(code)}>Confirm</Button>
          </div>
        )}
      </div>
    </Card>
  );
}

function Consent({ notice, busy, onAccept }: { notice: { text: string; version: string | null }; busy: boolean; onAccept: () => Promise<boolean> }) {
  const [ticked, setTicked] = useState(false);
  return (
    <Card title="Privacy notice">
      <div className="space-y-3">
        {notice.text.trim() ? (
          <div className="max-h-80 overflow-y-auto whitespace-pre-wrap rounded-[var(--radius)] border border-[var(--border)] p-3 text-sm">{notice.text}</div>
        ) : (
          <Alert tone="warn">The site has not published its privacy notice yet. Please contact your host.</Alert>
        )}
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={ticked} onChange={(e) => setTicked(e.target.checked)} disabled={!notice.text.trim()} />
          I have read the notice and agree to my details and photo being used as it describes.
        </label>
        <Button variant="primary" disabled={!ticked} loading={busy} onClick={() => void onAccept()}>Continue</Button>
      </div>
    </Card>
  );
}

function DetailsForm({ state, busy, formRef, onSave }: { state: State; busy: boolean; formRef: RefObject<() => Record<string, unknown>>; onSave: (details: Record<string, unknown>) => Promise<boolean> }) {
  const fields = Object.entries(state.fields ?? {}).filter(([, f]) => f.rule !== "hidden");
  const initial = () => {
    const d = state.details ?? {};
    const out: Record<string, string> = { name: String(d.name ?? state.visitorName ?? "") };
    for (const [key] of fields) {
      const v = d[key];
      out[key] = v === null || v === undefined ? "" : key === "credentialExpiresAt" ? String(v).slice(0, 10) : typeof v === "boolean" ? (v ? "yes" : "no") : String(v);
    }
    return out;
  };
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [saved, setSaved] = useState(false);

  function payload() {
    const out: Record<string, unknown> = { name: values.name };
    for (const [key] of fields) {
      const v = values[key] ?? "";
      out[key] = key === "policeClearance" ? (v === "" ? null : v === "yes") : v;
    }
    return out;
  }
  useEffect(() => {
    formRef.current = payload;
  });
  const control = (key: string) => {
    const set = (v: string) => { setSaved(false); setValues((all) => ({ ...all, [key]: v })); };
    if (key === "policeClearance") {
      return (
        <Select value={values[key]} onChange={(e) => set(e.target.value)}>
          <option value="">—</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </Select>
      );
    }
    const type = key === "email" ? "email" : key === "credentialExpiresAt" ? "date" : "text";
    return <Input type={type} value={values[key]} onChange={(e) => set(e.target.value)} maxLength={100} />;
  };

  return (
    <Card title="Your details">
      <div className="space-y-3">
        <Field label="Full name"><Input value={values.name} onChange={(e) => { setSaved(false); setValues((all) => ({ ...all, name: e.target.value })); }} maxLength={100} /></Field>
        {fields.map(([key, f]) => (
          <Field key={key} label={`${f.label}${f.rule === "required" ? "" : " (optional)"}`} hint={["govtIdNumber", "aadharNumber", "panNumber", "credentialNumber"].includes(key) && String(values[key]).includes("*") ? "Saved number shown hidden. Leave it to keep it, or type a new one." : undefined}>
            {control(key)}
          </Field>
        ))}
        <Button loading={busy} onClick={() => void onSave(payload()).then(setSaved)}>{saved ? "Saved" : "Save details"}</Button>
      </div>
    </Card>
  );
}

function Selfie({ has, busy, onPhoto }: { has: boolean; busy: boolean; onPhoto: (file: File) => Promise<boolean> }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stop = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setLive(false);
  };
  useEffect(() => () => streamRef.current?.getTracks().forEach((t) => t.stop()), []);

  async function start() {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("This browser cannot open the camera here. Open the link in your phone's normal browser (Chrome or Safari).");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 1280 } }, audio: false });
      streamRef.current = stream;
      setLive(true);
      requestAnimationFrame(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          void videoRef.current.play();
        }
      });
    } catch {
      setError("The camera could not be opened. Allow camera access for this page and try again.");
    }
  }
  function capture() {
    const v = videoRef.current;
    if (!v?.videoWidth) return;
    void renderDevicePhoto(v, v.videoWidth, v.videoHeight)
      .then((file) => onPhoto(file))
      .then((ok) => ok && stop())
      .catch(() => setError("The photo could not be taken. Please try again."));
  }

  return (
    <Card title="Your photo">
      <div className="space-y-3">
        <p className="text-sm">This photo opens the gate for you. Face the camera in good light, without a cap or sunglasses, and fit your face inside the oval.</p>
        {has && !live && <Alert tone="ok">Photo saved.</Alert>}
        {live ? (
          <div className="space-y-2">
            <div className="relative mx-auto aspect-[3/4] w-full max-w-xs overflow-hidden rounded-[var(--radius)] bg-black">
              <video ref={videoRef} autoPlay muted playsInline aria-label="Camera preview" className="h-full w-full -scale-x-100 object-cover" />
              <div aria-hidden="true" className="pointer-events-none absolute left-1/2 top-[45%] h-[62%] w-[62%] -translate-x-1/2 -translate-y-1/2 rounded-[50%] border-4 border-white/80 shadow-[0_0_0_999px_rgba(0,0,0,0.35)]" />
            </div>
            <div className="flex gap-2">
              <Button variant="primary" loading={busy} onClick={capture}>Take photo</Button>
              <Button onClick={stop}>Cancel</Button>
            </div>
          </div>
        ) : (
          <Button onClick={() => void start()}>{has ? "Retake photo" : "Open camera"}</Button>
        )}
        {error && <Alert>{error}</Alert>}
      </div>
    </Card>
  );
}

function Documents({ state, busy, onUpload, onRemove }: { state: State; busy: string | null; onUpload: (file: File, kind: string) => Promise<boolean>; onRemove: (id: string) => Promise<boolean> }) {
  const rules = state.documentRules!;
  const docs = state.documents ?? [];
  const [kind, setKind] = useState(DOC_KINDS[0]!);
  const [file, setFile] = useState<File | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <Card title="Documents (optional)">
      <div className="space-y-3">
        {docs.length > 0 && (
          <ul className="space-y-1 text-sm">
            {docs.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-2">
                <span>{d.kind}: {d.fileName}</span>
                <Button loading={busy === `rm-${d.id}`} onClick={() => void onRemove(d.id)}>Remove</Button>
              </li>
            ))}
          </ul>
        )}
        {docs.length < rules.maxCount ? (
          <>
            <Field label="What is it?">
              <Select value={kind} onChange={(e) => setKind(e.target.value)}>
                {DOC_KINDS.map((k) => <option key={k}>{k}</option>)}
              </Select>
            </Field>
            <Field label="File" hint={`${rules.types.map((t) => t.toUpperCase()).join(", ")} up to ${rules.maxMb} MB`}>
              <input ref={inputRef} type="file" accept={rules.types.map((t) => MIME[t]).join(",")} onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-sm" />
            </Field>
            <Button disabled={!file} loading={busy === "doc"} onClick={() => void onUpload(file!, kind).then((ok) => { if (!ok) return; setFile(null); if (inputRef.current) inputRef.current.value = ""; })}>Upload</Button>
          </>
        ) : (
          <p className="text-xs text-[var(--text-muted)]">You have attached the most documents allowed.</p>
        )}
      </div>
    </Card>
  );
}
