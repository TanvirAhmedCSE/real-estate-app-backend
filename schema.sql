CREATE TABLE IF NOT EXISTS units (
    odoo_id     INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    project     TEXT,
    building    TEXT,
    unit_type   TEXT,
    floor       TEXT,
    size        NUMERIC,
    size_unit   TEXT,
    price       NUMERIC,
    state       TEXT NOT NULL DEFAULT 'available'
                CHECK (state IN ('available', 'booked', 'sold')),
    active      BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS booking_requests (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    unit_odoo_id    INTEGER NOT NULL REFERENCES units(odoo_id) ON DELETE CASCADE,
    customer_name   TEXT NOT NULL,
    customer_email  TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'converted', 'cancelled')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_requests_unit ON booking_requests (unit_odoo_id);
CREATE INDEX IF NOT EXISTS idx_requests_updated ON booking_requests (updated_at);

CREATE TABLE IF NOT EXISTS unit_images (
    id            SERIAL PRIMARY KEY,
    unit_odoo_id  INTEGER NOT NULL REFERENCES units(odoo_id) ON DELETE CASCADE,
    public_id     TEXT NOT NULL,
    url           TEXT NOT NULL,
    position      INTEGER NOT NULL DEFAULT 0,
    UNIQUE (unit_odoo_id, public_id)
);

CREATE INDEX IF NOT EXISTS idx_unit_images_unit ON unit_images (unit_odoo_id, position);

-- ---- NEW: customer accounts + per-user favourites ----
CREATE TABLE IF NOT EXISTS users (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                TEXT NOT NULL,
    email               TEXT NOT NULL UNIQUE,
    password_hash       TEXT NOT NULL,
    is_verified         BOOLEAN NOT NULL DEFAULT FALSE,
    verify_otp          TEXT,
    verify_otp_expiry   TIMESTAMPTZ,
    otp_attempts        INTEGER NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS favorites (
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    unit_odoo_id  INTEGER NOT NULL REFERENCES units(odoo_id) ON DELETE CASCADE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, unit_odoo_id)
);

-- ---- NEW: which logged-in account sent each booking request (Neon only, not synced to Odoo) ----
ALTER TABLE booking_requests ADD COLUMN IF NOT EXISTS customer_account_name  TEXT;
ALTER TABLE booking_requests ADD COLUMN IF NOT EXISTS customer_account_email TEXT;
CREATE INDEX IF NOT EXISTS idx_requests_account ON booking_requests (customer_account_email);

-- ---- NEW: account name/email on each favourite (Neon only, next to user_id) ----
ALTER TABLE favorites ADD COLUMN IF NOT EXISTS customer_account_name  TEXT;
ALTER TABLE favorites ADD COLUMN IF NOT EXISTS customer_account_email TEXT;
-- fill the two columns for favourites saved before this change
UPDATE favorites f
   SET customer_account_name = u.name, customer_account_email = u.email
  FROM users u
 WHERE u.id = f.user_id AND f.customer_account_email IS NULL;

-- ---- NEW: customer phone on booking requests ----
ALTER TABLE booking_requests ADD COLUMN IF NOT EXISTS customer_phone TEXT;