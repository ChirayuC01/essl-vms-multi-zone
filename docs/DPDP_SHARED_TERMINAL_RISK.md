# Storing photographs from a terminal we share with the client's staff

> **0.4.4 update:** the Vendor-only pattern model described below is historical. Every device now has distinct `employeeIdPatterns` and `visitorIdPatterns`. Empty patterns classify nobody; overlapping patterns are rejected; unmatched or ambiguous IDs remain unclaimed and are never modified automatically. Configure and approve both non-overlapping pattern sets before connecting a shared terminal. Employees and Visitors are both intentional Person records, but collection of biometric photos, Aadhaar/PAN, access, retention, notices, and operator permissions must still have an approved purpose and policy.

**Who this is for:** anyone deciding what we should and should not collect at a
client site. No technical background assumed. Written to be forwarded as-is.

---

## The short version

At the first client site, the face-recognition terminal at the gate is **already
in use for the client's own employees**. Roughly five hundred people are
enrolled on it, and only some of them are vendors.

Our system works by keeping a **permanent copy of each vendor's face
photograph**. That is the whole product: it is what lets a returning vendor
walk in without being registered from scratch every visit.

The problem is that **the terminal does not tell us who is a vendor and who is
an employee.** It just reports an ID number. Left to work automatically, our
system will copy the face photograph of *every* person the terminal mentions —
including several hundred of the client's own staff, who have nothing to do
with vendor management.

We should decide that deliberately rather than discover it later.

---

## Why this matters legally

Face photographs are **personal data**, and biometric data specifically, under
India's Digital Personal Data Protection Act. Three points a lawyer would raise:

1. **Purpose.** Data may be collected for a stated purpose. Ours is "managing
   vendor entry". An employee's face photograph sitting in a vendor system has
   no stated purpose — nobody ever said it would be collected for this, and
   nobody agreed to it.

2. **Consent.** Vendors will be told at registration that their photograph is
   kept. Employees will not, because from their point of view nothing happened
   — they simply used the attendance terminal as they do every day.

3. **How long we keep it.** We keep vendor photographs **forever**, on purpose.
   That is defensible for a vendor whose whole relationship with the system is
   returning to site. It is not defensible for an employee who was never
   supposed to be in the system at all.

The client is the one legally answerable for the data held in their building.
So this is not only our exposure — but it *is* our design decision, and if it
is never raised, it becomes their problem without them having agreed to it.

---

## Why it matters even setting the law aside

There is a screen in our system called **"waiting to be registered"**. Its job
is to show gate staff the people who have been enrolled on the terminal and
still need to be set up as vendors — a short, actionable list.

If we copy everybody, that list fills with several hundred employees who will
never be vendors. The staff member's job becomes sifting rather than acting.
The same happens to the system's warning messages, which would never stop
firing.

**A screen nobody trusts is worse than no screen.** This alone would push us the
same way the legal argument does.

---

## What we are doing about it

The automatic behaviour stays — it is genuinely useful, and on a terminal used
only for vendors it is exactly right. We are adding two controls around it:

1. **A way to say which IDs are vendors.** The site's ID numbers follow a
   pattern (for example, staff IDs all beginning with the same few letters).
   Once the client confirms their numbering convention, we can tell the system
   to only pick up the IDs that are actually vendors. Until they confirm it,
   nothing is restricted.

2. **Unclaimed photographs are not kept indefinitely.** If a photograph is
   picked up and nobody registers that person as a vendor within a set number
   of days, it is deleted. This is safe: **the terminal still has it**, so if
   that person genuinely turns out to be a vendor later, we simply ask the
   terminal for it again. We are discarding a temporary copy, not the record.

Together these mean the worst case is bounded — a limited number of photographs
held for a limited time — rather than a permanent, growing collection of staff
biometrics nobody asked for.

---

## What we need from the client

Three things, none of them technical:

1. **Their ID numbering convention.** Which prefixes or ranges are employees,
   and which are vendors? This single answer removes most of the problem. They
   already have the full list in their existing attendance software and can
   export it.

2. **A decision they have actually made**, in writing, that vendor photographs
   are stored permanently in this system — and the wording they will use to
   tell vendors so.

3. **A named person on their side** who is responsible for this data. Somebody
   has to be able to answer a vendor who asks what is held about them.

---

## The bottom line

We are about to install a system that copies people's faces. At this site, most
of the faces on that terminal belong to the client's own employees, not to
vendors. That is fine if it is a decision somebody made, and a problem if it is
something we let happen by default.

We have built the controls to limit it. What we need is the client's numbering
convention and a clear yes on how long vendor photographs are kept.
