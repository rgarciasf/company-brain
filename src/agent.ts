// Generic tool-use agent loop shared by the main Brain agent and its sub-agents.
// Streams each model turn, runs requested tools, and records every generation and tool call as spans.
import Anthropic from "@anthropic-ai/sdk";
import type { Span, Trace } from "./trace.ts";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type ToolOutput = { content: string; isError?: boolean };
export type Message = Anthropic.Beta.Messages.BetaMessageParam;

export interface AgentSpec {
  name: string;
  model: string;
  effort: Effort;
  system: string;
  tools: Anthropic.Beta.Messages.BetaTool[];
  runTool: (name: string, input: Record<string, unknown>, span: Span) => Promise<ToolOutput>;
  maxTurns?: number;
}

export interface RunOptions {
  trace: Trace;
  parentSpanId?: string;
  signal?: AbortSignal;
  onText?: (delta: string) => void;
}

let client: Anthropic | null = null;
export function getClient(): Anthropic {
  // Keys that aren't scoped to a workspace must name one on every request.
  const workspace = process.env.ANTHROPIC_WORKSPACE_ID;
  return (client ??= new Anthropic(workspace ? { defaultHeaders: { "anthropic-workspace-id": workspace } } : {}));
}

export function aiEnabled(): boolean {
  return !process.env.BRAIN_OFFLINE && !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

/** Builds a tool definition; every tool streams its input eagerly and is validated by the caller. */
export function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]): Anthropic.Beta.Messages.BetaTool {
  return { name, description, input_schema: { type: "object", properties, required }, eager_input_streaming: true };
}

export async function runAgent(spec: AgentSpec, messages: Message[], opts: RunOptions): Promise<{ text: string; stopReason: string }> {
  const { trace } = opts;
  const firstUser = messages.findLast((m) => m.role === "user");
  const agentSpan = trace.start(spec.name, "agent", opts.parentSpanId ?? "", typeof firstUser?.content === "string" ? firstUser.content : firstUser?.content, spec.model);
  let finalText = "";
  let stopReason = "";

  try {
    for (let turn = 0; turn < (spec.maxTurns ?? 10); turn++) {
      const gen = trace.start(`${spec.name} · turn ${turn + 1}`, "generation", agentSpan.span_id, "", spec.model);
      const t0 = Date.now();
      let ttft = 0;
      const stream = getClient().beta.messages.stream(
        {
          model: spec.model,
          max_tokens: 16000,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          output_config: { effort: spec.effort },
          cache_control: { type: "ephemeral" },
          system: spec.system,
          tools: spec.tools,
          messages,
        },
        { signal: opts.signal },
      );
      stream.on("streamEvent", (event) => {
        if (!ttft && event.type === "content_block_delta") ttft = Date.now() - t0;
      });
      if (opts.onText) stream.on("text", (delta) => opts.onText!(delta));

      let msg: Anthropic.Beta.Messages.BetaMessage;
      try {
        msg = await stream.finalMessage();
      } catch (err) {
        trace.end(gen, { status: "error", output: (err as Error).message });
        throw err;
      }
      const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      const calls = msg.content.filter((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === "tool_use");
      trace.end(gen, {
        output: text || calls.map((c) => `→ ${c.name}(${JSON.stringify(c.input)})`).join("\n"),
        input_tokens: msg.usage.input_tokens,
        output_tokens: msg.usage.output_tokens,
        cache_read_tokens: msg.usage.cache_read_input_tokens ?? 0,
        cache_write_tokens: msg.usage.cache_creation_input_tokens ?? 0,
        ttft_ms: ttft,
      });
      stopReason = msg.stop_reason ?? "";
      finalText += text;

      if (msg.stop_reason === "refusal") {
        const note = "\n\n_I can't help with that request._";
        opts.onText?.(note);
        finalText += note;
        break;
      }
      if (msg.stop_reason === "max_tokens") {
        const note = "\n\n_(Answer truncated.)_";
        opts.onText?.(note);
        finalText += note;
        break;
      }
      if (msg.stop_reason !== "tool_use" || !calls.length) break;

      messages.push({ role: "assistant", content: msg.content });
      const results: Anthropic.Beta.Messages.BetaToolResultBlockParam[] = [];
      for (const call of calls) {
        const span = trace.start(call.name, "tool", agentSpan.span_id, call.input);
        let out: ToolOutput;
        try {
          const input = call.input && typeof call.input === "object" ? (call.input as Record<string, unknown>) : {};
          out = await spec.runTool(call.name, input, span);
        } catch (err) {
          if (opts.signal?.aborted) throw err;
          out = { content: `Error: ${(err as Error).message}`, isError: true };
        }
        trace.end(span, { output: out.content, status: out.isError ? "error" : "ok" });
        results.push({ type: "tool_result", tool_use_id: call.id, content: out.content, is_error: out.isError });
      }
      messages.push({ role: "user", content: results });
      if (turn === (spec.maxTurns ?? 10) - 1) {
        // Out of tool turns: ask for a final answer from what was gathered instead of ending silently.
        const gen2 = trace.start(`${spec.name} · final answer`, "generation", agentSpan.span_id, "", spec.model);
        messages.push({ role: "user", content: "You've used all available tool calls. Answer now with what you have, and say clearly what you couldn't determine." });
        const stream = getClient().beta.messages.stream(
          { model: spec.model, max_tokens: 16000, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default", output_config: { effort: spec.effort }, system: spec.system, tools: spec.tools, tool_choice: { type: "none" }, messages },
          { signal: opts.signal },
        );
        if (opts.onText) stream.on("text", (delta) => opts.onText!(delta));
        const last = await stream.finalMessage();
        const text = last.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
        trace.end(gen2, { output: text, input_tokens: last.usage.input_tokens, output_tokens: last.usage.output_tokens, cache_read_tokens: last.usage.cache_read_input_tokens ?? 0, cache_write_tokens: last.usage.cache_creation_input_tokens ?? 0 });
        finalText += text;
        stopReason = last.stop_reason ?? "";
      }
    }
    trace.end(agentSpan, { output: finalText });
    return { text: finalText, stopReason };
  } catch (err) {
    trace.end(agentSpan, { status: "error", output: (err as Error).message });
    throw err;
  }
}
