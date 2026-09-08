import test from "node:test";
import assert from "node:assert/strict";
import { acquireNativeSurfaceOcclusion, nativeSurfaceOcclusion } from "./nativeSurfaceOcclusion.ts";
test("nested app layers keep native surfaces hidden until the last layer closes", () => {
  const states = [];
  const unsubscribe = nativeSurfaceOcclusion.subscribe(() => states.push(nativeSurfaceOcclusion.blocked));
  const dialog = acquireNativeSurfaceOcclusion();
  const select = acquireNativeSurfaceOcclusion();
  dialog(); dialog();
  assert.equal(nativeSurfaceOcclusion.blocked, true);
  select();
  assert.equal(nativeSurfaceOcclusion.blocked, false);
  assert.deepEqual(states, [true, true, true, false]);
  unsubscribe();
});
