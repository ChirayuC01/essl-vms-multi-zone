import { randomBytes, scryptSync } from "node:crypto";
import { PrismaClient } from "@prisma/client";

// Idempotent development seed: one admin operator and the known test device.
// Safe to run repeatedly (upserts on natural keys).
//
// Default admin credentials (DEV ONLY): admin@vms.local / admin
// Password hash format is "scrypt$<saltHex>$<hashHex>" with the params below.
// The Milestone 4 auth layer must verify against this format or re-seed.

const prisma = new PrismaClient();

const SCRYPT_KEYLEN = 64;

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

async function main(): Promise<void> {
  const admin = await prisma.appUser.upsert({
    where: { email: "admin@vms.local" },
    update: {},
    create: {
      email: "admin@vms.local",
      passwordHash: hashPassword("admin"),
      role: "ADMIN",
      // A seeded password is published in this file, so every installation
      // would otherwise ship with the same known credential — and "change it
      // before deployment" in a README is not a control, it is a hope. The
      // forced change makes the first sign-in replace it.
      //
      // `update: {}` above means existing installs are untouched; this only
      // applies where the admin is being created.
      mustChangePassword: true,
    },
  });

  // The Phase 0 test unit. Every identity field here is authoritative — read
  // from the device's own firmware / INFO response, not from any label.
  const device = await prisma.device.upsert({
    where: { serialNo: "NCD8252500406" },
    update: {},
    create: {
      name: "x2008",
      serialNo: "NCD8252500406",
      ip: "192.168.0.25",
      role: "BOTH", // single device; altinout for IN/OUT testing until unit #2
      timezoneOffsetMinutes: 330, // +05:30
      maxFaces: 3000,
      normalGroupId: 1,
      blockedGroupId: 100,
      firmwareVersion: "ZAM180-NF50VA-Ver3.4.10",
      algorithmVersion: "Face VX3.9",
    },
  });

  // eslint-disable-next-line no-console
  console.log(`Seeded admin ${admin.email} and device ${device.serialNo}.`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
