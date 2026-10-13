// Meetings connector: transcript parsing/chunking and offline action-item extraction. No API key or database needed.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import * as kb from "../src/kb.ts";
import { chunkDocument, isTranscript, vttToTranscript, type Doc } from "../src/ingest.ts";
import { extractChecklist, parseDue, chunkFor, type MeetingItem } from "../src/meetings.ts";

before(async () => {
  await kb.reload();
});

test("WebVTT becomes speaker-timestamped transcript lines", () => {
  const vtt = `WEBVTT

1
00:00:01.000 --> 00:00:04.000
<v Dana Ruiz>Let's start with the roadmap.</v>

2
00:00:04.500 --> 00:00:06.000
<v Dana Ruiz>Then pricing.</v>

3
00:01:10.000 --> 00:01:15.000
Tom Becker: I'll send the deprecation email by Friday.`;
  const t = vttToTranscript(vtt);
  assert.equal(t, "[00:00:01] Dana Ruiz: Let's start with the roadmap. Then pricing.\n[00:01:10] Tom Becker: I'll send the deprecation email by Friday.");
  assert.ok(isTranscript(t + "\n[00:02:00] Dana Ruiz: ok\n[00:02:05] Tom Becker: ok"));
});

test("transcripts are chunked into time windows", () => {
  const lines = Array.from({ length: 40 }, (_, i) => `[00:${String(i).padStart(2, "0")}:00] Speaker ${i % 3}: ${"word ".repeat(12)}`);
  const doc: Doc = { id: "meetings/x", title: "X", sourceType: "meetings", file: "meetings/x.md", access: ["all"], text: `## Transcript\n\n${lines.join("\n")}` };
  const chunks = chunkDocument(doc);
  assert.ok(chunks.length > 1);
  assert.match(chunks[0].heading, /^Transcript 00:00:00–00:\d\d:00$/);
  assert.ok(chunks.every((c) => /Transcript \d{2}:\d{2}:\d{2}–\d{2}:\d{2}:\d{2}/.test(c.heading)));
});

test("checklist extraction reads owner, due date and status", () => {
  const items = extractChecklist("- [ ] Aisha: Android 15 crash fix in release 4.3 (due Oct 20)\n- [x] Tom: Draft email (due Oct 1)\n- not an item", "2026-09-08");
  assert.equal(items.length, 2);
  assert.deepEqual([items[0].owner, items[0].text, items[0].due_date, items[0].status], ["Aisha", "Android 15 crash fix in release 4.3", "2026-10-20", "open"]);
  assert.equal(items[1].status, "done");
  assert.equal(parseDue("Jan 10", "2026-12-15"), "2027-01-10");
});

test("an item from a transcript cites the time window it was said in", () => {
  const doc = kb.allDocs().find((d) => d.id === "meetings/2026-10-09-platform-weekly");
  assert.ok(doc, "sample transcript is indexed");
  const item = { meeting_id: doc!.id, timestamp: "00:02:50", quote: "", text: "Write the Query Engine outage runbook" } as MeetingItem;
  const chunk = chunkFor(item);
  assert.ok(chunk && chunk.text.includes("[00:02:50] Marcus Webb"), `got ${chunk?.heading}`);
});
