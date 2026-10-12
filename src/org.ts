// Org structure from hr.employees (pseudonymised Ascend import): the org-chart tree for the Graph tab
// and lookups for the agent's org_lookup tool. Only structural fields are exposed (names, titles,
// teams, departments, managers); performance data stays in the HR-only analyst path.
import * as ch from "./clickhouse.ts";

export interface OrgPerson {
  id: string;
  name: string;
  title: string;
  department: string;
  team: string;
  managerId: string;
  directReports: number;
  status: string;
}

let cache: { at: number; people: OrgPerson[]; byId: Map<string, OrgPerson> } | null = null;

async function load(): Promise<typeof cache> {
  if (cache && Date.now() - cache.at < 5 * 60_000) return cache;
  try {
    const r = await ch.query(
      `SELECT employee_id, name, title, department, team, manager_id, direct_reports, status FROM hr.employees WHERE status = 'ACTIVE' ORDER BY name`,
      { maxRows: 50_000 },
    );
    const people = r.rows.map((x) => ({
      id: String(x.employee_id),
      name: String(x.name),
      title: String(x.title),
      department: String(x.department),
      team: String(x.team),
      managerId: String(x.manager_id),
      directReports: Number(x.direct_reports),
      status: String(x.status),
    }));
    cache = { at: Date.now(), people, byId: new Map(people.map((p) => [p.id, p])) };
  } catch {
    cache = null; // hr database not imported yet
  }
  return cache;
}

export async function orgAvailable(): Promise<boolean> {
  return !!(await load())?.people.length;
}

/** Flat list for the org-chart view (the client builds the tree from managerId). */
export async function orgChart() {
  const c = await load();
  if (!c) return { available: false, people: [] as OrgPerson[], roots: [] as string[] };
  // Roots: people whose manager is missing or inactive.
  const roots = c.people.filter((p) => !p.managerId || !c.byId.has(p.managerId)).map((p) => p.id);
  return { available: true, people: c.people, roots };
}

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();

/** Resolve a person, team or department and describe its place in the org. */
export async function lookup(query: string): Promise<string> {
  const c = await load();
  if (!c) return "Org data is not available (the HR import hasn't been run).";
  const q = norm(query);
  const fmt = (p: OrgPerson) => `${p.name} (${p.title || "no title"}${p.team ? `, ${p.team}` : ""}${p.department ? `, ${p.department}` : ""})`;

  const person = c.people.find((p) => norm(p.name) === q || p.id === query) ?? c.people.find((p) => norm(p.name).includes(q));
  if (person) {
    const chain: OrgPerson[] = [];
    for (let m = c.byId.get(person.managerId); m && chain.length < 12 && !chain.includes(m); m = c.byId.get(m.managerId)) chain.push(m);
    const reports = c.people.filter((p) => p.managerId === person.id);
    const peers = person.managerId ? c.people.filter((p) => p.managerId === person.managerId && p.id !== person.id) : [];
    return [
      `Person: ${fmt(person)} [${person.id}]`,
      `Reports to: ${chain.length ? chain.map((m) => m.name).join(" → ") : "nobody (top of the org)"}`,
      `Direct reports (${reports.length}): ${reports.slice(0, 25).map(fmt).join("; ") || "none"}${reports.length > 25 ? " …" : ""}`,
      `Peers under the same manager: ${peers.length}`,
    ].join("\n");
  }

  for (const kind of ["team", "department"] as const) {
    const members = c.people.filter((p) => norm(p[kind]) === q || (q.length > 3 && norm(p[kind]).includes(q)));
    if (!members.length) continue;
    const label = members[0][kind];
    const ids = new Set(members.map((m) => m.id));
    const leaders = members.filter((m) => !ids.has(m.managerId));
    const managers = members.filter((m) => m.directReports > 0);
    return [
      `${kind === "team" ? "Team" : "Department"}: ${label} — ${members.length} active people`,
      `Top of this ${kind}: ${leaders.slice(0, 5).map(fmt).join("; ")}${leaders.length > 5 ? " …" : ""}`,
      `People managers: ${managers.length}`,
      ...(kind === "department" ? [`Teams: ${[...new Set(members.map((m) => m.team).filter(Boolean))].slice(0, 20).join(", ")}`] : []),
    ].join("\n");
  }
  const sample = c.people.slice(0, 5).map((p) => p.name).join(", ");
  return `No person, team or department matching "${query}". Names are pseudonyms (e.g. ${sample}).`;
}
