#!/usr/bin/env node
// Move a department's People — details and enrollment photos — from one VMS
// installation to another, over the operator API of each. Nothing here touches
// a database or a device directly: registration goes through POST /people, so
// every validation rule and audit row applies exactly as if an operator typed
// it in.
//
//   node transfer-people.mjs export --url http://localhost:47102 \
//        --email admin@example.com --password '...' \
//        [--department 'Finance'] [--company 'Acme'] [--directories] --out ./dept-backup
//
//   node transfer-people.mjs import --url http://TARGET:47102 \
//        --email admin@example.com --password '...' --in ./dept-backup [--devices 'Main Gate']
//
// --department and --company are filters, either or both. --directories also
// dumps the full active company and department lists, so a clean target install
// arrives with the whole directory, not only the names the exported people use.
//
// Export writes <out>/people.json plus <out>/photos/<ID>.jpg.
// Import is re-runnable: an already-registered ID is reported and skipped.
// Inactive/resigned people are skipped unless --include-inactive is given.
//
// Use an ADMIN account on both ends — registering EMPLOYEEs needs it.

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const args = Object.fromEntries(
  process.argv.slice(3).flatMap((a, i, all) => (a.startsWith("--") ? [[a.slice(2), all[i + 1] ?? "true"]] : [])),
);
const mode = process.argv[2];

function need(flag) {
  if (!args[flag]) throw new Error(`missing --${flag}`);
  return args[flag];
}

async function api(token, method, route, body, raw = false) {
  const res = await fetch(new URL(`/api${route}`, need("url")), {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": Buffer.isBuffer(body) ? "image/jpeg" : "application/json" }),
    },
    body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text();
    const err = new Error(`${method} ${route} -> ${res.status} ${detail.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return raw ? Buffer.from(await res.arrayBuffer()) : res.json();
}

async function login() {
  const { token } = await api(null, "POST", "/auth/login", { email: need("email"), password: need("password") });
  return token;
}

const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

async function runExport() {
  if (!args.department && !args.company) throw new Error("give --department and/or --company");
  const out = path.resolve(need("out"));
  const token = await login();

  // Both filters resolve by name to this install's ids; the target install has
  // its own, which is why the dump carries names throughout.
  async function resolve(kind, name) {
    const { items } = await api(token, "GET", `/${kind}`);
    const match = items.find((i) => sameName(i.name, name));
    if (!match) throw new Error(`no ${kind.slice(0, -1)} named "${name}" — have: ${items.map((i) => i.name).join(", ")}`);
    return match;
  }
  const department = args.department ? await resolve("departments", args.department) : null;
  const company = args.company ? await resolve("companies", args.company) : null;
  const filter =
    (department ? `&departmentId=${department.id}` : "") + (company ? `&companyId=${company.id}` : "");

  const people = [];
  for (let page = 1; ; page++) {
    const res = await api(token, "GET", `/people?pageSize=100&page=${page}${filter}`);
    people.push(...res.items);
    if (people.length >= res.total || res.items.length === 0) break;
  }

  await mkdir(path.join(out, "photos"), { recursive: true });
  let photos = 0;
  for (const p of people) {
    if (!p.hasPhoto) continue;
    const jpeg = await api(token, "GET", `/people/${p.id}/photo`, undefined, true);
    await writeFile(path.join(out, "photos", `${p.esslUserId.toUpperCase()}.jpg`), jpeg);
    photos++;
  }

  // Inactive entries are left behind deliberately: they were switched off
  // here, and recreating them on a clean install would switch them back on.
  let directories;
  if (args.directories) {
    const [companies, departments] = await Promise.all([
      api(token, "GET", "/companies"),
      api(token, "GET", "/departments"),
    ]);
    directories = {
      companies: companies.items.filter((i) => i.isActive).map((i) => i.name),
      departments: departments.items.filter((i) => i.isActive).map((i) => i.name),
    };
  }

  await writeFile(
    path.join(out, "people.json"),
    JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        scope: { department: department?.name ?? null, company: company?.name ?? null },
        directories,
        people: people.map((p) => ({
          name: p.name,
          category: p.category,
          mobile: p.mobile,
          aadharNumber: p.aadharNumber,
          panNumber: p.panNumber,
          esslUserId: p.esslUserId,
          company: p.company?.name ?? null,
          department: p.department?.name ?? null,
          isActive: p.isActive,
          hasPhoto: p.hasPhoto,
        })),
      },
      null,
      2,
    ),
  );
  const scope = [department?.name, company?.name].filter(Boolean).join(" + ");
  console.log(`exported ${people.length} people (${photos} photos) from "${scope}" to ${out}`);
  if (directories) console.log(`  plus ${directories.companies.length} companies and ${directories.departments.length} departments`);
  const missing = people.filter((p) => !p.hasPhoto);
  if (missing.length) console.log(`  no photo on file: ${missing.map((p) => p.esslUserId).join(", ")}`);
}

async function runImport() {
  const token = await login();
  const dir = path.resolve(need("in"));
  const dump = JSON.parse(await readFile(path.join(dir, "people.json"), "utf8"));
  const photoFiles = new Set(await readdir(path.join(dir, "photos")).catch(() => []));

  // Company and department are named, not id-matched: the target install has
  // its own ids. Missing ones are created, so the directory arrives with the
  // people rather than having to be typed in first.
  const cache = new Map();
  async function directoryId(kind, name) {
    const key = `${kind}:${name.toLowerCase()}`;
    if (cache.has(key)) return cache.get(key);
    const { items } = await api(token, "GET", `/${kind}`);
    let item = items.find((i) => sameName(i.name, name));
    if (!item) item = await api(token, "POST", `/${kind}`, { name });
    cache.set(key, item.id);
    return item.id;
  }

  // The full directory first, when the export carried one: a clean install
  // then holds every company and department, not only the ones in use here.
  for (const name of dump.directories?.companies ?? []) await directoryId("companies", name);
  for (const name of dump.directories?.departments ?? []) await directoryId("departments", name);

  const { items: devices } = await api(token, "GET", "/devices");
  const wanted = args.devices?.split(",").map((s) => s.trim()) ?? null;
  const deviceIds = (wanted ? devices.filter((d) => wanted.some((w) => sameName(d.name, w) || d.serialNo === w || d.id === w)) : devices).map((d) => d.id);
  if (wanted && deviceIds.length !== wanted.length) throw new Error(`--devices matched ${deviceIds.length} of ${wanted.length}; have: ${devices.map((d) => d.name).join(", ")}`);

  let created = 0, withPhoto = 0;
  const skipped = [];
  for (const p of dump.people) {
    // Registration always creates an ACTIVE person with device access, so a
    // resigned or deactivated source record would quietly come back to life —
    // with a face on the new terminal. It has to be asked for.
    if (p.isActive === false && !args["include-inactive"]) {
      skipped.push(`${p.esslUserId}: inactive/resigned at the source — pass --include-inactive to register them anyway`);
      continue;
    }
    if (p.category === "EMPLOYEE" && deviceIds.length === 0) {
      skipped.push(`${p.esslUserId}: employee needs a device — register a device first or pass --devices`);
      continue;
    }
    let person;
    try {
      person = await api(token, "POST", "/people", {
        name: p.name,
        mobile: p.mobile ?? undefined,
        aadharNumber: p.aadharNumber ?? undefined,
        panNumber: p.panNumber ?? undefined,
        category: p.category,
        esslUserId: p.esslUserId,
        companyId: await directoryId("companies", p.company ?? "Unassigned"),
        departmentId: await directoryId("departments", p.department ?? dump.scope.department ?? "Unassigned"),
        deviceIds: p.category === "EMPLOYEE" ? deviceIds : [],
      });
      created++;
    } catch (err) {
      skipped.push(`${p.esslUserId}: ${err.message}`);
      continue;
    }
    const file = `${p.esslUserId.toUpperCase()}.jpg`;
    if (!photoFiles.has(file)) continue;
    try {
      await api(token, "POST", `/people/${person.id}/photo`, await readFile(path.join(dir, "photos", file)));
      withPhoto++;
    } catch (err) {
      skipped.push(`${p.esslUserId}: registered, photo rejected — ${err.message}`);
    }
  }
  console.log(`imported ${created} people (${withPhoto} photos), ${cache.size} companies/departments in place`);
  if (skipped.length) console.log(`skipped:\n  ${skipped.join("\n  ")}`);
}

try {
  if (mode === "export") await runExport();
  else if (mode === "import") await runImport();
  else throw new Error("usage: transfer-people.mjs export|import --url ... --email ... --password ... [--department|--company|--directories|--out|--in|--devices|--include-inactive]");
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
