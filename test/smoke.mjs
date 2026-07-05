// Smoke test: load the extension via jiti (as pi does) with a mocked ExtensionAPI
// and verify the gating behavior end to end. No network access: the clone dir is
// faked via PI_CODING_AGENT_DIR pointing into a temp dir.
//
// Run with: npm test
import { createJiti } from "jiti";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert";

// --- fake agent dir with a pre-seeded "clone" --------------------------------
const fakeAgentDir = join(tmpdir(), `toogle-sp-test-${process.pid}`);
process.env.PI_CODING_AGENT_DIR = fakeAgentDir;
const cloneDir = join(fakeAgentDir, "toogle-superpowers", "superpowers");
mkdirSync(join(cloneDir, ".git"), { recursive: true });
const skillDir = join(cloneDir, "skills", "using-superpowers");
mkdirSync(skillDir, { recursive: true });
writeFileSync(
  join(skillDir, "SKILL.md"),
  "---\nname: using-superpowers\ndescription: test\n---\n\n# Using Superpowers\n\nTEST BODY\n",
);

// --- mock pi API --------------------------------------------------------------
const handlers = new Map();
const commands = new Map();
const appendedEntries = [];
let sessionEntries = [];
let reloadCount = 0;
const notifications = [];

const ctx = {
  hasUI: true,
  cwd: process.cwd(),
  ui: {
    notify: (msg, type) => notifications.push({ msg, type }),
    setStatus: () => {},
  },
  sessionManager: { getBranch: () => sessionEntries },
  waitForIdle: async () => {},
  reload: async () => {
    reloadCount += 1;
    // pi re-instantiates extensions on reload; here we simulate by replaying
    // session_start against the same instance, since the flag is reconstructed
    // from session entries either way.
    sessionEntries = appendedEntries.map((e) => ({ type: "custom", customType: e.customType, data: e.data }));
    await emit("session_start", { reason: "reload" });
  },
};

const pi = {
  on: (event, handler) => {
    if (!handlers.has(event)) handlers.set(event, []);
    handlers.get(event).push(handler);
  },
  registerCommand: (name, options) => commands.set(name, options),
  appendEntry: (customType, data) => appendedEntries.push({ customType, data }),
  exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
};

async function emit(event, payload) {
  const results = [];
  for (const handler of handlers.get(event) ?? []) {
    results.push(await handler(payload, ctx));
  }
  return results;
}

// --- load extension -------------------------------------------------------------
const jiti = createJiti(import.meta.url, { interopDefault: true });
const factory = await jiti.import("../extensions/toogle-superpowers.ts", { default: true });
factory(pi);

// 1. command registered
assert.ok(commands.has("superpowers"), "command /superpowers registered");

// 2. fresh session -> flag false -> no skills discovered, no bootstrap injected
await emit("session_start", { reason: "startup" });
let discover = await emit("resources_discover", { cwd: ctx.cwd, reason: "startup" });
assert.deepStrictEqual(discover, [undefined], "no skillPaths before activation");

let contextResult = await emit("context", { messages: [{ role: "user", content: "hi" }] });
assert.deepStrictEqual(contextResult, [undefined], "no bootstrap before activation");

// 3. run /superpowers
await commands.get("superpowers").handler("", ctx);
assert.strictEqual(reloadCount, 1, "reload triggered after activation");
assert.strictEqual(appendedEntries.length, 1, "state persisted to session");
assert.strictEqual(appendedEntries[0].data.enabled, true);

// 4. after activation -> skills discovered + bootstrap injected
discover = await emit("resources_discover", { cwd: ctx.cwd, reason: "reload" });
assert.ok(discover[0]?.skillPaths?.[0]?.endsWith("skills"), "skillPaths after activation");

contextResult = await emit("context", { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });
const injected = contextResult[0]?.messages?.[0]?.content?.[0]?.text ?? "";
assert.ok(injected.includes("superpowers:using-superpowers bootstrap for pi"), "bootstrap marker injected");
assert.ok(injected.includes("TEST BODY"), "skill body injected");
assert.ok(injected.includes("Pi tool mapping"), "tool mapping injected");

// 5. inject only once per agent run (agent_end clears until next session_start/compact)
await emit("agent_end", { messages: [] });
contextResult = await emit("context", { messages: [{ role: "user", content: "again" }] });
assert.deepStrictEqual(contextResult, [undefined], "no re-injection after agent_end");

// 5b. compaction re-enables injection (dedupe check needs message without marker)
await emit("session_compact", {});
contextResult = await emit("context", { messages: [{ role: "user", content: "fresh" }] });
assert.ok(contextResult[0]?.messages?.length === 2, "re-injection after compaction");

// 6. second /superpowers -> friendly notice, no state duplication
await commands.get("superpowers").handler("", ctx);
assert.strictEqual(appendedEntries.length, 1, "no duplicate entry");
assert.ok(notifications.some((n) => n.msg.includes("already enabled")), "already-enabled notice");

// 7. /resume with persisted entry -> enabled again
sessionEntries = [{ type: "custom", customType: "toogle-superpowers", data: { enabled: true } }];
await emit("session_start", { reason: "resume" });
discover = await emit("resources_discover", { cwd: ctx.cwd, reason: "startup" });
assert.ok(discover[0]?.skillPaths, "resume restores enabled state");

// 8. /new -> empty session -> flag resets to false
sessionEntries = [];
await emit("session_start", { reason: "new" });
discover = await emit("resources_discover", { cwd: ctx.cwd, reason: "startup" });
assert.deepStrictEqual(discover, [undefined], "new session resets to disabled");
contextResult = await emit("context", { messages: [{ role: "user", content: "hi" }] });
assert.deepStrictEqual(contextResult, [undefined], "no bootstrap after /new");

rmSync(fakeAgentDir, { recursive: true, force: true });
console.log("ALL SMOKE TESTS PASSED");
