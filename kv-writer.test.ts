import assert from "node:assert/strict";
import { test } from "node:test";
import { createKvWriter } from "./kv-writer.js";

function memoryKv() {
  const values = new Map<string, unknown>();
  const calls: string[] = [];
  let fail = false;
  const kv = {
    set: async (key: string, value: unknown) => { calls.push(`set ${key}`); if (fail) throw new Error("kv offline"); values.set(key, structuredClone(value)); },
    delete: async (key: string) => { calls.push(`delete ${key}`); values.delete(key); },
  };
  return { values, calls, kv, failNext: (value: boolean) => { fail = value; } };
}

test("an unchanged value is not written again; a changed one is", async () => {
  const { values, calls, kv } = memoryKv();
  const writer = createKvWriter(kv);
  assert.equal(await writer.set("a", { n: 1 }), true);
  assert.equal(await writer.set("a", { n: 1 }), false);
  assert.equal(await writer.set("a", { n: 2 }), true);
  assert.deepEqual(calls, ["set a", "set a"]);
  assert.deepEqual(values.get("a"), { n: 2 });
});

test("a remembered read skips the identical write; an absent key skips the delete", async () => {
  const { calls, kv } = memoryKv();
  const writer = createKvWriter(kv);
  writer.remember("counts", { thr: 2 });
  writer.remember("off", undefined);
  assert.equal(await writer.set("counts", { thr: 2 }), false);
  assert.equal(await writer.delete("off"), false);
  assert.equal(await writer.set("off", true), true);
  assert.equal(await writer.delete("off"), true);
  assert.equal(await writer.delete("off"), false);
  assert.deepEqual(calls, ["set off", "delete off"]);
});

test("a failed write leaves the key unknown, so the same value is retried", async () => {
  const { values, calls, kv, failNext } = memoryKv();
  const writer = createKvWriter(kv);
  failNext(true);
  await assert.rejects(writer.set("a", 1), /kv offline/);
  failNext(false);
  assert.equal(await writer.set("a", 1), true);
  assert.equal(values.get("a"), 1);
  assert.deepEqual(calls, ["set a", "set a"]);
});
