// Import HR data from the Ascend Postgres database (Neon) into the ClickHouse `hr` database,
// pseudonymised: every person gets a stable fake name and id; real names, emails, phones,
// birthdays, credentials and all free text (feedback, review comments, written answers,
// calibration notes) are never read or written. Names that appear inside team/department names,
// job titles and goal titles are replaced with the pseudonyms.
// Run: npm run hr:import         (needs ASCEND_DATABASE_URL in .env; read-only access is enough)
import { createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import pg from "pg";

try {
  process.loadEnvFile();
} catch {}

const ch = await import("../src/clickhouse.ts");

const URL_ = process.env.ASCEND_DATABASE_URL;
if (!URL_) {
  console.error("Set ASCEND_DATABASE_URL in .env first (Neon → Ascend → Connect).");
  process.exit(1);
}

// A per-installation salt keeps pseudonyms stable across re-imports without being derivable from ids.
let SALT = process.env.ASCEND_SALT;
if (!SALT) {
  SALT = randomBytes(24).toString("base64url");
  fs.appendFileSync(".env", `\n# Keeps HR pseudonyms stable across imports (do not share)\nASCEND_SALT=${SALT}\n`);
  console.log("   generated ASCEND_SALT (saved to .env)");
}

const FIRST = ["Alex", "Bianca", "Carlos", "Dana", "Elena", "Felix", "Gabriela", "Hugo", "Ines", "Jonas", "Kira", "Leo", "Maya", "Nico", "Olivia", "Pablo", "Quinn", "Rosa", "Samir", "Tara", "Uma", "Victor", "Wendy", "Xavier", "Yara", "Zane", "Ada", "Bruno", "Clara", "Diego", "Emma", "Fabio", "Greta", "Hector", "Iris", "Javier", "Lena", "Marco", "Nora", "Oscar", "Paula", "Rafa", "Sofia", "Tomas", "Valeria", "Wyatt", "Ximena", "Yusuf", "Zoe", "Amir", "Beatriz", "Camila", "Daniel", "Elisa", "Fernando", "Gloria", "Ivan", "Julia", "Lucas", "Mateo"];
const LAST = ["Abara", "Bellini", "Castell", "Duarte", "Eklund", "Ferreira", "Galvan", "Hartley", "Ibarra", "Jansen", "Kovac", "Lindqvist", "Moreau", "Navarro", "Okoye", "Petrov", "Quintero", "Rinaldi", "Sandoval", "Takeda", "Ueda", "Valdivia", "Whitlock", "Xu", "Yilmaz", "Zamora", "Aldana", "Brandt", "Cordero", "Delacroix", "Esposito", "Fonseca", "Garrido", "Holm", "Iglesias", "Jaramillo", "Keller", "Lozano", "Mendez", "Nakamura", "Orozco", "Prieto", "Rojas", "Serrano", "Toledo", "Urrutia", "Vega", "Weiss", "Ybarra", "Zelaya"];

const hmac = (s: string) => createHmac("sha256", SALT!).update(s).digest();
const pseudoId = (realId: string) => "e" + hmac(`id:${realId}`).toString("hex").slice(0, 8);

const db = new pg.Client({ connectionString: URL_ });
await db.connect();
await db.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
const q = async <T = any>(sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as T[];

const orgs = await q<{ id: string }>(`SELECT id FROM organizations ORDER BY "createdAt"`);
const ORG = process.env.ASCEND_ORG_ID ?? (orgs.length === 1 ? orgs[0].id : "");
if (!ORG) {
  console.error(`Found ${orgs.length} organizations; set ASCEND_ORG_ID to choose one.`);
  process.exit(1);
}

console.log("Importing Ascend HR data (pseudonymised)…");

// ---------------- People ----------------
const people = await q(
  `SELECT m.id AS mid, m."userId" AS uid, u."firstName" AS first, u."lastName" AS last, u."displayName" AS display,
          m.title, m.role::text AS role, m.status::text AS status, m."employmentType"::text AS employment_type,
          m."startDate" AS start_date, m."managerId" AS manager_ref, m."departmentId" AS department_ref, m."teamId" AS team_ref
   FROM memberships m JOIN users u ON u.id = m."userId" WHERE m."organizationId" = $1`,
  [ORG],
);

// Any reference to a person (user id or membership id) resolves to the same pseudonymous employee.
const idOf = new Map<string, string>();
const nameOf = new Map<string, string>();
const used = new Set<string>();
for (const p of people) {
  const id = pseudoId(p.uid);
  idOf.set(p.uid, id);
  idOf.set(p.mid, id);
  const h = hmac(`name:${p.uid}`);
  let name = `${FIRST[h[0] % FIRST.length]} ${LAST[h[1] % LAST.length]}`;
  for (let i = 2; used.has(name); i++) name = `${FIRST[h[0] % FIRST.length]} ${String.fromCharCode(65 + (h[i % h.length] % 26))}. ${LAST[h[1] % LAST.length]}`;
  used.add(name);
  nameOf.set(id, name);
}
const ref = (r: string | null | undefined) => (r ? (idOf.get(r) ?? "") : "");

// Replace real names that appear in organisational text (team names, titles, goal titles).
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const replacements: [RegExp, string][] = [];
for (const p of people) {
  const fake = nameOf.get(idOf.get(p.uid)!)!;
  const full = [p.first, p.last].filter(Boolean).join(" ").trim();
  for (const real of [full, p.display]) if (real && real.length >= 4) replacements.push([new RegExp(`\\b${escapeRe(real)}\\b`, "gi"), fake]);
  if (p.first && p.first.length >= 3) replacements.push([new RegExp(`\\b${escapeRe(p.first)}(?='s\\b|\\b)`, "g"), fake.split(" ")[0]]);
  if (p.last && p.last.length >= 4) replacements.push([new RegExp(`\\b${escapeRe(p.last)}\\b`, "g"), fake.split(" ").at(-1)!]);
}
replacements.sort((a, b) => b[0].source.length - a[0].source.length); // full names before single names
let redactions = 0;
const redact = (s: string | null | undefined) => {
  let out = s ?? "";
  for (const [re, fake] of replacements) out = out.replace(re, () => (redactions++, fake));
  return out;
};
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const ts = (d: Date | null) => (d ? d.toISOString().replace("T", " ").slice(0, 19) : null);

// ---------------- Org structure ----------------
const depts = await q(`SELECT id, name, "parentId" AS parent, "headId" AS head FROM departments WHERE "organizationId" = $1`, [ORG]);
const teams = await q(`SELECT id, name, "departmentId" AS dept, "leadId" AS lead FROM teams WHERE "organizationId" = $1`, [ORG]);
const deptName = new Map(depts.map((d) => [d.id, redact(d.name)]));
const teamRow = new Map(teams.map((t) => [t.id, t]));

const employees = people.map((p) => {
  const id = idOf.get(p.uid)!;
  const team = p.team_ref ? teamRow.get(p.team_ref) : undefined;
  const deptRef = p.department_ref ?? team?.dept ?? null;
  return {
    employee_id: id,
    name: nameOf.get(id)!,
    title: redact(p.title),
    role: p.role ?? "",
    status: p.status ?? "",
    employment_type: p.employment_type ?? "",
    department_id: deptRef ?? "",
    department: deptRef ? (deptName.get(deptRef) ?? "") : "",
    team_id: p.team_ref ?? "",
    team: team ? redact(team.name) : "",
    manager_id: ref(p.manager_ref),
    start_date: day(p.start_date),
  };
});
const byId = new Map(employees.map((e) => [e.employee_id, e]));
const reports = new Map<string, number>();
for (const e of employees) if (e.manager_id) reports.set(e.manager_id, (reports.get(e.manager_id) ?? 0) + 1);
const depth = (id: string, seen = new Set<string>()): number => {
  const m = byId.get(id)?.manager_id;
  if (!m || seen.has(m) || !byId.has(m)) return 0;
  seen.add(id);
  return 1 + depth(m, seen);
};
const now = Date.now();
const employeeRows = employees.map((e) => ({
  ...e,
  manager_name: e.manager_id ? (byId.get(e.manager_id)?.name ?? "") : "",
  direct_reports: reports.get(e.employee_id) ?? 0,
  is_people_manager: (reports.get(e.employee_id) ?? 0) > 0 ? 1 : 0,
  org_depth: depth(e.employee_id),
  tenure_months: e.start_date ? Math.max(0, Math.floor((now - Date.parse(e.start_date)) / (30.44 * 86400_000))) : null,
}));

const headcount = (key: "department_id" | "team_id", id: string) => employeeRows.filter((e) => e[key] === id && e.status === "ACTIVE").length;
const departmentRows = depts.map((d) => ({ department_id: d.id, name: deptName.get(d.id) ?? "", parent_id: d.parent ?? "", head_id: ref(d.head), head_name: byId.get(ref(d.head))?.name ?? "", headcount: headcount("department_id", d.id) }));
const teamRows = teams.map((t) => ({ team_id: t.id, name: redact(t.name), department_id: t.dept ?? "", department: t.dept ? (deptName.get(t.dept) ?? "") : "", lead_id: ref(t.lead), lead_name: byId.get(ref(t.lead))?.name ?? "", headcount: headcount("team_id", t.id) }));

// ---------------- Performance ----------------
const cycles = await q(
  `SELECT id, name, status::text AS status, "startDate" AS s, "endDate" AS e, "includesSelfReview" AS self, "includesPeerReview" AS peer, "includesManagerReview" AS mgr
   FROM review_cycles WHERE "organizationId" = $1`,
  [ORG],
);
const cycleName = new Map(cycles.map((c) => [c.id, redact(c.name)]));
const cycleRows = cycles.map((c) => ({ cycle_id: c.id, name: cycleName.get(c.id)!, status: c.status, start_date: day(c.s), end_date: day(c.e), includes_self_review: c.self ? 1 : 0, includes_peer_review: c.peer ? 1 : 0, includes_manager_review: c.mgr ? 1 : 0 }));

const reviews = await q(
  `SELECT r.id, r."cycleId" AS cycle, r.type::text AS type, r.status::text AS status, r."authorId" AS author, r."subjectId" AS subject,
          r."overallRating" AS overall, r."calibratedRating" AS calibrated, r."submittedAt" AS submitted, r."acknowledgedAt" IS NOT NULL AS acknowledged
   FROM reviews r JOIN review_cycles c ON c.id = r."cycleId" WHERE c."organizationId" = $1`,
  [ORG],
);
const reviewInfo = new Map<string, { cycle: string; type: string; subject: string }>();
const reviewRows = reviews.map((r) => {
  const subject = ref(r.subject);
  const s = byId.get(subject);
  reviewInfo.set(r.id, { cycle: r.cycle, type: r.type, subject });
  return {
    review_id: r.id,
    cycle_id: r.cycle,
    cycle_name: cycleName.get(r.cycle) ?? "",
    review_type: r.type,
    status: r.status,
    author_id: ref(r.author),
    subject_id: subject,
    subject_department: s?.department ?? "",
    subject_team: s?.team ?? "",
    subject_manager_id: s?.manager_id ?? "",
    overall_rating: r.overall,
    calibrated_rating: r.calibrated,
    submitted_at: ts(r.submitted),
    acknowledged: r.acknowledged ? 1 : 0,
  };
});

const questions = await q(`SELECT id, text, category, weight FROM review_template_questions WHERE type::text = 'RATING_SCALE'`);
const questionRow = new Map(questions.map((x) => [x.id, x]));
const ratings = await q(
  `SELECT rr."reviewId" AS review, rr."questionId" AS question, rr."ratingValue" AS rating
   FROM review_responses rr JOIN reviews r ON r.id = rr."reviewId" JOIN review_cycles c ON c.id = r."cycleId"
   WHERE c."organizationId" = $1 AND rr."ratingValue" IS NOT NULL`,
  [ORG],
);
const ratingRows = ratings.map((x) => {
  const info = reviewInfo.get(x.review);
  const qn = questionRow.get(x.question);
  return { review_id: x.review, cycle_id: info?.cycle ?? "", review_type: info?.type ?? "", subject_id: info?.subject ?? "", question_id: x.question, question: redact(qn?.text), category: qn?.category ?? "", rating: x.rating };
});

// ---------------- Goals ----------------
const goals = await q(
  `SELECT id, "ownerId" AS owner, title, type::text AS type, status::text AS status, timeframe::text AS timeframe, progress,
          "startDate" AS s, "dueDate" AS d, "completedAt" AS c, "parentId" AS parent, "reviewCycleId" AS cycle, "isPrivate" AS private
   FROM goals WHERE "organizationId" = $1`,
  [ORG],
);
const goalRows = goals.map((g) => ({ goal_id: g.id, owner_id: ref(g.owner), title: g.private ? "(private goal)" : redact(g.title), goal_type: g.type, status: g.status, timeframe: g.timeframe, progress: g.progress ?? 0, start_date: day(g.s), due_date: day(g.d), completed_at: ts(g.c), parent_goal_id: g.parent ?? "", cycle_id: g.cycle ?? "" }));
const krs = await q(
  `SELECT k.id, k."goalId" AS goal, k."ownerId" AS owner, k.title, k.type::text AS type, k."startValue" AS sv, k."targetValue" AS tv, k."currentValue" AS cv,
          k.unit, k.progress, k.weight, k."dueDate" AS d, k."completedAt" AS c, g."isPrivate" AS private
   FROM key_results k JOIN goals g ON g.id = k."goalId" WHERE g."organizationId" = $1`,
  [ORG],
);
const krRows = krs.map((k) => ({ kr_id: k.id, goal_id: k.goal, owner_id: ref(k.owner), title: k.private ? "(private)" : redact(k.title), kr_type: k.type ?? "", start_value: k.sv, target_value: k.tv, current_value: k.cv, unit: k.unit ?? "", progress: k.progress ?? 0, weight: k.weight ?? 1, due_date: day(k.d), completed_at: ts(k.c) }));

// ---------------- Feedback (metadata only, no content) ----------------
const feedback = await q(
  `SELECT id, "senderId" AS sender, "receiverId" AS receiver, type::text AS type, visibility::text AS visibility, "isAnonymous" AS anon, tags, badge, "createdAt" AS created
   FROM feedbacks WHERE "organizationId" = $1`,
  [ORG],
);
const feedbackRows = feedback.map((f) => ({ feedback_id: f.id, sender_id: f.anon ? "" : ref(f.sender), receiver_id: ref(f.receiver), feedback_type: f.type, visibility: f.visibility, is_anonymous: f.anon ? 1 : 0, tags: (f.tags ?? []).map((t: string) => redact(t)), badge: f.badge ?? "", created_at: ts(f.created) }));

const competencies = await q(`SELECT name, category, "isCore" AS core FROM competencies WHERE "organizationId" = $1 AND "isActive"`, [ORG]);
const competencyRows = competencies.map((c) => ({ name: redact(c.name), category: c.category ?? "", is_core: c.core ? 1 : 0 }));

await db.end();

// ---------------- Write to ClickHouse ----------------
if (!(await ch.ensureServer())) {
  console.error("ClickHouse is not reachable.");
  process.exit(1);
}
await ch.exec("CREATE DATABASE IF NOT EXISTS hr COMMENT 'HR data imported from Ascend (pseudonymised; no free text)'");
const TABLES: Record<string, { ddl: string; rows: object[] }> = {
  employees: {
    rows: employeeRows,
    ddl: `employee_id String, name String COMMENT 'Pseudonym (not the real name)', title String, role LowCardinality(String) COMMENT 'Ascend app role: MEMBER, MANAGER, VP, HR_ADMIN, SUPER_ADMIN',
      status LowCardinality(String) COMMENT 'ACTIVE or DEACTIVATED (left the company)', employment_type LowCardinality(String) COMMENT 'EMPLOYEE or CONTRACTOR',
      department_id String, department String, team_id String, team String, manager_id String COMMENT 'employee_id of the manager (empty = top of org)', manager_name String,
      start_date Nullable(Date), tenure_months Nullable(Int32), direct_reports UInt32, is_people_manager UInt8, org_depth UInt8 COMMENT '0 = top of the org chart'`,
  },
  departments: { rows: departmentRows, ddl: "department_id String, name String, parent_id String, head_id String, head_name String, headcount UInt32 COMMENT 'Active employees'" },
  teams: { rows: teamRows, ddl: "team_id String, name String, department_id String, department String, lead_id String, lead_name String, headcount UInt32 COMMENT 'Active employees'" },
  review_cycles: { rows: cycleRows, ddl: "cycle_id String, name String, status LowCardinality(String), start_date Nullable(Date), end_date Nullable(Date), includes_self_review UInt8, includes_peer_review UInt8, includes_manager_review UInt8" },
  reviews: {
    rows: reviewRows,
    ddl: `review_id String, cycle_id String, cycle_name String, review_type LowCardinality(String) COMMENT 'SELF_ASSESSMENT or MANAGER_REVIEW', status LowCardinality(String) COMMENT 'SUBMITTED, IN_PROGRESS, NOT_STARTED',
      author_id String, subject_id String COMMENT 'Employee being reviewed', subject_department String, subject_team String, subject_manager_id String,
      overall_rating Nullable(Float64) COMMENT '1-5', calibrated_rating Nullable(Float64) COMMENT '1-5 after calibration (often empty)', submitted_at Nullable(DateTime), acknowledged UInt8`,
  },
  review_ratings: { rows: ratingRows, ddl: "review_id String, cycle_id String, review_type LowCardinality(String), subject_id String, question_id String, question String, category LowCardinality(String), rating UInt8 COMMENT '1-5'" },
  goals: {
    rows: goalRows,
    ddl: "goal_id String, owner_id String, title String, goal_type LowCardinality(String), status LowCardinality(String), timeframe LowCardinality(String), progress Float64 COMMENT '0-100', start_date Nullable(Date), due_date Nullable(Date), completed_at Nullable(DateTime), parent_goal_id String, cycle_id String",
  },
  key_results: {
    rows: krRows,
    ddl: "kr_id String, goal_id String, owner_id String, title String, kr_type LowCardinality(String), start_value Nullable(Float64), target_value Nullable(Float64), current_value Nullable(Float64), unit String, progress Float64, weight Float64, due_date Nullable(Date), completed_at Nullable(DateTime)",
  },
  feedback: {
    rows: feedbackRows,
    ddl: "feedback_id String, sender_id String COMMENT 'Empty when anonymous', receiver_id String, feedback_type LowCardinality(String), visibility LowCardinality(String), is_anonymous UInt8, tags Array(String), badge String, created_at Nullable(DateTime)",
  },
  competencies: { rows: competencyRows, ddl: "name String, category String, is_core UInt8" },
};
for (const [name, t] of Object.entries(TABLES)) {
  await ch.exec(`DROP TABLE IF EXISTS hr.${name} SYNC`);
  await ch.exec(`CREATE TABLE hr.${name} (${t.ddl}) ENGINE = MergeTree ORDER BY tuple()`);
  for (let i = 0; i < t.rows.length; i += 5000) await ch.insertJson(`hr.${name}`, t.rows.slice(i, i + 5000));
  console.log(`   ✓ hr.${name.padEnd(15)} ${t.rows.length.toLocaleString().padStart(7)} rows`);
}
const unresolvedManagers = people.filter((p) => p.manager_ref && !idOf.has(p.manager_ref)).length;
console.log(`   names replaced inside org text: ${redactions}; unresolved manager links: ${unresolvedManagers}`);
ch.stopServer();
process.exit(0);
