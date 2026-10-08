"use client";

import { use, useCallback, useEffect, useState } from "react";
import { Alert, Button, Card, Field, Input } from "@/components/ui";

// The out-pass (two-zone rebuild, Phase 7). The link a single-entry visitor
// gets by SMS when they come in. At the end of the visit they type the exit
// code their host (or Security) gives them; a correct code loads the exit
// gate with their face.

interface OutPass {
  organizationName: string;
  firstName: string;
  exitOpen: boolean;
  closed: boolean;
}

export default function OutPassPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [state, setState] = useState<OutPass | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/public-api/out/${token}`, { cache: "no-store" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) setFatal(body.error ?? "this link is not valid");
    else setState(body as OutPass);
  }, [token]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- first load of the page's data
    void load();
  }, [load]);

  async function verify() {
    setBusy(true);
    setProblem(null);
    try {
      const res = await fetch(`/public-api/out/${token}/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) setProblem(body.error ?? "something went wrong — please try again");
      else await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-lg flex-1 space-y-4 p-4">
      {fatal ? (
        <Alert>{fatal}</Alert>
      ) : !state ? (
        <p className="text-sm text-[var(--text-muted)]">Loading…</p>
      ) : (
        <>
          <h1 className="text-lg font-semibold">{state.organizationName}</h1>
          {state.exitOpen ? (
            <Alert tone="ok">Your exit is open, {state.firstName}. At the exit gate, simply look at the camera. Thank you for visiting.</Alert>
          ) : state.closed ? (
            <Alert tone="info">This visit has ended. If you are still inside, please speak to Security.</Alert>
          ) : (
            <Card title="Leaving?">
              <div className="space-y-3">
                <p className="text-sm">Hi {state.firstName}. Enter the exit code your host gives you to open the exit gate.</p>
                <div className="flex items-end gap-2">
                  <Field label="Exit code">
                    <Input inputMode="numeric" autoComplete="one-time-code" maxLength={8} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
                  </Field>
                  <Button variant="primary" disabled={code.length < 4} loading={busy} onClick={() => void verify()}>Open exit</Button>
                </div>
                {problem && <Alert>{problem}</Alert>}
              </div>
            </Card>
          )}
        </>
      )}
    </main>
  );
}
