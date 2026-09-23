// Throwaway ADMS/PUSH protocol test server — Phase 0 verification
// eSSL device NCD8252500406 / ZAM180_TFT / Face VX3.9 / FW ZAM180-NF50VA-Ver3.4.10
//
// Run:   npm install   (once)
//        npm start
//
// Device: Menu -> COMM. -> Cloud Server Settings
//         Mode ADMS, Address 192.168.0.106, Port 8080
//
// ---------------------------------------------------------------------
// FIRMWARE FINDINGS (all confirmed on this unit)
//
// 1. Endpoints carry an .aspx suffix:
//      GET  /iclock/getrequest.aspx?SN=...
//      POST /iclock/cdata.aspx?SN=...&table=ATTLOG&Stamp=...
//
// 2. Commands must be returned as   C:<CmdID>:<COMMAND>
//    A bare command is silently ignored. IDs are assigned here.
//
// 3. Device replies on /iclock/devicecmd.aspx with
//      ID=<n>&Return=0&CMD=DATA        (Return=0 means success)
//
// 4. Punches (table=ATTLOG), tab separated:
//      PIN <TAB> YYYY-MM-DD HH:MM:SS <TAB> status <TAB> verify <TAB> ...
//    verify=15 means face. Timestamps are DEVICE LOCAL time (+05:30).
//
// 5. Polling is adaptive: ~30s idle, but 1-3s immediately after activity.
//
// 6. DATA QUERY USERINFO PIN=x makes the device push back three records:
//      USER     ... TZ=... StartDatetime=0 EndDatetime=0   (OPERLOG)
//      BIODATA  ... Type=9 MajorVer=39 Tmp=<base64>        (BIODATA)
//      BIOPHOTO ... FileName=x.jpg Size=n Content=<base64> (OPERLOG)
//    The BIOPHOTO content is a full JPEG — this is the durable artifact.
// ---------------------------------------------------------------------

const fastify = require('fastify')({ logger: false, bodyLimit: 20 * 1024 * 1024 });
const fs = require('fs');
const path = require('path');

const PHOTO_DIR = path.join(__dirname, 'photos');
if (!fs.existsSync(PHOTO_DIR)) fs.mkdirSync(PHOTO_DIR);

// Device bodies arrive with unknown/absent content-types. Take raw buffers.
fastify.addContentTypeParser('*', { parseAs: 'buffer' }, (req, body, done) => {
  done(null, body);
});

function log(label, extra) {
  const t = new Date().toISOString().split('T')[1].split('.')[0];
  console.log(`\n[${t}] ${label}`);
  if (extra !== undefined) console.log(extra);
}

fastify.addHook('onRequest', (request, reply, done) => {
  if (request.url !== '/favicon.ico') {
    // Truncate very long URLs so the console stays readable
    const u = request.url.length > 120 ? request.url.slice(0, 120) + '…' : request.url;
    log(`>>> ${request.method} ${u}   from ${request.ip}`);
  }
  done();
});

function adms(name, handler) {
  for (const url of [`/iclock/${name}`, `/iclock/${name}.aspx`]) {
    fastify.route({ method: ['GET', 'POST'], url, handler });
  }
}

// ---- command queue -------------------------------------------------
let nextCmdId = 1;
const pending = [];
const inFlight = new Map();

function queueCommand(cmd) {
  const id = nextCmdId++;
  pending.push({ id, cmd });
  return id;
}

// ---- known user state (for diffing) --------------------------------
// Every USER record the device sends is remembered, so the next one can
// be diffed against it. This is how the TZ / validity-window fields get
// decoded: change one thing, re-query, see exactly what moved.
const lastUsers = new Map();   // pin -> fields object

function diffUser(pin, fields) {
  const prev = lastUsers.get(pin);
  lastUsers.set(pin, { ...fields });
  if (!prev) return null;
  const changes = [];
  const keys = new Set([...Object.keys(prev), ...Object.keys(fields)]);
  for (const k of keys) {
    if (prev[k] !== fields[k]) {
      changes.push(`    ${k}:  ${prev[k] === undefined ? '(absent)' : prev[k]}  ->  ${fields[k] === undefined ? '(absent)' : fields[k]}`);
    }
  }
  return changes.length ? changes.join('\n') : '    (no change)';
}

// ---- record parsing ------------------------------------------------
// Records look like:  TYPE key=value <TAB> key=value <TAB> ...
// The first token before the first tab/space holds the record type and
// usually the first field too, e.g. "BIOPHOTO PIN=9001".
function parseRecord(line) {
  const parts = line.split('\t').map(s => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  const fields = {};
  let type = null;

  parts.forEach((part, i) => {
    if (i === 0) {
      const sp = part.indexOf(' ');
      if (sp > -1 && !part.slice(0, sp).includes('=')) {
        type = part.slice(0, sp);
        part = part.slice(sp + 1).trim();
      }
    }
    const eq = part.indexOf('=');
    if (eq > -1) fields[part.slice(0, eq).trim()] = part.slice(eq + 1);
  });

  return { type, fields };
}

function handleBody(text) {
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const rec = parseRecord(line);
    if (!rec) continue;

    // Save enrollment photos to disk — this is the artifact the whole
    // product depends on, and it is far too large to copy by hand.
    if (rec.type === 'BIOPHOTO' && rec.fields.Content) {
      const pin = rec.fields.PIN || rec.fields.Pin || 'unknown';
      const file = path.join(PHOTO_DIR, `${pin}.jpg`);
      try {
        const buf = Buffer.from(rec.fields.Content, 'base64');
        fs.writeFileSync(file, buf);
        log(`  *** BIOPHOTO SAVED  pin=${pin}  ${buf.length} bytes -> photos/${pin}.jpg`);
      } catch (e) {
        log(`  !!! failed to save photo for pin=${pin}: ${e.message}`);
      }
      continue;
    }

    // Biometric template — algorithm-bound, cache only.
    if (rec.type === 'BIODATA') {
      const pin = rec.fields.Pin || rec.fields.PIN;
      const tmp = rec.fields.Tmp || '';
      log(`  BIODATA  pin=${pin}  Type=${rec.fields.Type}  ` +
          `Ver=${rec.fields.MajorVer}.${rec.fields.MinorVer}  template=${tmp.length} b64 chars`);
      continue;
    }

    // User record — print the fields that matter for the VMS.
    if (rec.type === 'USER') {
      const f = rec.fields;
      log(`  USER  pin=${f.PIN}  name=${f.Name}  Pri=${f.Pri}  Grp=${f.Grp}`);
      log(`        TZ=${f.TZ}  Verify=${f.Verify}  ` +
          `Start=${f.StartDatetime}  End=${f.EndDatetime}`);
      const d = diffUser(f.PIN, f);
      if (d) log('  CHANGED SINCE LAST QUERY:', d);
      continue;
    }

    // Anything else (ATTLOG rows, OPERLOG events) — print raw.
    log('  raw:', line.length > 400 ? line.slice(0, 400) + ' …(truncated)' : line);
  }
}

// 1) Data push / check-in
adms('cdata', async (request, reply) => {
  const { SN, table, c, Stamp, OpStamp } = request.query;
  log(`CDATA   device=${SN}  table=${table || '-'}  cmd=${c || '-'}  ` +
      `stamp=${Stamp || OpStamp || '-'}`);
  if (request.body && request.body.length) {
    handleBody(request.body.toString());
  }
  reply.type('text/plain').send('OK');
});

// 2) Command poll — MUST answer with C:<id>:<command>
adms('getrequest', async (request, reply) => {
  const { SN } = request.query;
  if (pending.length > 0) {
    const { id, cmd } = pending.shift();
    inFlight.set(id, cmd);
    log(`GETREQUEST  device=${SN}  -> sending id=${id}  (${cmd.length} chars)`);
    log('  cmd:', cmd.length > 200 ? cmd.slice(0, 200) + ' …(truncated)' : cmd);
    reply.type('text/plain').send(`C:${id}:${cmd}`);
  } else {
    log(`GETREQUEST  device=${SN}  (nothing queued)`);
    reply.type('text/plain').send('OK');
  }
});

// 3) Command results
adms('devicecmd', async (request, reply) => {
  const raw = request.body && request.body.length
    ? request.body.toString()
    : new URLSearchParams(request.query).toString();
  log('DEVICECMD raw:', raw);

  const parsed = Object.fromEntries(new URLSearchParams(raw));
  if (parsed.ID !== undefined) {
    const original = inFlight.get(Number(parsed.ID));
    const ok = parsed.Return === '0';
    log(`  -> id=${parsed.ID}  ${ok ? 'SUCCESS' : 'FAILED (Return=' + parsed.Return + ')'}`);
    if (original) {
      log('  -> was:', original.length > 200 ? original.slice(0, 200) + ' …' : original);
      inFlight.delete(Number(parsed.ID));
    }
  }
  reply.type('text/plain').send('OK');
});

// 4) Biometric/photo uploads
adms('fdata', async (request, reply) => {
  const { SN } = request.query;
  const size = request.body ? request.body.length : 0;
  log(`FDATA   device=${SN}  received ${size} bytes`);
  if (request.body && request.body.length) handleBody(request.body.toString());
  reply.type('text/plain').send('OK');
});

fastify.setNotFoundHandler((request, reply) => {
  if (request.url === '/favicon.ico') { reply.code(204).send(); return; }
  log(`!!! UNHANDLED PATH: ${request.method} ${request.url}`);
  if (request.body && request.body.length) log('  body:', request.body.toString());
  reply.type('text/plain').send('OK');
});

// ---- browser helpers -----------------------------------------------

// Queue any command:  /queue?cmd=INFO      (%09 = TAB between fields)
fastify.get('/queue', async (request, reply) => {
  const cmd = request.query.cmd;
  if (!cmd) {
    const saved = fs.readdirSync(PHOTO_DIR).filter(f => f.endsWith('.jpg'));
    reply.type('text/plain').send(
`ADMS test server

${pending.length} queued, ${inFlight.size} awaiting result.
Saved photos: ${saved.length ? saved.join(', ') : '(none yet)'}

  /queue?cmd=...          queue any raw command (C:<id>: added for you)
  /user?pin=9001          query a user (prints a diff vs last time)
  /set-user?pin=9001&tz=0000000000000000
  /set-user?pin=9001&start=...&end=...
  /delete-user?pin=9002
  /users                  last known state of every user seen
  /push-photo?pin=9001    push a saved photo back to the device
  /photo?pin=9001         view a saved photo in the browser

Commands confirmed working on this firmware:
  INFO
  DATA QUERY USERINFO PIN=9001
  DATA UPDATE USERINFO PIN=9002%09Name=TEST TWO%09Pri=0
  DATA DELETE USERINFO PIN=9002
  REBOOT
`);
    return;
  }
  const id = queueCommand(decodeURIComponent(cmd));
  reply.type('text/plain').send(
    `Queued id=${id}: ${decodeURIComponent(cmd)}\n` +
    `${pending.length} waiting for next poll (1-3s after recent activity).`
  );
});

// Push a saved photo back to the device.
//   /push-photo?pin=9001              uses photos/9001.jpg for user 9001
//   /push-photo?pin=9001&as=9002      pushes 9001's photo onto user 9002
fastify.get('/push-photo', async (request, reply) => {
  const pin = request.query.pin;
  const target = request.query.as || pin;
  if (!pin) { reply.type('text/plain').send('Need ?pin=...'); return; }

  const file = path.join(PHOTO_DIR, `${pin}.jpg`);
  if (!fs.existsSync(file)) {
    reply.type('text/plain').send(
      `No saved photo at photos/${pin}.jpg\n` +
      `Run /queue?cmd=DATA%20QUERY%20USERINFO%20PIN=${pin} first — the device\n` +
      `will push its BIOPHOTO back and it gets saved automatically.`
    );
    return;
  }

  const buf = fs.readFileSync(file);
  const b64 = buf.toString('base64');
  // NOTE: the device reports Size as the BASE64 character count, not the
  // decoded byte count (observed: Size=59128 for a 44346-byte JPEG, exactly
  // 4/3). Match its own convention rather than sending byte length.
  const cmd =
    `DATA UPDATE BIOPHOTO PIN=${target}\tFileName=${target}.jpg\t` +
    `Type=9\tSize=${b64.length}\tContent=${b64}`;
  const id = queueCommand(cmd);

  reply.type('text/plain').send(
    `Queued id=${id}: DATA UPDATE BIOPHOTO for PIN=${target}\n` +
    `Source: photos/${pin}.jpg  (${buf.length} bytes decoded, Size=${b64.length} base64 chars)\n\n` +
    `Watch the console for the device's Return code, then check\n` +
    `Menu -> System Info -> Device Capacity to see if the face count rose.`
  );
});

// View a saved photo
fastify.get('/photo', async (request, reply) => {
  const file = path.join(PHOTO_DIR, `${request.query.pin}.jpg`);
  if (!fs.existsSync(file)) { reply.code(404).type('text/plain').send('Not found'); return; }
  reply.type('image/jpeg').send(fs.readFileSync(file));
});

// Query a user:  /user?pin=9001
fastify.get('/user', async (request, reply) => {
  const pin = request.query.pin;
  if (!pin) { reply.type('text/plain').send('Need ?pin=...'); return; }
  const id = queueCommand(`DATA QUERY USERINFO PIN=${pin}`);
  reply.type('text/plain').send(
    `Queued id=${id}: DATA QUERY USERINFO PIN=${pin}\n` +
    `The device will push back USER, BIODATA and BIOPHOTO records.\n` +
    `Any change since the last query is printed as a diff in the console.`
  );
});

// Update a user, supplying only the fields you care about:
//   /set-user?pin=9001&name=TEST ONE&tz=0000000000000000
//   /set-user?pin=9001&start=20260729090000&end=20260729180000
// Fields omitted are simply not sent. Note the device may reset unsent
// fields to defaults — always re-query afterwards to see what stuck.
fastify.get('/set-user', async (request, reply) => {
  const q = request.query;
  if (!q.pin) { reply.type('text/plain').send('Need ?pin=...'); return; }

  const parts = [`PIN=${q.pin}`];
  const map = {
    name: 'Name', pri: 'Pri', passwd: 'Passwd', card: 'Card',
    grp: 'Grp', tz: 'TZ', verify: 'Verify',
    start: 'StartDatetime', end: 'EndDatetime',
  };
  for (const [param, field] of Object.entries(map)) {
    if (q[param] !== undefined) parts.push(`${field}=${q[param]}`);
  }

  const cmd = `DATA UPDATE USERINFO ${parts.join('\t')}`;
  const id = queueCommand(cmd);
  reply.type('text/plain').send(
    `Queued id=${id}:\n${cmd.replace(/\t/g, ' <TAB> ')}\n\n` +
    `Then run /user?pin=${q.pin} to see what the device actually stored.`
  );
});

// Delete a user:  /delete-user?pin=9002
fastify.get('/delete-user', async (request, reply) => {
  const pin = request.query.pin;
  if (!pin) { reply.type('text/plain').send('Need ?pin=...'); return; }
  const id = queueCommand(`DATA DELETE USERINFO PIN=${pin}`);
  reply.type('text/plain').send(`Queued id=${id}: DATA DELETE USERINFO PIN=${pin}`);
});

// Last known state of every user the device has reported
fastify.get('/users', async (request, reply) => {
  if (!lastUsers.size) {
    reply.type('text/plain').send('No user records seen yet. Try /user?pin=9001');
    return;
  }
  let out = 'Last known user records\n\n';
  for (const [pin, f] of lastUsers) {
    out += `PIN ${pin}\n`;
    for (const [k, v] of Object.entries(f)) out += `    ${k} = ${v}\n`;
    out += '\n';
  }
  reply.type('text/plain').send(out);
});

fastify.listen({ port: 8080, host: '0.0.0.0' }, (err) => {
  if (err) { console.error(err); process.exit(1); }
  console.log('ADMS test server listening on 0.0.0.0:8080');
  console.log('Photos received from the device are saved to ./photos/');
  console.log('Helpers: /queue  /user  /set-user  /delete-user  /users');
  console.log('         /push-photo?pin=9001   /photo?pin=9001');
  console.log('');
});
