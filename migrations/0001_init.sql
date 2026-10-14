-- Signatures, removal requests, follow-up answers, and a running count.

CREATE TABLE signatures (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL,                     -- as entered
  display_name    TEXT NOT NULL,                     -- "First L.", or the full name if show_full_name
  email           TEXT NOT NULL UNIQUE,              -- lower-cased, trimmed; never shown publicly
  city            TEXT,                              -- optional, shown beside the name
  wants_updates   INTEGER NOT NULL DEFAULT 0,
  show_full_name  INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pending'    -- pending | approved | rejected
                  CHECK (status IN ('pending', 'approved', 'rejected')),
  ref_code        TEXT NOT NULL UNIQUE,              -- public code in the signer's personal link
  referred_by     INTEGER REFERENCES signatures(id) ON DELETE SET NULL,
  norm_estimate   INTEGER CHECK (norm_estimate BETWEEN 0 AND 10),
  followup_token  TEXT NOT NULL UNIQUE,              -- secret for follow-up email links
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  exported_at     TEXT                               -- when exported to Kit
);

-- The wall reads approved names newest first, a page at a time.
CREATE INDEX signatures_wall ON signatures (status, id);
CREATE INDEX signatures_referred_by ON signatures (referred_by);

CREATE TABLE removal_requests (
  id                 INTEGER PRIMARY KEY,
  email              TEXT NOT NULL,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  handled_at         TEXT,
  needs_kit_removal  INTEGER NOT NULL DEFAULT 0,     -- signer was exported to Kit; remove them there by hand
  kit_removed_at     TEXT
);

CREATE TABLE followups (
  signature_id  INTEGER PRIMARY KEY REFERENCES signatures(id) ON DELETE CASCADE,
  answer        TEXT NOT NULL CHECK (answer IN ('yes', 'no')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- COUNT(*) reads every row, which adds up fast on D1's free plan.
-- Keep the total in one row instead.
CREATE TABLE counters (
  name   TEXT PRIMARY KEY,
  value  INTEGER NOT NULL
);
INSERT INTO counters (name, value) VALUES ('signatures', 0);

CREATE TRIGGER signatures_count_insert AFTER INSERT ON signatures
BEGIN
  UPDATE counters SET value = value + 1 WHERE name = 'signatures';
END;

CREATE TRIGGER signatures_count_delete AFTER DELETE ON signatures
BEGIN
  UPDATE counters SET value = value - 1 WHERE name = 'signatures';
END;
