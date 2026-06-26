-- ============================================================
-- RHEO LOGISTICS PLATFORM — MASTER DATABASE SCHEMA
-- PostgreSQL 15+
-- ============================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "postgis";        -- Real-time GPS tracking
CREATE EXTENSION IF NOT EXISTS "pg_trgm";        -- Fast text search

-- ============================================================
-- ENUMS
-- ============================================================

CREATE TYPE user_role AS ENUM (
  'super_admin', 'admin', 'finance', 'hr_payroll', 'customer_care'
);

CREATE TYPE business_member_role AS ENUM (
  'owner', 'ops_manager', 'dispatcher'
);

CREATE TYPE driver_status AS ENUM (
  'pending', 'under_review', 'approved', 'suspended', 'deactivated', 'rejected'
);

CREATE TYPE business_status AS ENUM (
  'pending', 'active', 'suspended', 'churned'
);

CREATE TYPE job_status AS ENUM (
  'queued', 'assigned', 'picked_up', 'in_transit', 'delivered',
  'failed', 'cancelled', 'disputed'
);

CREATE TYPE payment_method_type AS ENUM (
  'mtn_momo', 'airtel_money', 'visa', 'mastercard'
);

CREATE TYPE transaction_type AS ENUM (
  'job_earning', 'withdrawal', 'commission_deduction',
  'business_payment', 'subscription_charge', 'refund', 'adjustment'
);

CREATE TYPE transaction_status AS ENUM (
  'pending', 'processing', 'completed', 'failed', 'reversed'
);

CREATE TYPE subscription_plan AS ENUM (
  'starter', 'growth', 'enterprise', 'custom'
);

CREATE TYPE subscription_billing AS ENUM (
  'monthly', 'annual'
);

CREATE TYPE ticket_status AS ENUM (
  'open', 'in_progress', 'resolved', 'closed', 'escalated'
);

CREATE TYPE ticket_priority AS ENUM (
  'low', 'medium', 'high', 'critical'
);

CREATE TYPE notification_type AS ENUM (
  'job_assigned', 'job_update', 'payment', 'account', 'system', 'promotion'
);

CREATE TYPE kyc_status AS ENUM (
  'not_submitted', 'pending', 'approved', 'rejected'
);

CREATE TYPE vehicle_type AS ENUM (
  'bicycle', 'motorcycle', 'car', 'van', 'truck'
);

-- ============================================================
-- CORE AUTH — SHARED ACROSS ALL SURFACES
-- Each surface has its own auth context via `surface` column
-- ============================================================

CREATE TABLE auth_users (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email           TEXT UNIQUE NOT NULL,
  phone           TEXT UNIQUE,
  password_hash   TEXT NOT NULL,
  surface         TEXT NOT NULL CHECK (surface IN ('staff', 'business', 'driver')),
  is_active       BOOLEAN DEFAULT true,
  is_verified     BOOLEAN DEFAULT false,
  two_fa_enabled  BOOLEAN DEFAULT false,
  two_fa_secret   TEXT,                          -- TOTP secret, encrypted
  last_login_at   TIMESTAMPTZ,
  last_login_ip   INET,
  failed_attempts INTEGER DEFAULT 0,
  locked_until    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE auth_sessions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  refresh_token   TEXT NOT NULL UNIQUE,           -- hashed
  device_fp       TEXT,                           -- device fingerprint (staff only)
  ip_address      INET,
  user_agent      TEXT,
  surface         TEXT NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE auth_otp (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  otp_hash    TEXT NOT NULL,
  purpose     TEXT NOT NULL CHECK (purpose IN ('login', 'reset', 'verify', '2fa')),
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- RHEO STAFF
-- ============================================================

CREATE TABLE staff (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  auth_user_id    UUID UNIQUE NOT NULL REFERENCES auth_users(id),
  role            user_role NOT NULL,
  first_name      TEXT NOT NULL,
  last_name       TEXT NOT NULL,
  employee_id     TEXT UNIQUE NOT NULL,
  department      TEXT,
  job_title       TEXT,
  avatar_url      TEXT,
  phone           TEXT,
  is_active       BOOLEAN DEFAULT true,
  hired_at        DATE,
  terminated_at   DATE,
  created_by      UUID REFERENCES staff(id),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Staff permissions (granular overrides on top of role defaults)
CREATE TABLE staff_permissions (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  staff_id      UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  permission    TEXT NOT NULL,    -- e.g. 'drivers.approve', 'finance.view_payouts'
  granted       BOOLEAN DEFAULT true,
  granted_by    UUID REFERENCES staff(id),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(staff_id, permission)
);

-- HR payroll records
CREATE TABLE staff_payroll (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  staff_id        UUID NOT NULL REFERENCES staff(id),
  period_start    DATE NOT NULL,
  period_end      DATE NOT NULL,
  gross_salary    NUMERIC(12,2) NOT NULL,
  deductions      NUMERIC(12,2) DEFAULT 0,
  net_salary      NUMERIC(12,2) NOT NULL,
  currency        TEXT DEFAULT 'UGX',
  status          TEXT DEFAULT 'pending' CHECK (status IN ('pending','processed','paid')),
  paid_at         TIMESTAMPTZ,
  processed_by    UUID REFERENCES staff(id),
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- BUSINESSES (Rheo Flow Members)
-- ============================================================

CREATE TABLE businesses (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  auth_user_id        UUID UNIQUE NOT NULL REFERENCES auth_users(id),
  business_name       TEXT NOT NULL,
  trading_name        TEXT,
  registration_no     TEXT,
  tax_id              TEXT,
  industry            TEXT,
  website             TEXT,
  logo_url            TEXT,
  status              business_status DEFAULT 'pending',

  -- Contact
  primary_email       TEXT NOT NULL,
  primary_phone       TEXT NOT NULL,

  -- Address
  address_line1       TEXT,
  address_line2       TEXT,
  city                TEXT DEFAULT 'Kampala',
  country             TEXT DEFAULT 'Uganda',

  -- KYC
  kyc_status          kyc_status DEFAULT 'not_submitted',
  kyc_reviewed_by     UUID REFERENCES staff(id),
  kyc_reviewed_at     TIMESTAMPTZ,
  kyc_notes           TEXT,

  -- Plan
  plan                subscription_plan DEFAULT 'starter',
  plan_billing        subscription_billing DEFAULT 'monthly',
  plan_started_at     TIMESTAMPTZ,
  plan_renews_at      TIMESTAMPTZ,
  commission_rate     NUMERIC(5,4) DEFAULT 0.12,  -- 12% default, custom for enterprise

  -- Onboarded by
  onboarded_by        UUID REFERENCES staff(id),
  demo_requested      BOOLEAN DEFAULT false,
  demo_at             TIMESTAMPTZ,

  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Business team members
CREATE TABLE business_members (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  auth_user_id    UUID UNIQUE NOT NULL REFERENCES auth_users(id),
  role            business_member_role NOT NULL DEFAULT 'dispatcher',
  first_name      TEXT NOT NULL,
  last_name       TEXT NOT NULL,
  phone           TEXT,
  avatar_url      TEXT,
  is_active       BOOLEAN DEFAULT true,
  invited_by      UUID REFERENCES business_members(id),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Business KYC documents
CREATE TABLE business_kyc_docs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  doc_type        TEXT NOT NULL CHECK (doc_type IN (
                    'certificate_of_incorporation', 'tax_clearance',
                    'business_license', 'bank_statement', 'other')),
  file_url        TEXT NOT NULL,                 -- encrypted S3/storage path
  file_name       TEXT,
  verified        BOOLEAN DEFAULT false,
  verified_by     UUID REFERENCES staff(id),
  verified_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- SUBSCRIPTION PLANS & BILLING
-- ============================================================

CREATE TABLE subscription_plans (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name                subscription_plan NOT NULL,
  display_name        TEXT NOT NULL,
  monthly_price_ugx   NUMERIC(12,2),
  annual_price_ugx    NUMERIC(12,2),
  max_jobs_per_month  INTEGER,                   -- NULL = unlimited
  max_team_members    INTEGER,
  api_access          BOOLEAN DEFAULT false,
  dedicated_support   BOOLEAN DEFAULT false,
  custom_branding     BOOLEAN DEFAULT false,
  features            JSONB DEFAULT '[]',
  is_active           BOOLEAN DEFAULT true,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE business_subscriptions (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id         UUID NOT NULL REFERENCES businesses(id),
  plan_id             UUID NOT NULL REFERENCES subscription_plans(id),
  billing_cycle       subscription_billing NOT NULL,
  amount_ugx          NUMERIC(12,2) NOT NULL,
  status              TEXT DEFAULT 'active' CHECK (status IN (
                        'trialing', 'active', 'past_due', 'cancelled', 'expired')),
  trial_ends_at       TIMESTAMPTZ,
  current_period_start TIMESTAMPTZ NOT NULL,
  current_period_end  TIMESTAMPTZ NOT NULL,
  cancelled_at        TIMESTAMPTZ,
  cancel_reason       TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE subscription_invoices (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id         UUID NOT NULL REFERENCES businesses(id),
  subscription_id     UUID NOT NULL REFERENCES business_subscriptions(id),
  invoice_number      TEXT UNIQUE NOT NULL,
  amount_ugx          NUMERIC(12,2) NOT NULL,
  tax_ugx             NUMERIC(12,2) DEFAULT 0,
  total_ugx           NUMERIC(12,2) NOT NULL,
  status              TEXT DEFAULT 'pending' CHECK (status IN (
                        'pending', 'paid', 'overdue', 'void')),
  due_date            DATE NOT NULL,
  paid_at             TIMESTAMPTZ,
  pdf_url             TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- DRIVERS
-- ============================================================

CREATE TABLE drivers (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  auth_user_id        UUID UNIQUE NOT NULL REFERENCES auth_users(id),
  first_name          TEXT NOT NULL,
  last_name           TEXT NOT NULL,
  date_of_birth       DATE,
  gender              TEXT,
  phone               TEXT NOT NULL,
  alt_phone           TEXT,
  avatar_url          TEXT,
  nin                 TEXT,                       -- National ID number (encrypted)
  nin_verified        BOOLEAN DEFAULT false,

  -- Address
  district            TEXT,
  sub_county          TEXT,
  village             TEXT,

  -- Vehicle
  vehicle_type        vehicle_type,
  vehicle_make        TEXT,
  vehicle_model       TEXT,
  vehicle_year        INTEGER,
  vehicle_color       TEXT,
  plate_number        TEXT,
  vehicle_capacity_kg NUMERIC(8,2),

  -- Status & approval
  status              driver_status DEFAULT 'pending',
  approved_by         UUID REFERENCES staff(id),
  approved_at         TIMESTAMPTZ,
  rejection_reason    TEXT,
  suspension_reason   TEXT,
  suspended_by        UUID REFERENCES staff(id),

  -- KYC
  kyc_status          kyc_status DEFAULT 'not_submitted',
  kyc_reviewed_by     UUID REFERENCES staff(id),
  kyc_reviewed_at     TIMESTAMPTZ,

  -- Performance
  total_jobs          INTEGER DEFAULT 0,
  total_earnings_ugx  NUMERIC(14,2) DEFAULT 0,
  rating              NUMERIC(3,2) DEFAULT 0,
  rating_count        INTEGER DEFAULT 0,

  -- Location (last known)
  last_lat            DOUBLE PRECISION,
  last_lng            DOUBLE PRECISION,
  last_seen_at        TIMESTAMPTZ,
  is_online           BOOLEAN DEFAULT false,

  -- Referral
  referred_by         UUID REFERENCES drivers(id),

  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE driver_documents (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  driver_id       UUID NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  doc_type        TEXT NOT NULL CHECK (doc_type IN (
                    'national_id_front', 'national_id_back', 'drivers_license',
                    'vehicle_log_book', 'insurance', 'passport_photo', 'other')),
  file_url        TEXT NOT NULL,
  file_name       TEXT,
  verified        BOOLEAN DEFAULT false,
  verified_by     UUID REFERENCES staff(id),
  verified_at     TIMESTAMPTZ,
  expires_at      DATE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Profile change requests (require approval before going live)
CREATE TABLE driver_profile_changes (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  driver_id       UUID NOT NULL REFERENCES drivers(id),
  field_name      TEXT NOT NULL,
  old_value       TEXT,
  new_value       TEXT NOT NULL,
  status          TEXT DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reviewed_by     UUID REFERENCES staff(id),
  reviewed_at     TIMESTAMPTZ,
  review_notes    TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- JOBS / DELIVERIES
-- ============================================================

CREATE TABLE jobs (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_ref             TEXT UNIQUE NOT NULL,       -- e.g. RHO-20240601-0001
  business_id         UUID NOT NULL REFERENCES businesses(id),
  created_by          UUID NOT NULL REFERENCES business_members(id),
  driver_id           UUID REFERENCES drivers(id),

  -- Package
  description         TEXT NOT NULL,
  weight_kg           NUMERIC(8,2),
  dimensions          JSONB,                      -- {l, w, h}
  fragile             BOOLEAN DEFAULT false,
  special_instructions TEXT,

  -- Pickup
  pickup_address      TEXT NOT NULL,
  pickup_lat          DOUBLE PRECISION,
  pickup_lng          DOUBLE PRECISION,
  pickup_contact_name TEXT,
  pickup_contact_phone TEXT,
  pickup_notes        TEXT,

  -- Delivery
  delivery_address    TEXT NOT NULL,
  delivery_lat        DOUBLE PRECISION,
  delivery_lng        DOUBLE PRECISION,
  delivery_contact_name TEXT,
  delivery_contact_phone TEXT,
  delivery_notes      TEXT,

  -- Scheduling
  requested_at        TIMESTAMPTZ DEFAULT NOW(),
  scheduled_for       TIMESTAMPTZ,
  assigned_at         TIMESTAMPTZ,
  picked_up_at        TIMESTAMPTZ,
  delivered_at        TIMESTAMPTZ,
  failed_at           TIMESTAMPTZ,

  -- Status & payment
  status              job_status DEFAULT 'queued',
  fail_reason         TEXT,
  cancellation_reason TEXT,
  cancelled_by        UUID,                       -- staff or business_member id

  -- Pricing
  base_fare_ugx       NUMERIC(10,2) NOT NULL,
  surge_multiplier    NUMERIC(4,2) DEFAULT 1.0,
  total_fare_ugx      NUMERIC(10,2) NOT NULL,
  driver_payout_ugx   NUMERIC(10,2),             -- total_fare * (1 - commission)
  rheo_commission_ugx NUMERIC(10,2),
  driver_commission_pct NUMERIC(5,4) DEFAULT 0.01, -- 1% from driver

  -- Proof of delivery
  pod_photo_url       TEXT,
  pod_signature_url   TEXT,
  pod_notes           TEXT,

  -- Rating
  driver_rating       INTEGER CHECK (driver_rating BETWEEN 1 AND 5),
  driver_rating_note  TEXT,

  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Live location trail during a job
CREATE TABLE job_tracking (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_id      UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  driver_id   UUID NOT NULL REFERENCES drivers(id),
  lat         DOUBLE PRECISION NOT NULL,
  lng         DOUBLE PRECISION NOT NULL,
  speed_kmh   NUMERIC(6,2),
  heading     NUMERIC(6,2),
  accuracy_m  NUMERIC(6,2),
  recorded_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_job_tracking_job_id ON job_tracking(job_id);
CREATE INDEX idx_job_tracking_recorded ON job_tracking(recorded_at DESC);

-- Job status history
CREATE TABLE job_status_history (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_id      UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  old_status  job_status,
  new_status  job_status NOT NULL,
  changed_by  UUID,                               -- driver, business member, or staff
  changed_by_type TEXT CHECK (changed_by_type IN ('driver','business_member','staff','system')),
  notes       TEXT,
  lat         DOUBLE PRECISION,
  lng         DOUBLE PRECISION,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- PAYMENTS & WALLETS
-- ============================================================

-- Driver wallet
CREATE TABLE driver_wallets (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  driver_id           UUID UNIQUE NOT NULL REFERENCES drivers(id),
  balance_ugx         NUMERIC(14,2) DEFAULT 0,
  pending_ugx         NUMERIC(14,2) DEFAULT 0,   -- earned but not yet settled
  total_earned_ugx    NUMERIC(14,2) DEFAULT 0,
  total_withdrawn_ugx NUMERIC(14,2) DEFAULT 0,
  min_withdraw_ugx    NUMERIC(10,2) DEFAULT 50000,
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Driver saved payment methods (for withdrawals)
CREATE TABLE driver_payment_methods (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  driver_id       UUID NOT NULL REFERENCES drivers(id),
  type            payment_method_type NOT NULL,
  display_name    TEXT NOT NULL,
  account_number  TEXT NOT NULL,                 -- encrypted
  account_name    TEXT,
  is_default      BOOLEAN DEFAULT false,
  verified        BOOLEAN DEFAULT false,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Business saved payment methods (for paying Rheo/drivers)
CREATE TABLE business_payment_methods (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id     UUID NOT NULL REFERENCES businesses(id),
  type            payment_method_type NOT NULL,
  display_name    TEXT NOT NULL,
  account_number  TEXT NOT NULL,                 -- encrypted / tokenized
  account_name    TEXT,
  is_default      BOOLEAN DEFAULT false,
  verified        BOOLEAN DEFAULT false,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- All financial transactions (immutable ledger)
CREATE TABLE transactions (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  type                transaction_type NOT NULL,
  status              transaction_status DEFAULT 'pending',

  -- Parties
  driver_id           UUID REFERENCES drivers(id),
  business_id         UUID REFERENCES businesses(id),
  job_id              UUID REFERENCES jobs(id),

  -- Amounts
  amount_ugx          NUMERIC(14,2) NOT NULL,
  fee_ugx             NUMERIC(10,2) DEFAULT 0,
  net_ugx             NUMERIC(14,2) NOT NULL,
  currency            TEXT DEFAULT 'UGX',

  -- Payment provider
  provider            TEXT,                      -- 'mtn_momo', 'airtel', 'flutterwave'
  provider_ref        TEXT,                      -- external transaction ID
  provider_status     TEXT,
  provider_response   JSONB,

  -- Payment method used
  payment_method_id   UUID,                      -- generic ref to driver or business PM

  -- Meta
  description         TEXT,
  reference           TEXT UNIQUE NOT NULL,      -- internal ref e.g. TXN-20240601-0001
  initiated_by        UUID,
  initiated_by_type   TEXT CHECK (initiated_by_type IN ('driver','business','staff','system')),

  -- Timestamps
  initiated_at        TIMESTAMPTZ DEFAULT NOW(),
  completed_at        TIMESTAMPTZ,
  failed_at           TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Driver withdrawal requests
CREATE TABLE withdrawal_requests (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  driver_id           UUID NOT NULL REFERENCES drivers(id),
  wallet_id           UUID NOT NULL REFERENCES driver_wallets(id),
  payment_method_id   UUID NOT NULL REFERENCES driver_payment_methods(id),
  amount_ugx          NUMERIC(12,2) NOT NULL,
  fee_ugx             NUMERIC(10,2) DEFAULT 0,
  net_ugx             NUMERIC(12,2) NOT NULL,
  status              TEXT DEFAULT 'pending' CHECK (status IN (
                        'pending','approved','processing','completed','failed','rejected')),
  approved_by         UUID REFERENCES staff(id),
  approved_at         TIMESTAMPTZ,
  rejection_reason    TEXT,
  transaction_id      UUID REFERENCES transactions(id),
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- SUPPORT TICKETS
-- ============================================================

CREATE TABLE support_tickets (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ticket_ref      TEXT UNIQUE NOT NULL,          -- e.g. TKT-20240601-0001
  subject         TEXT NOT NULL,
  description     TEXT NOT NULL,
  status          ticket_status DEFAULT 'open',
  priority        ticket_priority DEFAULT 'medium',
  category        TEXT,

  -- Raised by (one of the three types)
  raised_by_driver    UUID REFERENCES drivers(id),
  raised_by_member    UUID REFERENCES business_members(id),
  raised_by_staff     UUID REFERENCES staff(id),

  -- Related
  job_id          UUID REFERENCES jobs(id),

  -- Assigned to
  assigned_to     UUID REFERENCES staff(id),
  resolved_at     TIMESTAMPTZ,
  resolution_notes TEXT,

  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE support_messages (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ticket_id   UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  message     TEXT NOT NULL,
  author_id   UUID NOT NULL,
  author_type TEXT NOT NULL CHECK (author_type IN ('driver','business_member','staff')),
  is_internal BOOLEAN DEFAULT false,             -- internal staff notes, hidden from requester
  attachments JSONB DEFAULT '[]',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- NOTIFICATIONS
-- ============================================================

CREATE TABLE notifications (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  type            notification_type NOT NULL,
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  data            JSONB DEFAULT '{}',

  -- Recipient
  recipient_id    UUID NOT NULL,
  recipient_type  TEXT NOT NULL CHECK (recipient_type IN ('driver','business_member','staff')),

  -- Delivery
  send_push       BOOLEAN DEFAULT true,
  send_sms        BOOLEAN DEFAULT false,
  send_email      BOOLEAN DEFAULT false,

  push_sent_at    TIMESTAMPTZ,
  sms_sent_at     TIMESTAMPTZ,
  email_sent_at   TIMESTAMPTZ,

  read_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Push notification tokens
CREATE TABLE push_tokens (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  token       TEXT NOT NULL,
  platform    TEXT CHECK (platform IN ('ios', 'android')),
  is_active   BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, token)
);

-- ============================================================
-- AUDIT LOG — IMMUTABLE, APPEND-ONLY
-- ============================================================

CREATE TABLE audit_logs (
  id              BIGSERIAL PRIMARY KEY,
  actor_id        UUID,
  actor_type      TEXT NOT NULL CHECK (actor_type IN ('staff','driver','business_member','system')),
  actor_role      TEXT,
  action          TEXT NOT NULL,                 -- e.g. 'driver.approve', 'job.cancel'
  resource_type   TEXT,
  resource_id     UUID,
  old_data        JSONB,
  new_data        JSONB,
  ip_address      INET,
  user_agent      TEXT,
  surface         TEXT,
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Audit log must never be modified
CREATE RULE audit_no_update AS ON UPDATE TO audit_logs DO INSTEAD NOTHING;
CREATE RULE audit_no_delete AS ON DELETE TO audit_logs DO INSTEAD NOTHING;

-- ============================================================
-- ANALYTICS SNAPSHOTS (pre-aggregated for dashboard speed)
-- ============================================================

CREATE TABLE business_analytics_daily (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id         UUID NOT NULL REFERENCES businesses(id),
  date                DATE NOT NULL,
  jobs_total          INTEGER DEFAULT 0,
  jobs_delivered      INTEGER DEFAULT 0,
  jobs_failed         INTEGER DEFAULT 0,
  jobs_cancelled      INTEGER DEFAULT 0,
  total_spend_ugx     NUMERIC(14,2) DEFAULT 0,
  avg_delivery_mins   NUMERIC(8,2),
  unique_drivers      INTEGER DEFAULT 0,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(business_id, date)
);

CREATE TABLE platform_analytics_daily (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  date                DATE NOT NULL UNIQUE,
  active_drivers      INTEGER DEFAULT 0,
  active_businesses   INTEGER DEFAULT 0,
  jobs_total          INTEGER DEFAULT 0,
  jobs_delivered      INTEGER DEFAULT 0,
  gross_revenue_ugx   NUMERIC(14,2) DEFAULT 0,
  rheo_revenue_ugx    NUMERIC(14,2) DEFAULT 0,
  driver_payouts_ugx  NUMERIC(14,2) DEFAULT 0,
  new_drivers         INTEGER DEFAULT 0,
  new_businesses      INTEGER DEFAULT 0,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- INDEXES FOR PERFORMANCE
-- ============================================================

-- Auth
CREATE INDEX idx_auth_users_email ON auth_users(email);
CREATE INDEX idx_auth_users_phone ON auth_users(phone);
CREATE INDEX idx_auth_sessions_user ON auth_sessions(user_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_auth_sessions_token ON auth_sessions(refresh_token);

-- Drivers
CREATE INDEX idx_drivers_status ON drivers(status);
CREATE INDEX idx_drivers_online ON drivers(is_online) WHERE is_online = true;
CREATE INDEX idx_drivers_location ON drivers(last_lat, last_lng) WHERE is_online = true;

-- Jobs
CREATE INDEX idx_jobs_business ON jobs(business_id);
CREATE INDEX idx_jobs_driver ON jobs(driver_id);
CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_jobs_created ON jobs(created_at DESC);
CREATE INDEX idx_jobs_ref ON jobs(job_ref);

-- Transactions
CREATE INDEX idx_transactions_driver ON transactions(driver_id);
CREATE INDEX idx_transactions_business ON transactions(business_id);
CREATE INDEX idx_transactions_created ON transactions(created_at DESC);
CREATE INDEX idx_transactions_ref ON transactions(reference);

-- Notifications
CREATE INDEX idx_notifications_recipient ON notifications(recipient_id, recipient_type);
CREATE INDEX idx_notifications_unread ON notifications(recipient_id) WHERE read_at IS NULL;

-- Audit
CREATE INDEX idx_audit_actor ON audit_logs(actor_id);
CREATE INDEX idx_audit_resource ON audit_logs(resource_type, resource_id);
CREATE INDEX idx_audit_created ON audit_logs(created_at DESC);
CREATE INDEX idx_audit_action ON audit_logs(action);

-- Support
CREATE INDEX idx_tickets_status ON support_tickets(status);
CREATE INDEX idx_tickets_assigned ON support_tickets(assigned_to);

-- ============================================================
-- ROW LEVEL SECURITY (Data isolation between businesses)
-- ============================================================

ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_analytics_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_payment_methods ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_kyc_docs ENABLE ROW LEVEL SECURITY;

-- Business members can only see their own business data
CREATE POLICY business_jobs_isolation ON jobs
  USING (business_id = current_setting('app.current_business_id', true)::uuid);

CREATE POLICY business_analytics_isolation ON business_analytics_daily
  USING (business_id = current_setting('app.current_business_id', true)::uuid);

-- ============================================================
-- TRIGGERS — Auto-updated timestamps
-- ============================================================

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_auth_users_updated      BEFORE UPDATE ON auth_users      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_staff_updated           BEFORE UPDATE ON staff           FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_businesses_updated      BEFORE UPDATE ON businesses      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_business_members_updated BEFORE UPDATE ON business_members FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_drivers_updated         BEFORE UPDATE ON drivers         FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_jobs_updated            BEFORE UPDATE ON jobs            FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_subscriptions_updated   BEFORE UPDATE ON business_subscriptions FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_withdrawals_updated     BEFORE UPDATE ON withdrawal_requests FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Auto-generate reference numbers
CREATE OR REPLACE FUNCTION generate_job_ref()
RETURNS TRIGGER AS $$
BEGIN
  NEW.job_ref = 'RHO-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-' ||
                LPAD(NEXTVAL('job_ref_seq')::TEXT, 5, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE SEQUENCE job_ref_seq START 1;
CREATE TRIGGER trg_job_ref BEFORE INSERT ON jobs FOR EACH ROW WHEN (NEW.job_ref IS NULL) EXECUTE FUNCTION generate_job_ref();

CREATE OR REPLACE FUNCTION generate_ticket_ref()
RETURNS TRIGGER AS $$
BEGIN
  NEW.ticket_ref = 'TKT-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-' ||
                   LPAD(NEXTVAL('ticket_ref_seq')::TEXT, 5, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE SEQUENCE ticket_ref_seq START 1;
CREATE TRIGGER trg_ticket_ref BEFORE INSERT ON support_tickets FOR EACH ROW WHEN (NEW.ticket_ref IS NULL) EXECUTE FUNCTION generate_ticket_ref();

-- Auto-create driver wallet on driver insert
CREATE OR REPLACE FUNCTION create_driver_wallet()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO driver_wallets (driver_id) VALUES (NEW.id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_driver_wallet AFTER INSERT ON drivers FOR EACH ROW EXECUTE FUNCTION create_driver_wallet();

-- ============================================================
-- SEED: Subscription plans
-- ============================================================

INSERT INTO subscription_plans (name, display_name, monthly_price_ugx, annual_price_ugx, max_jobs_per_month, max_team_members, api_access, dedicated_support, custom_branding, features) VALUES
('starter',    'Starter',    150000,  1500000,  100,  3,    false, false, false, '["Job board access","Basic analytics","Email support","Mobile app"]'),
('growth',     'Growth',     400000,  4000000,  500,  10,   false, false, false, '["All Starter features","Advanced analytics","Priority support","Bulk job upload","Driver rating filters"]'),
('enterprise', 'Enterprise', 1200000, 11000000, NULL, NULL, true,  true,  true,  '["All Growth features","Unlimited jobs","API access","Dedicated account manager","Custom branding","Webhook integrations","SLA guarantee"]'),
('custom',     'Custom',     NULL,    NULL,      NULL, NULL, true,  true,  true,  '["Tailored to your business","Custom pricing","Full platform access"]');
