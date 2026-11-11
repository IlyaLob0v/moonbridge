-- Finances: each student has a price per lesson; the teacher (or the admin) records the
-- payments that come by hand, and every held lesson costs the student's price. The balance
-- is in roubles and is the sum of the ledger, never a stored number, so it can always be
-- explained line by line. Lessons left = balance / price.

-- The student's price per lesson. A lesson keeps the price it was charged at, so a new price
-- does not rewrite the past.
CREATE TABLE lesson_prices (
  account_id text PRIMARY KEY REFERENCES accounts (account_id) ON DELETE CASCADE,
  price_kop bigint NOT NULL CHECK (price_kop > 0),
  updated_by text REFERENCES accounts (account_id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One payment. `provider` and `status` leave room for online payment (YooKassa): such a
-- payment arrives 'pending' with the provider's id and reaches the ledger only when it becomes
-- 'succeeded'. A manual payment is 'succeeded' at once.
CREATE TABLE payments (
  payment_id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts (account_id) ON DELETE CASCADE,
  -- Kopecks: no floating point in money.
  amount_kop bigint NOT NULL CHECK (amount_kop > 0),
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

-- The ledger, in kopecks: +amount for a payment, −amount when it is voided, −price for each
-- held lesson, ± for a correction the teacher explains in the note.
CREATE TABLE balance_entries (
  entry_id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts (account_id) ON DELETE CASCADE,
  -- NULL only for a lesson held before the student had a price; setting the price fills it.
  amount_kop bigint,
  kind text NOT NULL CHECK (kind IN ('payment', 'void', 'lesson', 'correction')),
  payment_id text REFERENCES payments (payment_id) ON DELETE CASCADE,
  -- The lesson this entry pays for (lessons live in their own table; no foreign key, so
  -- either part can change without the other).
  lesson_id text,
  -- When it happened: the payment's day, the lesson's start, the moment of a correction.
  at timestamptz NOT NULL,
  note text NOT NULL DEFAULT '',
  created_by text REFERENCES accounts (account_id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (amount_kop IS NOT NULL OR kind = 'lesson')
);
CREATE INDEX balance_by_account ON balance_entries (account_id, at);
-- A lesson is charged once per student, however often its attendance is saved.
CREATE UNIQUE INDEX balance_lesson_once ON balance_entries (account_id, lesson_id) WHERE kind = 'lesson';
-- A payment reaches the ledger once, and is voided once.
CREATE UNIQUE INDEX balance_payment_once ON balance_entries (payment_id, kind) WHERE payment_id IS NOT NULL;

-- Who handles the money: an admin account (the school's owner), created with the admin token.
-- Prices, payments, voids and corrections are the admin's; teachers only read them.
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_role_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_role_check CHECK (role IN ('student', 'teacher', 'admin'));
