# HR data (database `hr`, imported from Ascend)

Real company data, **pseudonymised**: every `name` is a stable fake name, not the person's real name. There is **no free text** (no feedback content, review comments or written answers), so never claim to know what someone wrote.

## Tables
- `hr.employees`: one row per person. `manager_id` → another `employee_id` (empty = top of the org); `status` ACTIVE / DEACTIVATED; `role` is the Ascend app role (MEMBER, MANAGER, VP, HR_ADMIN, SUPER_ADMIN), not seniority; `org_depth` 0 = top; `direct_reports`, `is_people_manager`, `tenure_months`.
- `hr.departments`, `hr.teams`: names, heads/leads, active `headcount`.
- `hr.review_cycles`: only cycles with `status = 'COMPLETED'` hold finished performance data; CANCELLED cycles should be excluded unless asked.
- `hr.reviews`: one row per review. `review_type` SELF_ASSESSMENT (author = subject) or MANAGER_REVIEW; `overall_rating` 1–5 (NULL when not submitted); `calibrated_rating` is usually empty; `subject_department` / `subject_team` / `subject_manager_id` are denormalised for grouping.
- `hr.review_ratings`: per-question ratings 1–5 with `question` text and `category` (competency area). Use for competency-level analysis.
- `hr.goals` (annual/quarterly goals with `progress` 0–100 and `status`), `hr.key_results` (target vs current values), `hr.feedback` (metadata only: who → whom, type, visibility, anonymity, tags, date), `hr.competencies` (framework).

## Definitions
- **Active employee**: `status = 'ACTIVE'` in `hr.employees`.
- **Performance rating**: `overall_rating` of `MANAGER_REVIEW` rows with `status = 'SUBMITTED'` in completed cycles. Prefer `calibrated_rating` when it's set.
- **Self vs manager gap**: per subject and cycle, self-assessment rating minus manager rating (positive = rates themselves higher). Join on `subject_id` + `cycle_id`.
- **Review completion rate**: submitted reviews ÷ all reviews in the cycle, by `review_type`.
- **Rating distribution**: share of manager ratings at each value 1–5.
- **Span of control**: `direct_reports` of people managers.
- **Goal attainment**: average `progress` and share of goals with `status = 'COMPLETED'`.
- **Feedback activity**: feedback given/received per person or team; anonymous feedback has an empty `sender_id`.

## Privacy rules (always)
- Aggregate by department, team, cycle or manager by default. **Do not report an average or distribution for a group smaller than 5 people**; say the group is too small instead.
- Only list named individuals (pseudonyms) when the question explicitly asks for individuals, and then show just the fields needed.
- Never try to infer real identities.
