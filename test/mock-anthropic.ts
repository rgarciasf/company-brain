// Test-only mock of the Anthropic Messages API (streaming). It replays a scripted conversation so
// the whole pipeline (agent loops, sub-agent, ClickHouse tools, approvals, tracing, charts, reports)
// can be exercised end to end without an API key. Not used by the app at runtime.
// Run: node test/mock-anthropic.ts   then start the app with
//      ANTHROPIC_BASE_URL=http://127.0.0.1:4010 ANTHROPIC_API_KEY=test npm start
import http from "node:http";

type Block = { type: "text"; text: string } | { type: "tool_use"; name: string; input: Record<string, unknown> };
let seq = 0;

function toolResults(messages: any[]): string[] {
  return messages.flatMap((m) => (m.role === "user" && Array.isArray(m.content) ? m.content.filter((c: any) => c.type === "tool_result").map((c: any) => String(c.content)) : []));
}

function mainScript(results: string[]): Block[] {
  if (results.length === 0) return [{ type: "tool_use", name: "search_knowledge", input: { query: "android 15 crash release 4.2 fix" } }];
  if (results.length === 1)
    return [{ type: "tool_use", name: "analyze_data", input: { question: "Daily mobile crash rate by OS version since 2026-09-01, focusing on Android 15 and app 4.2" } }];
  const chunk = results[0].match(/\[(c\d+)\]/)?.[1] ?? "c1";
  const q = results[1].match(/\b(q\d+)\b/)?.[1] ?? "q1";
  return [
    {
      type: "text",
      text: `**Android 15 users on app 4.2 crash about 4× more often than everyone else** — roughly 1.8% vs ~0.4% [${q}].\n\n- The spike starts with release 4.2 on Sep 29 [${q}].\n- A fix is planned for release 4.3 on Oct 27; workaround: use the web app or split dashboards with more than 12 tiles [${chunk}].`,
    },
  ];
}

function analystScript(results: string[]): Block[] {
  switch (results.length) {
    case 0:
      return [{ type: "tool_use", name: "list_tables", input: {} }];
    case 1:
      return [{ type: "tool_use", name: "get_distinct_values", input: { table: "events", column: "os_version", where: "platform != 'web'" } }];
    case 2:
      return [
        {
          type: "tool_use",
          name: "run_query",
          input: {
            purpose: "Daily crash rate by mobile OS version since Sep 1",
            sql: "SELECT toDate(event_time) AS day, os_version, round(100 * countIf(event_name = 'app_crash') / count(), 2) AS crash_rate_pct FROM pulse.events WHERE platform IN ('ios','android') AND event_time >= '2026-09-01' GROUP BY day, os_version ORDER BY day, os_version",
          },
        },
      ];
    case 3:
      return [{ type: "tool_use", name: "run_query", input: { purpose: "Total event volume across all time (full scan)", sql: "SELECT count() AS events, uniq(user_id) AS users FROM pulse.events" } }];
    case 4:
      return [{ type: "tool_use", name: "create_chart", input: { query_id: "q1", type: "line", title: "Daily mobile crash rate by OS version", x: "day", y: ["crash_rate_pct"], series: "os_version", unit: "%" } }];
    default:
      return [{ type: "text", text: "- Android 15 crash rate jumps to ~1.8% after 2026-09-29 while other OS versions stay ~0.4% [q1]\nCaveats: crash rate = app_crash / all mobile events." }];
  }
}

function sse(res: http.ServerResponse, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

const server = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  if (!req.url?.startsWith("/v1/messages")) {
    res.writeHead(404);
    return res.end();
  }
  const reqJson = JSON.parse(body);
  const isAnalyst = String(reqJson.system).includes("data analyst sub-agent");
  const blocks = (isAnalyst ? analystScript : mainScript)(toolResults(reqJson.messages));
  const hasTool = blocks.some((b) => b.type === "tool_use");

  res.writeHead(200, { "Content-Type": "text/event-stream", "request-id": `req_mock_${++seq}` });
  sse(res, "message_start", {
    type: "message_start",
    message: { id: `msg_mock_${seq}`, type: "message", role: "assistant", model: reqJson.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1200, output_tokens: 1, cache_read_input_tokens: 3000, cache_creation_input_tokens: 0 } },
  });
  blocks.forEach((b, index) => {
    if (b.type === "text") {
      sse(res, "content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
      for (const piece of b.text.match(/[\s\S]{1,24}/g) ?? []) sse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: piece } });
    } else {
      sse(res, "content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: `toolu_mock_${seq}_${index}`, name: b.name, input: {} } });
      sse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
    }
    sse(res, "content_block_stop", { type: "content_block_stop", index });
  });
  sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: hasTool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 180 } });
  sse(res, "message_stop", { type: "message_stop" });
  res.end();
});

server.listen(4010, "127.0.0.1", () => console.log("Mock Anthropic API on http://127.0.0.1:4010"));
