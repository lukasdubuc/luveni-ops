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

const PROVIDER = process.env.LLM_PROVIDER ?? "anthropic";
const MODEL = process.env.LLM_MODEL ?? "claude-sonnet-5";

export async function chat(opts: {
  system: string;
  messages: ChatTurn[];
  tools?: ToolSpec[];
  maxTokens?: number;
}): Promise<ChatResult> {
  if (PROVIDER === "gemini") return geminiChat(opts);
  return anthropicChat(opts);
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
  const data = await res.json();

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
  const data = await res.json();
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
