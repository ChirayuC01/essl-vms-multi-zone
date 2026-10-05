"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { api, getApiBase, getToken, type DeviceList, type DirectoryList, type PassTypeList, type Person } from "@/lib/api";
import { EMPTY_PROFILE, ProfileFields, profilePayload } from "@/components/profile-fields";
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
  const [category, setCategory] = useState<"EMPLOYEE" | "VISITOR">("VISITOR");
  const [passTypeId, setPassTypeId] = useState("");
  const [profile, setProfile] = useState(EMPTY_PROFILE);
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
  const { data: passTypes } = useApi<PassTypeList>("/api/pass-types");
  const passType = category === "VISITOR" ? passTypes?.items.find((t) => t.id === passTypeId) ?? null : null;

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setSubmitting(true);
    try {
      const person = await api<Person>("/api/people", {
        method: "POST",
        // Which fields are required depends on the visitor type; the API
        // enforces it and names anything missing.
        body: {
          name: name.trim(),
          category,
          ...(passType ? { passTypeId: passType.id } : {}),
          ...profilePayload(profile, false),
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

          <Field label="Category"><Select value={category} onChange={(e) => setCategory(e.target.value as "EMPLOYEE" | "VISITOR")}><option value="VISITOR">Visitor</option><option value="EMPLOYEE">Employee</option></Select></Field>

          {category === "VISITOR" && (passTypes?.items.length ?? 0) > 0 && (
            <Field label="Visitor type" hint="Decides which details are required. Leave as General for the standard set.">
              <Select value={passTypeId} onChange={(e) => setPassTypeId(e.target.value)}>
                <option value="">General (company, department, mobile, Aadhaar or PAN)</option>
                {passTypes?.items.filter((t) => t.isActive).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </Select>
            </Field>
          )}

          <ProfileFields draft={profile} onChange={setProfile} category={category} passType={passType} companies={companies} departments={departments} />

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
