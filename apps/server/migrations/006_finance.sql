-- Finances: a student's balance of paid lessons. The teacher (or the admin) records each
-- payment by hand; every held lesson takes one lesson off. The balance is the sum of the
-- ledger, never a stored number, so it can always be explained line by line.

-- One payment: how many lessons it buys and for how much. `provider` and `status` leave room
-- for online payment (YooKassa): such a payment arrives 'pending' with the provider's id and
-- adds lessons only when it becomes 'succeeded'. A manual payment is 'succeeded' at once.
CREATE TABLE payments (
  payment_id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts (account_id) ON DELETE CASCADE,
  lessons integer NOT NULL CHECK (lessons > 0),
  -- Kopecks: no floating point in money.
  amount_kop bigint NOT NULL CHECK (amount_kop >= 0),
  currency text NOT NULL DEFAULT 'RUB',
  method text NOT NULL CHECK (method IN ('cash', 'transfer', 'card', 'online')),
  provider text NOT NULL DEFAULT 'manual' CHECK (provider IN ('manual', 'yookassa')),
  provider_payment_id text UNIQUE,
  status text NOT NULL DEFAULT 'succeeded' CHECK (status IN ('pending', 'succeeded', 'canceled')),
  -- The day the money came, Moscow date.
  paid_on date NOT NULL,
  note text NOT NULL DEFAULT '',
  -- NULL: recorded with the admin token or by the payment provider.
  recorded_by text REFERENCES accounts (account_id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- A payment entered by mistake is voided, not deleted: the ledger keeps both lines.
  voided_at timestamptz,
  voided_by text REFERENCES accounts (account_id) ON DELETE SET NULL
);
CREATE INDEX payments_by_account ON payments (account_id, paid_on);

-- The ledger, in lessons: +N for a payment, −N when it is voided, −1 for each held lesson,
-- ±N for a correction the teacher explains in the note.
CREATE TABLE balance_entries (
  entry_id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts (account_id) ON DELETE CASCADE,
  delta integer NOT NULL CHECK (delta <> 0),
  kind text NOT NULL CHECK (kind IN ('payment', 'void', 'lesson', 'correction')),
  payment_id text REFERENCES payments (payment_id) ON DELETE CASCADE,
  -- The lesson this entry pays for (lessons live in their own table; no foreign key, so
  -- either part can change without the other).
  lesson_id text,
  -- When it happened: the payment's day, the lesson's start, the moment of a correction.
  at timestamptz NOT NULL,
  note text NOT NULL DEFAULT '',
  created_by text REFERENCES accounts (account_id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX balance_by_account ON balance_entries (account_id, at);
-- A lesson is charged once per student, however often its attendance is saved.
CREATE UNIQUE INDEX balance_lesson_once ON balance_entries (account_id, lesson_id) WHERE kind = 'lesson';
-- A payment adds its lessons once, and is voided once.
CREATE UNIQUE INDEX balance_payment_once ON balance_entries (payment_id, kind) WHERE payment_id IS NOT NULL;
