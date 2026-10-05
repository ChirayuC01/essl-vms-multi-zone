"use client";

import type { DirectoryList, FieldRule, PassType, Person } from "@/lib/api";
import { Field, Input, Select } from "@/components/ui";

// The profile fields of a person, shown or hidden and marked required by the
// person's pass type (or the default rule for employees and untyped
// visitors). The server enforces the same rules; this only guides the form.

export interface ProfileDraft {
  mobile: string;
  email: string;
  companyId: string;
  departmentId: string;
  designation: string;
  govtIdType: string;
  govtIdNumber: string;
  aadharNumber: string;
  panNumber: string;
  vehicleNumber: string;
  policeClearance: "" | "yes" | "no";
  credentialNumber: string;
  credentialExpiresAt: string;
}

export const EMPTY_PROFILE: ProfileDraft = {
  mobile: "", email: "", companyId: "", departmentId: "", designation: "", govtIdType: "", govtIdNumber: "",
  aadharNumber: "", panNumber: "", vehicleNumber: "", policeClearance: "", credentialNumber: "", credentialExpiresAt: "",
};

/** Fields saved masked on the server: the form never pre-fills them, only shows what is on file. */
const MASKED = ["aadharNumber", "panNumber", "govtIdNumber", "credentialNumber"] as const;
type MaskedField = (typeof MASKED)[number];

/** A draft from a saved person; masked numbers stay blank (typing replaces them). */
export function draftFromPerson(p: Person): ProfileDraft {
  return {
    ...EMPTY_PROFILE,
    mobile: p.mobile ?? "",
    email: p.email ?? "",
    companyId: p.companyId ?? "",
    departmentId: p.departmentId ?? "",
    designation: p.designation ?? "",
    govtIdType: p.govtIdType ?? "",
    vehicleNumber: p.vehicleNumber ?? "",
    policeClearance: p.policeClearance === null ? "" : p.policeClearance ? "yes" : "no",
    credentialExpiresAt: p.credentialExpiresAt ? p.credentialExpiresAt.slice(0, 10) : "",
  };
}

const DEFAULT_REQUIRED = new Set(["mobile", "companyId", "departmentId"]);

export function ruleOf(field: keyof ProfileDraft, category: string, passType: PassType | null): FieldRule {
  if ((field === "credentialNumber" || field === "credentialExpiresAt") && !passType?.credentialLabel) return "hidden";
  if (category === "EMPLOYEE" || !passType) return DEFAULT_REQUIRED.has(field) ? "required" : "optional";
  return passType.fieldRules[field] ?? "optional";
}

/**
 * The request body for these fields. Blank optional fields are omitted on
 * create and cleared (null) on update; masked numbers are sent only when
 * something new was typed.
 */
export function profilePayload(d: ProfileDraft, forUpdate: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const put = (key: string, value: string) => {
    if (value.trim()) out[key] = value.trim();
    else if (forUpdate) out[key] = null;
  };
  if (d.mobile.trim()) out.mobile = d.mobile.trim();
  if (d.companyId) out.companyId = d.companyId;
  if (d.departmentId) out.departmentId = d.departmentId;
  for (const key of ["email", "designation", "govtIdType", "vehicleNumber"] as const) put(key, d[key]);
  for (const key of MASKED) if (d[key].trim()) out[key] = d[key].trim();
  if (d.credentialExpiresAt) out.credentialExpiresAt = d.credentialExpiresAt;
  else if (forUpdate) out.credentialExpiresAt = null;
  if (d.policeClearance) out.policeClearance = d.policeClearance === "yes";
  else if (forUpdate) out.policeClearance = null;
  return out;
}

export function ProfileFields({
  draft,
  onChange,
  category,
  passType,
  companies,
  departments,
  onFile,
}: {
  draft: ProfileDraft;
  onChange: (next: ProfileDraft) => void;
  category: string;
  passType: PassType | null;
  companies?: DirectoryList;
  departments?: DirectoryList;
  /** Masked values already saved, shown as "on file" (edit form only). */
  onFile?: Partial<Record<MaskedField, string | null>>;
}) {
  const set = (key: keyof ProfileDraft, value: string) => onChange({ ...draft, [key]: value });
  const label = (text: string, field: keyof ProfileDraft) => (ruleOf(field, category, passType) === "required" ? `${text} *` : text);
  const show = (field: keyof ProfileDraft) => ruleOf(field, category, passType) !== "hidden";
  const fileHint = (field: MaskedField, base?: string) =>
    onFile?.[field] ? `On file: ${onFile[field]} — type a new one to replace it` : base;
  const defaultRule = category === "EMPLOYEE" || !passType;

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {show("mobile") && <Field label={label("Mobile", "mobile")}><Input value={draft.mobile} onChange={(e) => set("mobile", e.target.value)} placeholder="+91 9876543210" /></Field>}
      {show("email") && <Field label={label("Email", "email")}><Input type="email" value={draft.email} onChange={(e) => set("email", e.target.value)} /></Field>}
      {show("companyId") && (
        <Field label={label("Company", "companyId")}>
          <Select value={draft.companyId} onChange={(e) => set("companyId", e.target.value)}>
            <option value="">Select company</option>
            {companies?.items.filter((x) => x.isActive || x.id === draft.companyId).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </Select>
        </Field>
      )}
      {show("departmentId") && (
        <Field label={label("Department", "departmentId")}>
          <Select value={draft.departmentId} onChange={(e) => set("departmentId", e.target.value)}>
            <option value="">Select department</option>
            {departments?.items.filter((x) => x.isActive || x.id === draft.departmentId).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </Select>
        </Field>
      )}
      {show("designation") && <Field label={label("Designation", "designation")}><Input maxLength={100} value={draft.designation} onChange={(e) => set("designation", e.target.value)} /></Field>}
      {show("govtIdType") && <Field label={label("Govt ID type", "govtIdType")}><Input maxLength={40} value={draft.govtIdType} onChange={(e) => set("govtIdType", e.target.value)} placeholder="e.g. Passport, Driving licence" /></Field>}
      {show("govtIdNumber") && <Field label={label("Govt ID number", "govtIdNumber")} hint={fileHint("govtIdNumber")}><Input maxLength={40} value={draft.govtIdNumber} onChange={(e) => set("govtIdNumber", e.target.value.toUpperCase())} /></Field>}
      {show("aadharNumber") && (
        <Field label={label("Aadhaar", "aadharNumber")} hint={fileHint("aadharNumber", defaultRule ? "Aadhaar or PAN is required" : undefined)}>
          <Input inputMode="numeric" maxLength={12} value={draft.aadharNumber} onChange={(e) => set("aadharNumber", e.target.value.replace(/\D/g, ""))} placeholder="123456789012" />
        </Field>
      )}
      {show("panNumber") && (
        <Field label={label("PAN", "panNumber")} hint={fileHint("panNumber", "Format: ABCDE1234F")}>
          <Input maxLength={10} value={draft.panNumber} onChange={(e) => set("panNumber", e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} placeholder="ABCDE1234F" />
        </Field>
      )}
      {show("vehicleNumber") && <Field label={label("Vehicle number", "vehicleNumber")}><Input maxLength={20} value={draft.vehicleNumber} onChange={(e) => set("vehicleNumber", e.target.value.toUpperCase())} placeholder="MH12AB1234" /></Field>}
      {show("policeClearance") && (
        <Field label={label("Police clearance", "policeClearance")}>
          <Select value={draft.policeClearance} onChange={(e) => set("policeClearance", e.target.value)}>
            <option value="">Not answered</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </Select>
        </Field>
      )}
      {show("credentialNumber") && (
        <Field label={label(`${passType?.credentialLabel ?? "Credential"} number`, "credentialNumber")} hint={fileHint("credentialNumber")}>
          <Input maxLength={60} value={draft.credentialNumber} onChange={(e) => set("credentialNumber", e.target.value)} />
        </Field>
      )}
      {show("credentialExpiresAt") && (
        <Field label={label(`${passType?.credentialLabel ?? "Credential"} valid until`, "credentialExpiresAt")} hint={passType?.credentialCapsValidity ? "a pass ends no later than this date" : undefined}>
          <Input type="date" value={draft.credentialExpiresAt} onChange={(e) => set("credentialExpiresAt", e.target.value)} />
        </Field>
      )}
    </div>
  );
}
