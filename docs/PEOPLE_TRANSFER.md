# Transferring People between installations

Moving registered People — their details **and** their enrollment photos — from
one VMS installation to another. The usual reason is a department that already
exists at one site and has to be registered again at a newly installed one,
without re-typing every person or re-capturing every face.

The tool is `backend/scripts/transfer-people.mjs`. It talks to each
installation's operator API over HTTP, exactly as the web console does: no
database access, no device commands, every validation rule and audit row
applies as if an operator had typed the person in.

**Nothing new has to be installed or built.** The script is a single file using
only what Node already provides, and the installer has already put Node on both
machines.

---

## Before you start

| Requirement | Why |
|---|---|
| The VMS backend **running** on whichever machine you point `--url` at | The script calls its API; the `VmsBackend` service is normally already running |
| An **ADMIN** login on both installations | Registering employees is admin-only |
| The backend **port** for each machine | `47102` by default; whoever ran the installer may have chosen another. It is the port in the console's URL, and `PORT` in `C:\VMS\backend\.env` |
| The **device registered** at the target, before importing employees | An employee needs at least one device at registration |
| A copy of `transfer-people.mjs` on each machine (USB stick is fine) | The installer does **not** ship it — unlike `C:\VMS\tools\create-license-request.mjs`, it is copied by hand from `backend/scripts/` for the transfer and can be deleted afterwards. Or run both halves from one PC if the two are on the same LAN |

The bundled Node is at `C:\VMS\node\node.exe` (adjust if the installer was
pointed elsewhere).

The commands below are written for **Windows PowerShell**, which is what opens
from the Start menu and from *Shift + right-click → Open PowerShell window
here*. Three PowerShell rules the examples already follow, and which are worth
knowing if you retype them:

- start the line with `&` — PowerShell needs it to run a program whose path is
  quoted;
- quote every path and value, because `C:\Users\Chirayu Chawande\...` and
  `"Department 2"` contain spaces;
- the line-continuation character is a backtick `` ` ``, not `^`. Paste the
  whole block at once; the `>>` PowerShell shows at the start of the
  continuation lines is its own prompt, not something you type.

In an old-style Command Prompt instead, drop the `&` and use `^` to continue
lines.

---

## Step 1 — export, on the existing installation

```powershell
& "C:\VMS\node\node.exe" "C:\transfer\transfer-people.mjs" export `
  --url "http://localhost:47102" `
  --email "admin@example.com" `
  --password "the admin password" `
  --department "Finance" `
  --directories `
  --out "C:\transfer\backup"
```

The script can sit anywhere — `"C:\Users\<you>\Downloads\transfer-people.mjs"`
works as well, as long as the path is quoted.

It prints how many people and photos it wrote, and names anyone with no photo
on file — those people will need a face capture at the new site.

## Step 2 — check what came out

`C:\transfer\backup` now holds:

```
people.json        names, mobiles, Aadhaar/PAN, device IDs, company + department
photos\<ID>.jpg    one full JPEG per person who had one
```

Open `people.json` and confirm the headcount looks right before going further.
It is plain text and carries identity numbers — treat the folder as sensitive
and delete it once the transfer is confirmed.

## Step 3 — carry it to the new machine

Copy the whole `backup` folder, photos included. If both PCs are on the same
network you can skip this and point `--url` at the other machine instead.

## Step 4 — prepare the new installation

Install as usual, run the setup wizard, and **register the terminal** before
importing. Companies and departments do *not* need to be created first — the
import creates them.

## Step 5 — import, on the new installation

```powershell
& "C:\VMS\node\node.exe" "C:\transfer\transfer-people.mjs" import `
  --url "http://localhost:47102" `
  --email "admin@example.com" `
  --password "the admin password" `
  --in "C:\transfer\backup" `
  --devices "Main Gate"
```

Mind the `--url`: it is the **new** installation's port, which is often not the
same number as the old one — check the console URL on that machine. Leave
`--devices` off to give employees access to every device registered there.

Order of work inside one run: companies and departments first, then each
person, then that person's photo. It prints what it created and a `skipped:`
list with a reason per person — read that list, it is the whole report.

## Step 6 — verify in the console

Open the new console, filter People by the department, and confirm the count
and that the photos appear. Employees are now desired on the devices you named,
so the normal provisioning path pushes them to the terminal — watch the device
queue, not this script, for that.

---

## Flags

### Both commands

| Flag | Required | Meaning |
|---|---|---|
| `--url` | yes | Base URL of the installation to act on, e.g. `http://localhost:47102` |
| `--email` | yes | Operator login (ADMIN) |
| `--password` | yes | That operator's password — quote it |

### `export`

| Flag | Required | Meaning |
|---|---|---|
| `--department` | one of these two | Export everyone in this department, matched by name, case-insensitively |
| `--company` | one of these two | Export everyone in this company. Given with `--department`, exports the intersection |
| `--directories` | no | Also dump every **active** company and department name, so a clean target ends up with the whole directory rather than only the names in use |
| `--out` | yes | Folder to write `people.json` and `photos\` into; created if absent |

### `import`

| Flag | Required | Meaning |
|---|---|---|
| `--in` | yes | The exported folder |
| `--devices` | no | Which devices employees get access to, by name, serial or id; comma-separated. Omitted, they get **every** registered device. A name that matches nothing stops the run before anything is written |
| `--include-inactive` | no | Also register people who were resigned or deactivated at the source. Off by default: registration always creates an *active* person with device access, so importing them silently puts a face back on a terminal |

---

## What transfers, and what does not

**Transfers:** name, mobile, Aadhaar, PAN, device user ID, category
(employee/visitor), company and department by name, and the enrollment
photograph.

**Does not transfer:** attendance and punch history, entries and visits, audit
history, operator accounts, devices, and cached face templates. Templates are
bound to the terminal's algorithm and are never portable — the photo is the
durable artifact, and the new terminal enrolls from it when the person is
provisioned.

## When a person is skipped

Every skip is reported with the person's device ID and a reason. The import is
safe to re-run once you have dealt with the cause; people already registered
are simply reported again.

- **ID already registered there** — the device user ID is the forever join key
  between database and terminal. A clash is a real decision about who owns that
  ID, so nothing is merged automatically.
- **Aadhaar or PAN already registered to another person** — same reasoning.
- **Employee with no device** — register the terminal at the target first, or
  name devices with `--devices`.
- **Inactive at the source** — see `--include-inactive` above.
- **Photo rejected** — the person *is* registered; only the image failed (a
  terminal-pushed photo can fall outside the dimensions the API accepts).
  Capture a new face for them in the console.

## Notes

- Imported people are always created **active**. Resignation state, and the
  original registration dates, do not come across.
- ID patterns are per device: if the new site's terminal classifies employee
  and visitor IDs differently, check that device's employee and visitor ID
  patterns there, or the imported IDs will sit unclassified.
- The export folder is unencrypted personal data. Delete it after the
  transfer is verified.
