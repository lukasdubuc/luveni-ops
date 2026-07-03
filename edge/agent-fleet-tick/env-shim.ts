// Node-compat shim so the shared fleet modules (which read process.env)
// run unchanged inside the Deno-based Supabase Edge Runtime.
// Must be the FIRST import of index.ts so it executes before bus.ts/llm.ts.
const g = globalThis as any;
if (!g.process?.env) g.process = { ...(g.process ?? {}), env: Deno.env.toObject() };
