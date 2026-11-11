-- A Moonbridge unit as homework. The teacher picks a unit in the lesson catalog and gives it
-- to the whole group or to one student; the student plays the unit's episodes, and the result
-- comes in on its own as a hand-in with a score, which the teacher grades in the review queue
-- (or which is graded at once, when the teacher asked for that).

-- The unit (module_id) to play; null for ordinary homework.
ALTER TABLE homework ADD COLUMN module_id text;
-- One student of the group; null = the whole group.
ALTER TABLE homework ADD COLUMN account_id text REFERENCES accounts (account_id) ON DELETE CASCADE;
-- Grade a unit from its score without waiting for the teacher.
ALTER TABLE homework ADD COLUMN auto_grade boolean NOT NULL DEFAULT false;

-- A unit's hand-in has no file, only a score: tasks right on the first try, out of all tasks.
ALTER TABLE submissions ALTER COLUMN file_key DROP NOT NULL;
ALTER TABLE submissions ALTER COLUMN file_name DROP NOT NULL;
ALTER TABLE submissions ALTER COLUMN mime DROP NOT NULL;
ALTER TABLE submissions ALTER COLUMN size DROP NOT NULL;
ALTER TABLE submissions ADD COLUMN score_right integer;
ALTER TABLE submissions ADD COLUMN score_total integer;

-- Every Moonbridge episode a student finishes, from the xAPI `completed` statement; a resend
-- from the offline queue is skipped by its statement id.
CREATE TABLE episode_results (
  statement_id uuid PRIMARY KEY,
  player_id text NOT NULL,
  episode_id text NOT NULL,
  module_id text NOT NULL,
  first_try_right integer NOT NULL,
  tasks integer NOT NULL,
  finished_at timestamptz NOT NULL
);
CREATE INDEX episode_results_player ON episode_results (player_id, module_id, finished_at);

-- How a group's students get units in the hotel: 'assigned' = a unit opens when the teacher gives
-- it as homework (the game follows the lessons); 'course' = units open one after another by
-- themselves as the student plays.
ALTER TABLE school_groups ADD COLUMN unit_access text NOT NULL DEFAULT 'assigned' CHECK (unit_access IN ('assigned', 'course'));
