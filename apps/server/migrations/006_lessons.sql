-- Lessons: each meeting of a group as a record. The lesson itself happens in a third-party
-- video service; the platform keeps when it is, the call link, the materials, the recording
-- the teacher posts afterwards, and who attended. An individual student is a group of one.

CREATE TABLE lessons (
  lesson_id text PRIMARY KEY,
  group_id text NOT NULL REFERENCES school_groups (group_id) ON DELETE CASCADE,
  -- The weekly slot this lesson was generated from; NULL for a lesson the teacher added by hand.
  -- Moving a lesson changes starts_at only, so the slot is never generated a second time.
  slot_at timestamptz,
  starts_at timestamptz NOT NULL,
  minutes integer NOT NULL CHECK (minutes BETWEEN 15 AND 240),
  -- planned → held (the teacher marked attendance) or cancelled.
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'held', 'cancelled')),
  topic text NOT NULL DEFAULT '',
  -- A link for this lesson only; NULL means the group's call link.
  call_url text,
  -- [{ "title": "Рабочий лист", "url": "https://…" }]
  materials jsonb NOT NULL DEFAULT '[]',
  recording_url text,
  -- What the students see next to the lesson: why it was cancelled, what to bring.
  note text NOT NULL DEFAULT '',
  -- Touched by the teacher: a schedule change no longer removes it.
  edited boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (group_id, slot_at)
);
CREATE INDEX lessons_group_time ON lessons (group_id, starts_at);

-- What the group's lessons were generated from, and how far ahead.
CREATE TABLE lesson_plans (
  group_id text PRIMARY KEY REFERENCES school_groups (group_id) ON DELETE CASCADE,
  schedule jsonb NOT NULL,
  generated_until timestamptz NOT NULL
);

-- Present or absent ("missed by the student"), one mark per student and held lesson.
CREATE TABLE lesson_attendance (
  lesson_id text NOT NULL REFERENCES lessons (lesson_id) ON DELETE CASCADE,
  account_id text NOT NULL REFERENCES accounts (account_id),
  status text NOT NULL CHECK (status IN ('present', 'absent')),
  marked_at timestamptz NOT NULL,
  marked_by text NOT NULL REFERENCES accounts (account_id),
  PRIMARY KEY (lesson_id, account_id)
);
CREATE INDEX lesson_attendance_account ON lesson_attendance (account_id);

-- Files the teacher attaches to a lesson (a worksheet, slides, an audio track), in the same
-- storage as homework hand-ins. Group members download them by a short-lived link.
CREATE TABLE lesson_files (
  file_id text PRIMARY KEY,
  lesson_id text NOT NULL REFERENCES lessons (lesson_id) ON DELETE CASCADE,
  file_key text NOT NULL,
  file_name text NOT NULL,
  mime text NOT NULL,
  size bigint NOT NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lesson_files_lesson ON lesson_files (lesson_id, uploaded_at);
