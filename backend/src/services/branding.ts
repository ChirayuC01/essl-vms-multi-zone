import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config/index.js";
import { prisma } from "../db/index.js";
import { ServiceError } from "./errors.js";

const NAME_KEY = "organization_name";
const LOGO_TYPE_KEY = "organization_logo_type";
const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const logoPath = path.join(config.brandingStoragePath, "logo");

function detectedType(bytes: Buffer): string | null {
  if (bytes[0] === 0x89 && bytes.subarray(1, 4).toString("ascii") === "PNG") return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

export function validateBrandingLogo(bytes: Buffer): string {
  if (bytes.length === 0 || bytes.length > MAX_LOGO_BYTES) throw new ServiceError(400, "logo must be between 1 byte and 2 MB");
  const contentType = detectedType(bytes);
  if (!contentType) throw new ServiceError(400, "logo must be PNG, JPEG, or WebP");
  return contentType;
}

export async function getBranding() {
  const [name, logoType] = await prisma.$transaction([
    prisma.appConfig.findUnique({ where: { key: NAME_KEY } }),
    prisma.appConfig.findUnique({ where: { key: LOGO_TYPE_KEY } }),
  ]);
  return {
    organizationName: typeof name?.value === "string" ? name.value : "Visitor Management System",
    logoUrl: typeof logoType?.value === "string" ? "/api/branding/logo" : null,
  };
}

export async function setOrganizationName(name: string, updatedBy?: string) {
  const value = name.trim();
  if (!value || value.length > 120) throw new ServiceError(400, "organization name must be 1-120 characters");
  await prisma.appConfig.upsert({
    where: { key: NAME_KEY },
    create: { key: NAME_KEY, value, updatedBy: updatedBy ?? null },
    update: { value, updatedBy: updatedBy ?? null },
  });
  return getBranding();
}

export async function saveBrandingLogo(bytes: Buffer, updatedBy?: string) {
  const contentType = validateBrandingLogo(bytes);
  await mkdir(config.brandingStoragePath, { recursive: true });
  const temporary = `${logoPath}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, logoPath);
  await prisma.appConfig.upsert({
    where: { key: LOGO_TYPE_KEY },
    create: { key: LOGO_TYPE_KEY, value: contentType, updatedBy: updatedBy ?? null },
    update: { value: contentType, updatedBy: updatedBy ?? null },
  });
  return getBranding();
}

export async function readBrandingLogo() {
  const type = await prisma.appConfig.findUnique({ where: { key: LOGO_TYPE_KEY } });
  if (typeof type?.value !== "string") return null;
  try { return { bytes: await readFile(logoPath), contentType: type.value }; }
  catch { return null; }
}
