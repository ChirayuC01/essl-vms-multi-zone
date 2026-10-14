import { rm } from "node:fs/promises";
import { CommandType, EntryState, PersonCategory, Prisma } from "@prisma/client";
import { publishCommand } from "../adms/queue.js";
import { AuditAction, auditRow } from "../db/audit.js";
import { prisma } from "../db/index.js";
import { classifyDeviceId, userIdKey } from "../user-id.js";
import { ServiceError } from "./errors.js";

// Erasure on request (F2 #1b; owner, 14 Oct 2026; amends hard rule #3 for an
// explicit request, DPDP). What a person IS goes; what HAPPENED stays:
//
//   wiped    name ("Erased person"), mobile, email, designation, every ID
//            number, vehicle, credential, police clearance, blacklist and
//            resignation reasons; the photo and cached face template; every
//            document file; their visit requests' name, mobile, email,
//            submitted form and selfie; the text and recipient of messages
//            sent to their mobile or email.
//   kept     the row and terminal ID (never reused, so no one inherits their
//            history), category, company and department (reports still count
//            the visit), passes, punches, consent records (proof of consent)
//            and the audit trail.
//
// The face is also queued for removal, best effort, from every terminal whose
// ID patterns cover the ID (rule #7) — it should already be gone, since a live
// pass or an employee not yet resigned is refused.

export const ERASED_NAME = "Erased person";

const LIVE = [EntryState.PENDING_PROVISION, EntryState.PROVISIONED, EntryState.INSIDE, EntryState.PENDING_DEPROVISION];

export async function erasePerson(personId: string, reason: string, actorId?: string) {
  if (!reason.trim()) throw new ServiceError(400, "a reason is required to erase a person");
  const person = await prisma.person.findUnique({ where: { id: personId }, include: { biometric: true } });
  if (!person) throw new ServiceError(404, "person not found");
  if (person.erasedAt) throw new ServiceError(409, "this person has already been erased");
  if (await prisma.entry.count({ where: { personId, state: { in: LIVE } } })) {
    throw new ServiceError(409, "this person has a live pass — end it first");
  }
  if (person.category === PersonCategory.EMPLOYEE && !person.resignedAt) {
    throw new ServiceError(409, "resign the employee first, so they are removed from every terminal");
  }

  const [documents, requests, devices] = await Promise.all([
    prisma.personDocument.findMany({ where: { OR: [{ personId }, { visitRequest: { personId } }] }, select: { id: true, storedPath: true } }),
    prisma.visitRequest.findMany({ where: { personId }, select: { id: true, selfiePath: true } }),
    prisma.device.findMany({ select: { id: true, employeeIdPatterns: true, visitorIdPatterns: true } }),
  ]);
  const recipients = [person.mobile, person.email].filter((v): v is string => Boolean(v));
  const terminals = devices.filter((d) => classifyDeviceId(person.esslUserId, d.employeeIdPatterns, d.visitorIdPatterns) !== null);
  const now = new Date();

  const commands = await prisma.$transaction(async (tx) => {
    await tx.person.update({
      where: { id: personId },
      data: {
        name: ERASED_NAME,
        mobile: null,
        email: null,
        designation: null,
        aadharNumber: null,
        panNumber: null,
        govtIdType: null,
        govtIdNumber: null,
        vehicleNumber: null,
        policeClearance: null,
        credentialNumber: null,
        credentialExpiresAt: null,
        blacklistReason: null,
        resignedReason: null,
        detailsComplete: false,
        isActive: false,
        erasedAt: now,
      },
    });
    await tx.personBiometric.deleteMany({ where: { personId } });
    if (documents.length) {
      await tx.personDocument.updateMany({
        where: { id: { in: documents.map((d) => d.id) } },
        data: { fileName: "erased", storedPath: "", removedAt: now },
      });
    }
    if (requests.length) {
      await tx.visitRequest.updateMany({
        where: { id: { in: requests.map((r) => r.id) } },
        data: { visitorName: ERASED_NAME, visitorMobile: "", visitorEmail: null, submission: Prisma.DbNull, selfiePath: null },
      });
    }
    if (recipients.length) {
      await tx.message.updateMany({ where: { recipient: { in: recipients } }, data: { recipient: "erased", body: "" } });
    }
    const created = terminals.length
      ? await tx.syncCommand.createManyAndReturn({
          data: terminals.map((d) => ({
            type: CommandType.DEPROVISION,
            targetDeviceId: d.id,
            personId,
            initiatedById: actorId ?? null,
            payload: { pin: person.esslUserId, countedOnDevice: false, bestEffort: true },
            idempotencyKey: `erase:${userIdKey(person.esslUserId)}:${d.id}:${now.getTime()}`,
          })),
        })
      : [];
    await tx.auditLog.create({
      data: auditRow({
        action: AuditAction.PERSON_ERASED,
        entityType: "person",
        entityId: personId,
        // Deliberately no name or number: the audit row must not undo the erasure.
        detail: { esslUserId: person.esslUserId, reason: reason.trim(), documents: documents.length, visitRequests: requests.length, terminals: terminals.map((d) => d.id) },
        actorId: actorId ?? null,
      }),
    });
    return created;
  });
  for (const command of commands) publishCommand(command);

  // Files only after the rows no longer point at them.
  const files = [
    person.biometric?.photoPath,
    ...documents.map((d) => d.storedPath),
    ...requests.map((r) => r.selfiePath),
  ].filter((f): f is string => Boolean(f));
  await Promise.all(files.map((f) => rm(f, { force: true })));
  return { erasedAt: now, terminalsQueued: terminals.length, filesDeleted: files.length };
}
