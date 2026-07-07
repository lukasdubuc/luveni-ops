// ─────────────────────────────────────────────────────────────
//  Luveni Ops — fleet roster smoke check (no API keys needed)
//  Prints every agent with its task kinds and tool grants, and fails
//  loudly when the definitions drift: a task kind claimed by two agents,
//  a tool grant that doesn't exist, or an Astra prompt missing the roster.
// ─────────────────────────────────────────────────────────────

import { AGENTS, AGENT_BY_ID, fleetRoster } from "./agents.js";
import { TOOLS } from "./tools.js";

let failed = false;
const fail = (msg: string) => { failed = true; console.error(`✗ ${msg}`); };

console.log("Luveni Ops fleet roster\n───────────────────────");
const kindOwner = new Map<string, string>();
for (const a of AGENTS) {
  console.log(`\n${a.name} (${a.id}) — ${a.role}`);
  console.log(`  handles: ${a.handles.join(", ") || "(none)"}`);
  console.log(`  tools:   ${a.tools.join(", ") || "(none)"}`);
  for (const kind of a.handles) {
    const owner = kindOwner.get(kind);
    if (owner) fail(`task kind "${kind}" claimed by both ${owner} and ${a.id}`);
    else kindOwner.set(kind, a.id);
  }
  for (const t of a.tools) {
    if (!TOOLS[t]) fail(`${a.id} is granted unknown tool "${t}"`);
  }
}

const astra = AGENT_BY_ID["astra"];
if (!astra) fail("no astra profile");
else {
  if (!astra.systemPrompt.includes("YOUR FLEET")) fail("Astra's prompt is missing the fleet roster");
  for (const a of AGENTS) {
    if (a.id !== "astra" && !astra.systemPrompt.includes(a.name)) {
      fail(`Astra's prompt doesn't mention ${a.name}`);
    }
  }
}

console.log(`\n${AGENTS.length} agents, ${kindOwner.size} task kinds.`);
console.log(failed ? "\nROSTER CHECK FAILED" : "\nRoster check passed — Astra knows her fleet.");
if (failed) process.exit(1);

// Reference the generated roster so tree-shaking never drops it silently.
void fleetRoster;
