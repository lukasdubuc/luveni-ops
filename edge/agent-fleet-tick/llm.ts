// ─────────────────────────────────────────────────────────────
//  Luveni Ops — provider-agnostic LLM brain
//  One `chat()` interface with tool-calling, backed by Anthropic
//  (default) or Gemini. Agents declare tools; this layer runs the
//  request/tool-result loop. Uses fetch directly — no SDK dependency.
// ─────────────────────────────────────────────────────────────

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool input. */
  parameters: Record<string, unknown>;
}

export interface ToolCall { id: string; name: string; input: Record<string, unknown> }

export interface ChatTurn {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
}

export interface ChatResult {
  text: string;
  toolCalls: ToolCall[];
  inputTokens: number;
  outputTokens: number;
}

// Default the whole fleet to OpenRouter free models so agents never burn
// paid Claude credits. Override with LLM_PROVIDER / LLM_MODEL when needed.
const PROVIDER = process.env.LLM_PROVIDER ?? "openrouter";
const DEFAULT_MODEL: Record<string, string> = {
  openrouter: "deepseek/deepseek-chat-v3-0324:free",
  anthropic: "claude-sonnet-5",
  gemini: "gemini-2.5-flash",
};
const MODEL = process.env.LLM_MODEL ?? DEFAULT_MODEL[PROVIDER] ?? "deepseek/deepseek-chat-v3-0324:free";

export async function chat(opts: {
  system: string;
  messages: ChatTurn[];
  tools?: ToolSpec[];
  maxTokens?: number;
}): Promise<ChatResult> {
  if (PROVIDER === "openrouter") return openrouterChat(opts);
  if (PROVIDER === "gemini") return geminiChat(opts);
  return anthropicChat(opts);
}

// ── OpenRouter (OpenAI-compatible /chat/completions) ───────────
// Free-tier models (":free" suffix) cost nothing. Tool-calling uses the
// standard OpenAI `tools` / `tool_calls` schema, so the whole fleet's tool
// loop works unchanged. A comma-separated LLM_MODEL_FALLBACKS list lets one
// busy free model roll over to the next instead of failing a task.
async function openrouterChat(opts: {
  system: string; messages: ChatTurn[]; tools?: ToolSpec[]; maxTokens?: number;
}): Promise<ChatResult> {
  const apiKey = process.env.OPENROUTER_API_KEY ?? "";
  if (!apiKey) throw new Error("OPENROUTER_API_KEY not set");

  const messages: Record<string, unknown>[] = [{ role: "system", content: opts.system }];
  for (const m of opts.messages) {
    if (m.role === "tool") {
      messages.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
    } else {
      messages.push({ role: m.role, content: m.content });
    }
  }

  const tools = opts.tools?.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  const models = [MODEL, ...(process.env.LLM_MODEL_FALLBACKS ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean)];

  let lastErr = "";
  for (const model of models) {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        // Attribution headers OpenRouter recommends.
        "HTTP-Referer": "https://luveni.com",
        "X-Title": "Luveni Ops Fleet",
      },
      body: JSON.stringify({
        model,
        max_tokens: opts.maxTokens ?? 1024,
        messages,
        ...(tools?.length ? { tools, tool_choice: "auto" } : {}),
      }),
    });
    if (!res.ok) {
      lastErr = `OpenRouter ${res.status} (${model}): ${await res.text().catch(() => "")}`;
      // 429 = free-model rate limit → try the next fallback model.
      if (res.status === 429 && model !== models[models.length - 1]) continue;
      throw new Error(lastErr);
    }
    const data: any = await res.json();
    const msg = data.choices?.[0]?.message ?? {};
    const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((tc: any) => ({
      id: tc.id,
      name: tc.function?.name,
      input: safeJson(tc.function?.arguments),
    }));
    return {
      text: typeof msg.content === "string" ? msg.content : "",
      toolCalls,
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
    };
  }
  throw new Error(lastErr || "OpenRouter: no models available");
}

function safeJson(s: unknown): Record<string, unknown> {
  if (typeof s !== "string") return (s as Record<string, unknown>) ?? {};
  try { return JSON.parse(s); } catch { return {}; }
}

// ── Anthropic Messages API ─────────────────────────────────────
async function anthropicChat(opts: {
  system: string; messages: ChatTurn[]; tools?: ToolSpec[]; maxTokens?: number;
}): Promise<ChatResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const messages = opts.messages.map((m) => {
    if (m.role === "tool") {
      return { role: "user", content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content }] };
    }
    return { role: m.role, content: m.content };
  });

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: opts.maxTokens ?? 1024,
      system: opts.system,
      messages,
      tools: opts.tools?.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text().catch(() => "")}`);
  const data: any = await res.json();

  let text = "";
  const toolCalls: ToolCall[] = [];
  for (const block of data.content ?? []) {
    if (block.type === "text") text += block.text;
    else if (block.type === "tool_use") toolCalls.push({ id: block.id, name: block.name, input: block.input ?? {} });
  }
  return {
    text, toolCalls,
    inputTokens: data.usage?.input_tokens ?? 0,
    outputTokens: data.usage?.output_tokens ?? 0,
  };
}

// ── Gemini generateContent (free tier) ─────────────────────────
async function geminiChat(opts: {
  system: string; messages: ChatTurn[]; tools?: ToolSpec[]; maxTokens?: number;
}): Promise<ChatResult> {
  const apiKey = process.env.GEMINI_API_KEY ?? "";
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");
  const model = MODEL.startsWith("gemini") ? MODEL : "gemini-2.5-flash";

  const contents = opts.messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  const body: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: opts.system }] },
    contents,
    generationConfig: { maxOutputTokens: opts.maxTokens ?? 1024 },
  };
  if (opts.tools?.length) {
    body.tools = [{ functionDeclarations: opts.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }];
  }
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text().catch(() => "")}`);
  const data: any = await res.json();
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  let text = "";
  const toolCalls: ToolCall[] = [];
  for (const p of parts) {
    if (p.text) text += p.text;
    if (p.functionCall) toolCalls.push({ id: p.functionCall.name, name: p.functionCall.name, input: p.functionCall.args ?? {} });
  }
  return {
    text, toolCalls,
    inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
  };
}
