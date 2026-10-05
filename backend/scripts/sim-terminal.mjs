#!/usr/bin/env node
// Play a virtual eSSL terminal against a running backend (development only).
// It speaks exactly the ADMS calls a real terminal makes; see
// docs/TESTING_WITH_TWO_TERMINALS.md.
//
//   node scripts/sim-terminal.mjs hello  <SERIAL>                 make it appear under "Unregistered devices"
//   node scripts/sim-terminal.mjs drain  <SERIAL>                 collect and confirm every queued command
//   node scripts/sim-terminal.mjs fail   <SERIAL> [code]          collect one command and reject it (default -1001)
//   node scripts/sim-terminal.mjs in     <SERIAL> <PERSON-ID>     a face match going in  (punch state 0)
//   node scripts/sim-terminal.mjs out    <SERIAL> <PERSON-ID>     a face match going out (punch state 1)
//
// Options: --url http://localhost:48102 (default)   --offset 330 (terminal's UTC offset in minutes)

const [mode, serial, arg] = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && !all[i - 1]?.startsWith("--"));
const opt = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const base = opt("url", "http://localhost:48102");
const offset = Number(opt("offset", "330"));
if (!mode || !serial) {
  console.error("usage: sim-terminal.mjs hello|drain|fail|in|out <SERIAL> [PERSON-ID|code] [--url ...] [--offset 330]");
  process.exit(1);
}

const call = async (method, path, body) => {
  const res = await fetch(`${base}/iclock/${path}`, { method, body });
  return (await res.text()).trim();
};
const poll = async () => {
  const text = await call("GET", `getrequest.aspx?SN=${serial}`);
  const m = /^C:(\d+):([\s\S]*)$/.exec(text);
  return m ? { id: m[1], text: m[2] } : null;
};
const ack = (id, code = 0) => call("POST", `devicecmd.aspx?SN=${serial}`, `ID=${id}&Return=${code}&CMD=DATA`);

if (mode === "hello") {
  await poll();
  console.log(`${serial} checked in. Register it on the Devices page if it is new.`);
} else if (mode === "drain") {
  let n = 0;
  for (let cmd = await poll(); cmd; cmd = await poll()) {
    await ack(cmd.id);
    console.log(`  confirmed #${cmd.id}: ${cmd.text.slice(0, 70)}${cmd.text.length > 70 ? "…" : ""}`);
    n += 1;
  }
  console.log(n ? `${serial}: ${n} command(s) confirmed.` : `${serial}: nothing queued.`);
} else if (mode === "fail") {
  const cmd = await poll();
  if (!cmd) console.log(`${serial}: nothing queued.`);
  else {
    await ack(cmd.id, Number(arg ?? -1001));
    console.log(`${serial}: rejected #${cmd.id} with Return=${arg ?? -1001}: ${cmd.text.slice(0, 70)}`);
  }
} else if (mode === "in" || mode === "out") {
  if (!arg) throw new Error("give the person's terminal ID, e.g. V0001");
  const local = new Date(Date.now() + offset * 60_000).toISOString().replace("T", " ").slice(0, 19);
  await call("POST", `cdata.aspx?SN=${serial}&table=ATTLOG&Stamp=9999`, `${arg}\t${local}\t${mode === "in" ? 0 : 1}\t15\t0\t0`);
  console.log(`${serial}: ${arg} punched ${mode.toUpperCase()} at ${local} (terminal time).`);
} else {
  console.error(`unknown mode: ${mode}`);
  process.exit(1);
}
