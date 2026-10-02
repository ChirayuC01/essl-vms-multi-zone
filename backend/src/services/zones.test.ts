import assert from "node:assert/strict";
import { test } from "node:test";
import { expandZoneIds, wouldCreateCycle } from "./zones.js";

// premise
//   └─ yard
//        └─ bay      (a third level, to prove the walk is not one step deep)
// annex             (a separate root)
const zones = [
  { id: "premise", parentZoneId: null },
  { id: "yard", parentZoneId: "premise" },
  { id: "bay", parentZoneId: "yard" },
  { id: "annex", parentZoneId: null },
];

test("a zone grants its own gates only when it has no parent", () => {
  assert.deepEqual([...expandZoneIds(zones, ["premise"])], ["premise"]);
});

test("a child zone also grants every ancestor's gates", () => {
  assert.deepEqual([...expandZoneIds(zones, ["yard"])].sort(), ["premise", "yard"]);
  assert.deepEqual([...expandZoneIds(zones, ["bay"])].sort(), ["bay", "premise", "yard"]);
});

test("several zones expand to their union without duplicates", () => {
  assert.deepEqual([...expandZoneIds(zones, ["yard", "premise", "annex"])].sort(), ["annex", "premise", "yard"]);
});

test("an unknown zone is refused rather than silently ignored", () => {
  assert.throws(() => expandZoneIds(zones, ["nowhere"]), /zone not found/);
});

test("a stored cycle cannot hang the walk", () => {
  const looped = [
    { id: "a", parentZoneId: "b" },
    { id: "b", parentZoneId: "a" },
  ];
  assert.deepEqual([...expandZoneIds(looped, ["a"])].sort(), ["a", "b"]);
});

test("re-parenting that would close a loop is detected", () => {
  assert.equal(wouldCreateCycle(zones, "premise", "premise"), true);
  assert.equal(wouldCreateCycle(zones, "premise", "bay"), true);
  assert.equal(wouldCreateCycle(zones, "yard", "annex"), false);
  assert.equal(wouldCreateCycle(zones, "yard", null), false);
});
