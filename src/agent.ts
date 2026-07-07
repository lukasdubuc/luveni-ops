// ─────────────────────────────────────────────────────────────
//  Luveni Ops — agent execution loop
//  Runs one task for one agent: builds the prompt, lets the LLM call its
//  granted tools in a bounded loop, logs the run, and writes the result
//  back to the bus.
// ─────────────────────────────────────────────────────────────

import { chat, type ChatTurn } from "./llm.js";
import { TOOLS, toolsFor } from "./tools.js";
import { setTaskStatus, logRun, type AgentTask } from "./bus.js";
import type { AgentProfile } from "./agents.js";

const MAX_TOOL_ITERATIONS = 8;

export async function runAgentTask(agent: AgentProfile, task: AgentTask): Promise<void> {
  const started = Date.now();
  await setTaskStatus(task.id, "running");

  const messages: ChatTurn[] = [{
    role: "user",
    content: `Task kind: ${task.kind}\nInput: ${JSON.stringify(task.input)}\n\nComplete this task using your tools, then summarize the outcome.`,
  }];
  const toolSpecs = toolsFor(agent.tools);
  const toolCallLog: unknown[] = [];
  let inTok = 0, outTok = 0;
  let finalText = "";

  try {
    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const res = await chat({ system: agent.systemPrompt, messages, tools: toolSpecs });
      inTok += res.inputTokens; outTok += res.outputTokens;
      finalText = res.text || finalText;

      if (res.toolCalls.length === 0) break;

      // Echo the assistant turn WITH its tool_use blocks (providers reject a
      // tool result whose originating call isn't in the transcript), then run
      // each tool and feed results back.
      messages.push({ role: "assistant", content: res.text, toolCalls: res.toolCalls });
      for (const call of res.toolCalls) {
        const tool = TOOLS[call.name];
        let result: unknown;
        if (!tool || !agent.tools.includes(call.name)) {
          result = { error: `tool "${call.name}" not available to ${agent.id}` };
        } else {
          try { result = await tool.run(call.input, { agentId: agent.id, taskId: task.id }); }
          catch (e: any) { result = { error: e.message }; }
        }
        toolCallLog.push({ name: call.name, input: call.input, result });
        messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify(result) });
      }
    }

    await setTaskStatus(task.id, "done", { result: { summary: finalText, tools: toolCallLog } });
    await logRun({
      agent: agent.id, taskId: task.id, status: "done", summary: finalText.slice(0, 500),
      toolCalls: toolCallLog, inputTokens: inTok, outputTokens: outTok, durationMs: Date.now() - started,
    });
  } catch (e: any) {
    await setTaskStatus(task.id, "error", { error: e.message });
    await logRun({ agent: agent.id, taskId: task.id, status: "error", summary: e.message, durationMs: Date.now() - started });
  }
}
