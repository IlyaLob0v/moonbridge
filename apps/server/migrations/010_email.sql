-- E-mail: the address each account gives (for reminders and for resetting a forgotten password),
-- the reminders the gateway has sent, and one-off password reset links.

ALTER TABLE accounts ADD COLUMN email text;
-- "Не присылать напоминания": the unsubscribe link in every reminder turns this off.
ALTER TABLE accounts ADD COLUMN reminders boolean NOT NULL DEFAULT true;
CREATE INDEX accounts_email ON accounts (email) WHERE email IS NOT NULL;

-- One row per reminder: claimed before it is sent, so two runs never send the same one, and a
-- failed send is retried a couple of times. `ref` says what the reminder is about: the Moscow
-- date of an evening reminder, the homework of a deadline, the review of a grade.
CREATE TABLE emails (
  email_id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts (account_id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('evening', 'deadline', 'grade')),
  ref text NOT NULL,
  -- The platform page the e-mail's button leads to, through /email/go/<email_id>.
  target text NOT NULL,
  status text NOT NULL CHECK (status IN ('sending', 'sent', 'failed')),
  attempts integer NOT NULL DEFAULT 1,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  -- The first time the student opened the platform from this e-mail: the pilot counts returns.
  clicked_at timestamptz,
  UNIQUE (account_id, kind, ref)
);
CREATE INDEX emails_sent ON emails (sent_at) WHERE sent_at IS NOT NULL;

-- Only the hash of the link's token is kept: a leaked table cannot reset anyone's password.
CREATE TABLE password_resets (
  token_hash text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts (account_id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX password_resets_account ON password_resets (account_id, created_at);
