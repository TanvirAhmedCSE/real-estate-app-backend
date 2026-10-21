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
