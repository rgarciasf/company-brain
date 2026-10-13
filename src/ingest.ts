// Source connectors: turn files under data/sources/<sourceType>/ (and uploaded sources) into documents and chunks.
// - .md / .markdown / .txt  -> one document, chunked by heading
// - .json (array)           -> one document per item (support tickets, tool registries, ...)
// - .json (object)          -> one document (rotations, configs, ...)
// - .vtt                    -> one meeting transcript (WebVTT from Zoom/Teams/Meet)
// Transcripts ("[00:12:30] Name: text" lines) are chunked by time window, so a citation points
// to a moment in the meeting.
import fs from "node:fs";
import path from "node:path";

export interface Doc {
  id: string;
  title: string;
  sourceType: string;
  file: string;
  owner?: string;
  updated?: string;
  status?: string;
  access: string[]; // groups allowed to read; "all" = everyone
  text: string;
}

export interface Chunk {
  id: string; // citation id, e.g. "c12"
  docId: string;
  ord: number; // position within its document (stable across re-indexing)
  title: string;
  heading: string;
  sourceType: string;
  updated?: string;
  status?: string;
  owner?: string;
  access: string[];
  text: string;
}

const MAX_CHUNK_CHARS = 1200;

/** One transcript line: "[hh:mm:ss] Speaker: text" (hours optional). */
export const TRANSCRIPT_LINE = /^\[((?:\d{1,2}:)?\d{1,2}:\d{2})\]\s*([^:\]]{1,60}):\s*(.*)$/;

/** Normalise "m:ss" / "mm:ss" / "h:mm:ss" to "hh:mm:ss". */
export function normTime(t: string): string {
  const parts = t.split(":").map(Number);
  while (parts.length < 3) parts.unshift(0);
  return parts.map((n) => String(n).padStart(2, "0")).join(":");
}

/** Convert WebVTT captions to transcript lines, merging consecutive cues from the same speaker. */
export function vttToTranscript(vtt: string): string {
  const lines: { t: string; who: string; text: string }[] = [];
  for (const block of vtt.replace(/\r/g, "").split(/\n\s*\n/)) {
    const rows = block.split("\n").map((r) => r.trim()).filter(Boolean);
    const ti = rows.findIndex((r) => r.includes("-->"));
    if (ti < 0) continue;
    const start = rows[ti].split("-->")[0].trim().replace(/[.,]\d+$/, "");
    let text = rows.slice(ti + 1).join(" ");
    let who = "Unknown";
    const v = text.match(/^<v(?:\.[^ >]*)?\s+([^>]+)>/);
    if (v) who = v[1].trim();
    else {
      const m = text.match(/^([^:]{1,60}):\s+/);
      if (m) { who = m[1].trim(); text = text.slice(m[0].length); }
    }
    text = text.replace(/<[^>]+>/g, "").trim();
    if (!text) continue;
    const prev = lines[lines.length - 1];
    if (prev && prev.who === who && prev.text.length < 600) prev.text += " " + text;
    else lines.push({ t: normTime(start), who, text });
  }
  return lines.map((l) => `[${l.t}] ${l.who}: ${l.text}`).join("\n");
}

export function isTranscript(text: string): boolean {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  return lines.filter((l) => TRANSCRIPT_LINE.test(l.trim())).length >= Math.max(3, lines.length * 0.5);
}

export function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return { meta, body: raw.slice(m[0].length) };
}

function parseAccess(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (typeof v === "string" && v.trim()) return v.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return ["all"];
}

function humanize(s: string): string {
  return s.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Render arbitrary JSON as readable "key: value" text so it can be indexed and quoted. */
export function renderJson(value: unknown, indent = ""): string {
  if (value === null || typeof value !== "object") return `${indent}${String(value)}`;
  if (Array.isArray(value)) {
    return value
      .map((item) =>
        item && typeof item === "object"
          ? `${indent}- ${Object.entries(item).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`).join("; ")}`
          : `${indent}- ${String(item)}`,
      )
      .join("\n");
  }
  return Object.entries(value as Record<string, unknown>)
    .map(([k, v]) =>
      v && typeof v === "object" ? `${indent}${k}:\n${renderJson(v, indent + "  ")}` : `${indent}${k}: ${v}`,
    )
    .join("\n");
}

/** Parse one source file's content into documents (also used for uploads kept in the state store). */
export function parseSource(sourceType: string, file: string, raw: string): Doc[] {
  const base = `${sourceType}/${file.replace(/\.[^.]+$/, "")}`;
  const ext = path.extname(file).toLowerCase();

  if (ext === ".json") {
    const data = JSON.parse(raw) as unknown;
    const items = Array.isArray(data) ? data : [data];
    return items.map((item, i) => {
      const rec = (item && typeof item === "object" ? item : { value: item }) as Record<string, unknown>;
      const label = rec.title ?? rec.subject ?? rec.name ?? rec.id ?? humanize(file);
      const title = rec.id && rec.subject ? `${rec.id}: ${rec.subject}` : String(label);
      const { title: _t, owner, updated, created, status, access, ...rest } = rec;
      return {
        id: Array.isArray(data) ? `${base}#${i}` : base,
        title,
        sourceType,
        file: `${sourceType}/${file}`,
        owner: owner ? String(owner) : undefined,
        updated: String(updated ?? created ?? "") || undefined,
        status: status ? String(status) : undefined,
        access: parseAccess(access),
        text: renderJson(Array.isArray(data) ? rec : rest),
      };
    });
  }

  if (ext === ".vtt") {
    return [{ id: base, title: humanize(file), sourceType, file: `${sourceType}/${file}`, access: ["all"], text: vttToTranscript(raw) }];
  }

  const { meta, body } = parseFrontmatter(raw);
  const h1 = body.match(/^#\s+(.+)$/m)?.[1];
  return [
    {
      id: base,
      title: meta.title || h1 || humanize(file),
      sourceType,
      file: `${sourceType}/${file}`,
      owner: meta.owner,
      updated: meta.updated || meta.date,
      status: meta.status,
      access: parseAccess(meta.access),
      text: body.trim(),
    },
  ];
}

export function loadDocuments(root: string): Doc[] {
  if (!fs.existsSync(root)) return [];
  const docs: Doc[] = [];
  for (const sourceType of fs.readdirSync(root).sort()) {
    const dir = path.join(root, sourceType);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const file of fs.readdirSync(dir).sort()) {
      if (!/\.(md|markdown|txt|json|vtt)$/i.test(file)) continue;
      try {
        docs.push(...parseSource(sourceType, file, fs.readFileSync(path.join(root, sourceType, file), "utf8")));
      } catch (err) {
        console.warn(`[ingest] skipped ${sourceType}/${file}: ${(err as Error).message}`);
      }
    }
  }
  return docs;
}

/** Split a document into heading-aware chunks of at most ~MAX_CHUNK_CHARS. */
export function chunkDocument(doc: Doc): Omit<Chunk, "id">[] {
  const sections: { heading: string; lines: string[] }[] = [{ heading: "", lines: [] }];
  for (const line of doc.text.split(/\r?\n/)) {
    const h = line.match(/^(#{1,4})\s+(.+)$/);
    if (h && h[1].length === 1) continue; // H1 duplicates the title
    if (h) sections.push({ heading: h[2].trim(), lines: [] });
    else sections[sections.length - 1].lines.push(line);
  }

  const out: Omit<Chunk, "id">[] = [];
  const push = (heading: string, text: string) =>
    out.push({ docId: doc.id, ord: out.length, title: doc.title, heading, sourceType: doc.sourceType, updated: doc.updated, status: doc.status, owner: doc.owner, access: doc.access, text });
  for (const s of sections) {
    const body = s.lines.join("\n").trim();
    if (!body) continue;
    if (isTranscript(body)) {
      // Time windows: heading "Transcript 00:12:30–00:15:10" makes each citation a moment in the meeting.
      let buf: string[] = [];
      let size = 0;
      const time = (l: string) => normTime(l.trim().match(TRANSCRIPT_LINE)?.[1] ?? "0:00");
      const flush = () => {
        if (!buf.length) return;
        const label = `${s.heading && !/^transcript$/i.test(s.heading) ? `${s.heading} · ` : ""}Transcript ${time(buf[0])}–${time(buf[buf.length - 1])}`;
        push(label, buf.join("\n\n")); // one paragraph per line when rendered
        buf = [];
        size = 0;
      };
      for (const line of body.split(/\r?\n/).filter((l) => l.trim())) {
        if (size && size + line.length > MAX_CHUNK_CHARS && TRANSCRIPT_LINE.test(line.trim())) flush();
        buf.push(line);
        size += line.length;
      }
      flush();
      continue;
    }
    const paragraphs = body.split(/\n\s*\n/);
    let buf = "";
    const flush = () => {
      if (!buf.trim()) return;
      push(s.heading, buf.trim());
      buf = "";
    };
    for (const p of paragraphs) {
      if (buf && buf.length + p.length > MAX_CHUNK_CHARS) flush();
      buf += (buf ? "\n\n" : "") + p;
    }
    flush();
  }
  return out;
}
