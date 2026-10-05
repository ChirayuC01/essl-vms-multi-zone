import { PersonCategory, type Prisma } from "@prisma/client";
import { prisma } from "../db/index.js";
import { z } from "zod";

// Pass types and per-type profile rules (two-zone rebuild, Phase 3).
//
// A site's visitor types differ (a customs official needs only a name and a
// designation; a long-term contractor needs a police-clearance answer and an
// external credential). That difference is configuration on the pass type,
// never a branch in code (CLAUDE.md #2): each profile field is "required",
// "optional" or "hidden" per type.
//
// Name is always required. Employees, and visitors with no pass type, keep
// the rule the console has always enforced (DEFAULT_RULE below), so nothing
// about existing people changes.

export const PROFILE_FIELDS = {
  mobile: "Mobile",
  email: "Email",
  companyId: "Company",
  departmentId: "Department",
  designation: "Designation",
  govtIdType: "Govt ID type",
  govtIdNumber: "Govt ID number",
  aadharNumber: "Aadhaar",
  panNumber: "PAN",
  vehicleNumber: "Vehicle number",
  policeClearance: "Police clearance",
  credentialNumber: "Credential number",
  credentialExpiresAt: "Credential expiry",
} as const;
export type ProfileField = keyof typeof PROFILE_FIELDS;
export const FIELD_RULES = ["required", "optional", "hidden"] as const;
export type FieldRule = (typeof FIELD_RULES)[number];

const FIELD_KEYS = Object.keys(PROFILE_FIELDS) as [ProfileField, ...ProfileField[]];
export const fieldRulesSchema = z.record(z.enum(FIELD_KEYS), z.enum(FIELD_RULES));
export type FieldRules = Partial<Record<ProfileField, FieldRule>>;

export interface RuleSource {
  fieldRules: unknown;
  credentialLabel: string | null;
}

/** A field's rule for this type. Unlisted = optional; credential fields are hidden on a type without a credential. */
export function ruleFor(type: RuleSource, field: ProfileField): FieldRule {
  if ((field === "credentialNumber" || field === "credentialExpiresAt") && !type.credentialLabel) return "hidden";
  const parsed = fieldRulesSchema.safeParse(type.fieldRules);
  return (parsed.success ? parsed.data[field] : undefined) ?? "optional";
}

type ProfileValues = { [K in ProfileField]?: unknown } & { category: PersonCategory };

const blank = (v: unknown) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");

/**
 * What is missing for this profile to be complete, as field keys. The pseudo
 * key "aadharNumber|panNumber" means "either one" under the default rule.
 */
export function profileGaps(person: ProfileValues, passType: RuleSource | null): string[] {
  if (person.category === PersonCategory.EMPLOYEE || !passType) {
    const gaps: string[] = (["mobile", "companyId", "departmentId"] as const).filter((f) => blank(person[f]));
    if (blank(person.aadharNumber) && blank(person.panNumber)) gaps.push("aadharNumber|panNumber");
    return gaps;
  }
  return FIELD_KEYS.filter((f) => ruleFor(passType, f) === "required" && blank(person[f]));
}

export function describeGaps(gaps: string[]): string {
  return gaps
    .map((g) => (g === "aadharNumber|panNumber" ? "Aadhaar or PAN" : PROFILE_FIELDS[g as ProfileField] ?? g))
    .join(", ");
}

/**
 * Refresh the stored "details complete" flag for a set of people, after a
 * write that can change it without going through the person routes (a
 * directory bulk assignment, a pass type's rules changing). One read and at
 * most two writes however many people (CLAUDE.md #4).
 */
export async function recomputeDetails(where: Prisma.PersonWhereInput): Promise<void> {
  const people = await prisma.person.findMany({ where, include: { passType: true } });
  const complete: string[] = [];
  const incomplete: string[] = [];
  for (const p of people) (profileGaps(p, p.passType).length === 0 ? complete : incomplete).push(p.id);
  await prisma.$transaction([
    prisma.person.updateMany({ where: { id: { in: complete } }, data: { detailsComplete: true } }),
    prisma.person.updateMany({ where: { id: { in: incomplete } }, data: { detailsComplete: false } }),
  ]);
}
