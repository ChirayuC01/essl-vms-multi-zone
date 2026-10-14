"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, type DeviceList, type DirectoryList, type PassTypeList, type Person, type ZoneList } from "@/lib/api";
import { EMPTY_PROFILE, ProfileFields, profilePayload } from "@/components/profile-fields";
import { useApi } from "@/lib/swr";
import { Alert, Button, Card, Field, Input, SearchSelect, Select } from "@/components/ui";
import { WebcamCapture } from "@/components/webcam-capture";
import { ZonePicker } from "@/components/zone-picker";
import { normalizePhotoFile } from "@/lib/photo";

// Register a person in the console: the only way in besides a visit request
// (two-zone sites never register from the terminal, F2 #2). A visitor's ID is
// issued by the system; an employee's is their own code. The photo is an
// upload or a webcam shot, normalised to the terminal's 480×640 portrait.

export default function RegisterPersonPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [category, setCategory] = useState<"EMPLOYEE" | "VISITOR">("VISITOR");
  const [passTypeId, setPassTypeId] = useState("");
  const [profile, setProfile] = useState(EMPTY_PROFILE);
  const [deviceIds, setDeviceIds] = useState<string[]>([]);
  const [zoneIds, setZoneIds] = useState<string[]>([]);
  const [pin, setPin] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const { data: companies } = useApi<DirectoryList>("/api/companies");
  const { data: departments } = useApi<DirectoryList>("/api/departments");
  const { data: devices } = useApi<DeviceList>("/api/devices");
  const { data: passTypes } = useApi<PassTypeList>("/api/pass-types");
  const { data: zoneList } = useApi<ZoneList>("/api/zones");
  const zones = (zoneList?.items ?? []).filter((z) => z.isActive);
  const passType = category === "VISITOR" ? passTypes?.items.find((t) => t.id === passTypeId) ?? null : null;

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setSubmitting(true);
    try {
      const person = await api<Person>("/api/people", {
        method: "POST",
        // Which fields are required depends on the pass type; the API
        // enforces it and names anything missing.
        body: {
          name: name.trim(),
          category,
          ...(passType ? { passTypeId: passType.id } : {}),
          ...profilePayload(profile, false),
          deviceIds: category === "EMPLOYEE" ? deviceIds : [],
          zoneIds: category === "EMPLOYEE" ? zoneIds : [],
          // A visitor's ID is issued by the server (F2 #2).
          ...(category === "EMPLOYEE" ? { esslUserId: pin.trim() } : {}),
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
      <Card title="Register person">
        <form onSubmit={onSubmit} className="space-y-4">
          {error && <Alert>{error}</Alert>}
          {notice && <Alert tone="info">{notice}</Alert>}

          {/* Category first: everything below depends on it. */}
          <Field label="Category"><Select value={category} onChange={(e) => setCategory(e.target.value as "EMPLOYEE" | "VISITOR")} autoFocus><option value="VISITOR">Visitor</option><option value="EMPLOYEE">Employee</option></Select></Field>

          {category === "EMPLOYEE" ? (
            <Field label="Employee ID" hint="Their own employee code; letters and digits, matching the terminals' employee ID pattern.">
              <Input
                required
                pattern="[A-Za-z0-9]+"
                maxLength={20}
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/[^A-Za-z0-9]/g, ""))}
                placeholder="e.g. EMP1042"
              />
            </Field>
          ) : (
            <p className="text-sm text-[var(--text-muted)]">The visitor ID is assigned automatically and shown once they are registered.</p>
          )}

          <Field label="Full name">
            <Input
              required
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ramesh Kumar"
            />
          </Field>

          {category === "VISITOR" && (passTypes?.items.length ?? 0) > 0 && (
            <Field label="Pass type" hint="Decides which details are required and the rules of every pass they get. Leave as General for the standard set.">
              <SearchSelect
                value={passTypeId}
                onChange={setPassTypeId}
                options={(passTypes?.items ?? []).filter((t) => t.isActive).map((t) => ({ value: t.id, label: t.name }))}
                emptyLabel="General (company, department, mobile, Aadhaar or PAN)"
              />
            </Field>
          )}

          <ProfileFields draft={profile} onChange={setProfile} category={category} passType={passType} companies={companies} departments={departments} />

          {category === "EMPLOYEE" && zones.length > 0 && (
            <Field label="Zones" hint="Permanent access to every terminal of the zone and of the zones around it">
              <ZonePicker zones={zones} value={zoneIds} onChange={setZoneIds} />
            </Field>
          )}

          {category === "EMPLOYEE" && <Field label={zones.length > 0 ? "Or individual terminals" : "Permanent device access"} hint="Employees remain on every selected device until an admin removes access."><div className="space-y-2">{devices?.items.map((device) => <label key={device.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={deviceIds.includes(device.id)} onChange={() => setDeviceIds((ids) => ids.includes(device.id) ? ids.filter((id) => id !== device.id) : [...ids, device.id])} />{device.name ?? device.serialNo}</label>)}</div></Field>}

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
                Needed before any terminal can recognise them; it can also be added later on their
                page. Upload a JPEG or take one with the webcam. It is cropped to a 480×640 portrait
                before upload — keep the face centred and well lit; photo quality determines
                recognition quality.
              </p>
            </fieldset>

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
