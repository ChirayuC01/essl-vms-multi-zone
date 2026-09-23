"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { api, getApiBase, getToken, type DeviceList, type DirectoryList, type Person } from "@/lib/api";
import { useApi } from "@/lib/swr";
import { Alert, Button, Card, Field, Input, Select } from "@/components/ui";
import { WebcamCapture } from "@/components/webcam-capture";
import { normalizePhotoFile } from "@/lib/photo";

// Registration covers both acquisition routes:
//
//   Device-first — enroll on the terminal, then register here with the PIN
//                  typed there. The backend has already pulled the photo, so
//                  it attaches automatically and no upload is needed. Arriving
//                  from the "waiting to be registered" panel pre-fills the PIN.
//   Office-first — fill the form and attach a photo from a file. For when no
//                  terminal is at hand.

function RegisterForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Pre-filled when arriving from an unclaimed enrollment.
  const claimingPin = searchParams.get("pin") ?? "";
  // Best-effort, from the device's own USER record — not guaranteed present,
  // and (unlike the PIN) still just a hint: left editable so a mis-typed or
  // abbreviated device name can be corrected before saving.
  const deviceName = searchParams.get("name") ?? "";

  const [name, setName] = useState(deviceName);
  const [companyId, setCompanyId] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [category, setCategory] = useState<"EMPLOYEE" | "VISITOR">("VISITOR");
  const [mobile, setMobile] = useState("");
  const [aadhar, setAadhar] = useState("");
  const [pan, setPan] = useState("");
  const [deviceIds, setDeviceIds] = useState<string[]>([]);
  const [pin, setPin] = useState(claimingPin);
  const [photo, setPhoto] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const claiming = claimingPin !== "" && pin === claimingPin;
  const { data: companies } = useApi<DirectoryList>("/api/companies");
  const { data: departments } = useApi<DirectoryList>("/api/departments");
  const { data: devices } = useApi<DeviceList>("/api/devices");

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setSubmitting(true);
    try {
      const person = await api<Person>("/api/people", {
        method: "POST",
        // Every field is required by the API; the form marks them required
        // too, so this is a plain object rather than a pile of conditionals.
        body: {
          name: name.trim(),
          companyId,
          departmentId,
          category,
          mobile: mobile.trim(),
          ...(aadhar.trim() ? { aadharNumber: aadhar.trim() } : {}),
          ...(pan.trim() ? { panNumber: pan.trim().toUpperCase() } : {}),
          deviceIds: category === "EMPLOYEE" ? deviceIds : [],
          esslUserId: pin.trim(),
        },
      });

      if (photo) {
        // Uploaded separately as a raw JPEG body — the API takes the image
        // itself rather than multipart form data.
        await api(`/api/people/${person.id}/photo`, {
          method: "POST",
          blob: { data: photo, contentType: "image/jpeg" },
        });
      }
      router.push(`/people/${person.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "registration failed");
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <Card title={claiming ? `Register enrollment · PIN ${claimingPin}` : "Register person"}>
        <form onSubmit={onSubmit} className="space-y-4">
          {error && <Alert>{error}</Alert>}
          {notice && <Alert tone="info">{notice}</Alert>}

          {claiming && (
            <div className="flex items-center gap-3 rounded-[var(--radius)] bg-[var(--surface-muted)] p-3">
              {/* eslint-disable-next-line @next/next/no-img-element -- token-authenticated cross-origin image */}
              <img
                src={`${getApiBase()}/api/enrollments/unclaimed/${claimingPin}/photo?token=${encodeURIComponent(getToken() ?? "")}`}
                alt={`Enrollment photo for PIN ${claimingPin}`}
                className="h-20 w-20 rounded-[var(--radius)] border border-[var(--border)] object-cover"
              />
              <p className="text-sm text-[var(--text-muted)]">
                This photo was captured on the terminal and will be attached automatically. Just add
                their details below.
              </p>
            </div>
          )}

          <Field
            label={category === "VISITOR" ? "Visitor ID" : "Employee ID"}
            hint={claiming ? "Assigned by the terminal and cannot be changed." : "Use the same ID that will be enrolled on the terminal."}
          >
            <Input
              required
              pattern="[A-Za-z0-9]+"
              maxLength={20}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/[^A-Za-z0-9]/g, ""))}
              placeholder="e.g. 9001 or VIS001"
              disabled={claiming}
            />
          </Field>

          <Field label="Full name">
            <Input
              required
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ramesh Kumar"
              autoFocus
            />
          </Field>

          <Field label="Company">
            <Select required value={companyId} onChange={(e) => setCompanyId(e.target.value)}><option value="">Select company</option>{companies?.items.filter((x) => x.isActive).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>
          </Field>

          <Field label="Department"><Select required value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}><option value="">Select department</option>{departments?.items.filter((x) => x.isActive).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>

          <Field label="Category"><Select value={category} onChange={(e) => setCategory(e.target.value as "EMPLOYEE" | "VISITOR")}><option value="VISITOR">Visitor</option><option value="EMPLOYEE">Employee</option></Select></Field>

          <Field label="Mobile">
            <Input
              required
              value={mobile}
              onChange={(e) => setMobile(e.target.value)}
              placeholder="+91 9876543210"
            />
          </Field>

          <Field
            label="Aadhaar number"
            hint="Enter Aadhaar or PAN. Each supplied identity number must be unique."
          >
            <Input
              inputMode="numeric"
              pattern="[0-9]{12}"
              maxLength={12}
              value={aadhar}
              onChange={(e) => setAadhar(e.target.value.replace(/\D/g, ""))}
              placeholder="123456789012"
            />
          </Field>

          <Field label="PAN" hint="Format: ABCDE1234F"><Input pattern="[A-Za-z]{5}[0-9]{4}[A-Za-z]" maxLength={10} value={pan} onChange={(e) => setPan(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} placeholder="ABCDE1234F" /></Field>

          {category === "EMPLOYEE" && <Field label="Permanent device access" hint="Employees remain on every selected device until an admin removes access."><div className="space-y-2">{devices?.items.map((device) => <label key={device.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={deviceIds.includes(device.id)} onChange={() => setDeviceIds((ids) => ids.includes(device.id) ? ids.filter((id) => id !== device.id) : [...ids, device.id])} />{device.name ?? device.serialNo}</label>)}</div></Field>}

          {!claiming && (
            <fieldset>
              <legend className="mb-1 text-sm font-medium">Enrollment photo</legend>
              <div className="grid items-start gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                <Input
                  type="file"
                  accept="image/jpeg"
                  disabled={submitting}
                  onChange={async (e) => {
                    const file = e.target.files?.[0] ?? null;
                    if (!file) return setPhoto(null);
                    try {
                      setPhoto(await normalizePhotoFile(file));
                      setNotice(null);
                    } catch {
                      setPhoto(null);
                      setNotice("That file could not be read as an image.");
                    }
                  }}
                />
                <WebcamCapture
                  disabled={submitting}
                  onCapture={(file) => {
                    setPhoto(file);
                    setNotice("Webcam photo captured and ready to upload.");
                  }}
                />
              </div>
              {photo && <span className="mt-1 block text-xs text-[var(--text-muted)]">Selected: {photo.name}</span>}
              <p className="mt-1 text-xs text-[var(--text-muted)]">
                Only needed when the person was not enrolled on the terminal. Upload a JPEG or take
                one with the webcam. It is cropped to a 480×640 portrait before upload — keep the
                face centred and well lit; photo quality determines recognition quality.
              </p>
            </fieldset>
          )}

          <div className="flex gap-2">
            <Button type="submit" variant="primary" loading={submitting}>
              Register
            </Button>
            <Link href="/people">
              <Button type="button">Cancel</Button>
            </Link>
          </div>
        </form>
      </Card>
    </div>
  );
}

export default function RegisterPersonPage() {
  // useSearchParams needs a Suspense boundary so the rest of the route can
  // still be prerendered.
  return (
    <Suspense fallback={<p className="text-sm text-[var(--text-muted)]">Loading…</p>}>
      <RegisterForm />
    </Suspense>
  );
}
