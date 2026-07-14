#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readJsonlTail } from "../src/jsonl-tail.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "42space-jsonl-tail-"));
const file = path.join(dir, "feed.jsonl");
try {
  fs.writeFileSync(file, `${JSON.stringify({ id: 1 })}\n`, { mode: 0o600 });
  const initialized = readJsonlTail(file, null);
  assert(initialized.rows.length === 0, "initial tail must start at EOF");
  fs.appendFileSync(file, `${JSON.stringify({ id: 2 })}\n${JSON.stringify({ id: 3 }).slice(0, -1)}`);
  const firstRead = readJsonlTail(file, initialized.cursor);
  assert(firstRead.rows.length === 1 && firstRead.rows[0].id === 2, "complete appended line must be returned");
  fs.appendFileSync(file, "}\n");
  const secondRead = readJsonlTail(file, firstRead.cursor);
  assert(secondRead.rows.length === 1 && secondRead.rows[0].id === 3, "partial line must resume exactly once");
  fs.writeFileSync(file, `${JSON.stringify({ id: 4 })}\n`, { mode: 0o600 });
  const truncated = readJsonlTail(file, secondRead.cursor);
  assert(truncated.truncated && truncated.rows[0].id === 4, "truncated feed must restart at offset zero");
  console.log(JSON.stringify({ level: "jsonl-tail-self-test", status: "ok" }));
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
