-- Legal consents, rubrics for file homework, and the entry/final tests and the survey.

-- A student under 18: the platform opens once a parent has consented.
ALTER TABLE accounts ADD COLUMN minor boolean NOT NULL DEFAULT false;

-- Every acceptance is kept, never overwritten: what was accepted, which edition, when and from
-- where. 'terms' is the student's own (offer + privacy policy + consent), 'parent' a parent's
-- consent for a minor: by the link in an e-mail, or on paper as the teacher recorded it.
CREATE TABLE consents (
  consent_id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts (account_id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('terms', 'parent')),
  -- The editions of the pages accepted, e.g. {"terms":"2026-11-13","privacy":"2026-11-13"}.
  versions jsonb NOT NULL,
  method text NOT NULL CHECK (method IN ('click', 'email', 'paper')),
  parent_name text,
  parent_email text,
  -- The teacher who recorded a paper consent.
  recorded_by text REFERENCES accounts (account_id) ON DELETE SET NULL,
  ip text,
  user_agent text,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  -- The order of rows: two acceptances in the same second still have a newest.
  seq bigint GENERATED ALWAYS AS IDENTITY
);
CREATE INDEX consents_account ON consents (account_id, kind, seq);

-- The link a parent gets by e-mail. Only the token's hash is kept.
CREATE TABLE parent_requests (
  token_hash text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts (account_id) ON DELETE CASCADE,
  parent_name text NOT NULL,
  parent_email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX parent_requests_account ON parent_requests (account_id, created_at);

-- The criteria a file homework is graded by, copied from the content when it is given:
-- {"title": "...", "criteria": [{"id": "task", "label": "...", "max": 2, "hint": "..."}]}.
ALTER TABLE homework ADD COLUMN rubric jsonb;
-- The points per criterion the teacher gave, {"task": 2, "grammar": 1}.
ALTER TABLE submissions ADD COLUMN rubric_scores jsonb;

-- A test or survey the teacher opened for a group; closing keeps the results.
CREATE TABLE group_assessments (
  group_id text NOT NULL REFERENCES school_groups (group_id) ON DELETE CASCADE,
  assessment_id text NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  PRIMARY KEY (group_id, assessment_id)
);

-- One result per student, test and group: a test is taken once.
CREATE TABLE assessment_results (
  result_id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts (account_id) ON DELETE CASCADE,
  group_id text NOT NULL REFERENCES school_groups (group_id) ON DELETE CASCADE,
  assessment_id text NOT NULL,
  -- A test: [{"task_id", "response", "correct"}]; a survey: {"question_id": answer}.
  answers jsonb NOT NULL,
  score_right integer,
  score_total integer,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, group_id, assessment_id)
);
CREATE INDEX assessment_results_group ON assessment_results (group_id, assessment_id);
