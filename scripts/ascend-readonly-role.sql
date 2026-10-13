-- Read-only, column-restricted Postgres role for the Ingestion HR import (npm run hr:import).
-- Run in the Neon SQL Editor for the Ascend project (database: the one your app uses, usually neondb).
-- Create the role with SQL, not the Neon Console: Console-created roles join neon_superuser and can read everything.
-- The role can only SELECT the columns the import needs: no password hashes, emails, phones, birthdays,
-- tokens, API keys, or free text (feedback content, review comments, written answers, calibration notes).

CREATE ROLE brain_readonly WITH LOGIN PASSWORD 'REPLACE_WITH_A_LONG_RANDOM_PASSWORD';
ALTER ROLE brain_readonly SET default_transaction_read_only = on;

GRANT CONNECT ON DATABASE neondb TO brain_readonly;   -- change neondb if your database has another name
GRANT USAGE ON SCHEMA public TO brain_readonly;

GRANT SELECT (id, "createdAt") ON organizations TO brain_readonly;
GRANT SELECT (id, "firstName", "lastName", "displayName") ON users TO brain_readonly;
GRANT SELECT (id, "userId", "organizationId", title, role, status, "employmentType", "startDate", "managerId", "departmentId", "teamId") ON memberships TO brain_readonly;
GRANT SELECT (id, "organizationId", name, "parentId", "headId") ON departments TO brain_readonly;
GRANT SELECT (id, "organizationId", name, "departmentId", "leadId") ON teams TO brain_readonly;
GRANT SELECT (id, "organizationId", name, status, "startDate", "endDate", "includesSelfReview", "includesPeerReview", "includesManagerReview") ON review_cycles TO brain_readonly;
GRANT SELECT (id, "cycleId", type, status, "authorId", "subjectId", "overallRating", "calibratedRating", "submittedAt", "acknowledgedAt") ON reviews TO brain_readonly;
GRANT SELECT (id, text, category, weight, type) ON review_template_questions TO brain_readonly;
GRANT SELECT (id, "reviewId", "questionId", "ratingValue") ON review_responses TO brain_readonly;
GRANT SELECT (id, "organizationId", "ownerId", title, type, status, timeframe, progress, "startDate", "dueDate", "completedAt", "parentId", "reviewCycleId", "isPrivate") ON goals TO brain_readonly;
GRANT SELECT (id, "goalId", "ownerId", title, type, "startValue", "targetValue", "currentValue", unit, progress, weight, "dueDate", "completedAt") ON key_results TO brain_readonly;
GRANT SELECT (id, "organizationId", "senderId", "receiverId", type, visibility, "isAnonymous", tags, badge, "createdAt") ON feedbacks TO brain_readonly;
GRANT SELECT (name, category, "isCore", "organizationId", "isActive") ON competencies TO brain_readonly;

-- To revoke later:  DROP OWNED BY brain_readonly; DROP ROLE brain_readonly;
