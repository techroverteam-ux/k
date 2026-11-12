CREATE TABLE IF NOT EXISTS payment_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose varchar(12) NOT NULL CHECK (purpose IN ('OPENING', 'DEPOSIT')),
  payment_request_id uuid UNIQUE REFERENCES payment_requests(id) ON DELETE CASCADE,
  payee_account_id uuid NOT NULL REFERENCES payee_accounts(id) ON DELETE RESTRICT,
  submitted_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  utr text NOT NULL,
  utr_hash char(64) NOT NULL UNIQUE,
  payer_name text NOT NULL,
  paid_at timestamptz NOT NULL,
  proof_mime varchar(20),
  proof_data text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payment_evidence_user_idx ON payment_evidence(user_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS payment_evidence_opening_uq ON payment_evidence(user_id) WHERE purpose = 'OPENING';
