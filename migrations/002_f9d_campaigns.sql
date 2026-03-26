-- ============================================================
-- Migration 002 — F9D: Campanhas WhatsApp Multi-Tenant
-- JUCA GUARANÁ — GV AUTOMAÇÕES
-- Aplicada em: produção (Supabase edamtnxcwuuydwwbimvz)
-- ============================================================

-- Configuração WhatsApp por clínica
CREATE TABLE IF NOT EXISTS clinic_whatsapp_config (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id             UUID NOT NULL REFERENCES clinics(id),
  phone_number_id       TEXT NOT NULL,
  access_token          TEXT NOT NULL,
  business_account_id   TEXT NOT NULL,
  display_phone         TEXT,
  display_name          TEXT,
  webhook_verify_token  TEXT,
  is_active             BOOLEAN DEFAULT TRUE,
  last_verified_at      TIMESTAMPTZ,
  verification_status   TEXT DEFAULT 'pending',
  messaging_tier        TEXT DEFAULT 'tier_1',
  daily_limit           INTEGER DEFAULT 250,
  created_at            TIMESTAMPTZ DEFAULT now(),
  updated_at            TIMESTAMPTZ DEFAULT now()
);

-- Campanhas
CREATE TABLE IF NOT EXISTS crm_campaigns (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id           UUID NOT NULL REFERENCES clinics(id),
  name                TEXT NOT NULL,
  description         TEXT,
  template_name       TEXT NOT NULL,
  template_language   TEXT NOT NULL DEFAULT 'pt_BR',
  template_category   TEXT,
  template_components JSONB,
  segment_id          UUID,
  audience_snapshot   JSONB,
  total_recipients    INTEGER DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'draft',
  scheduled_at        TIMESTAMPTZ,
  started_at          TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  sent_count          INTEGER DEFAULT 0,
  delivered_count     INTEGER DEFAULT 0,
  read_count          INTEGER DEFAULT 0,
  failed_count        INTEGER DEFAULT 0,
  created_by          UUID NOT NULL,
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now()
);

-- Mensagens individuais de campanha
CREATE TABLE IF NOT EXISTS crm_campaign_messages (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id   UUID NOT NULL REFERENCES crm_campaigns(id),
  clinic_id     UUID NOT NULL REFERENCES clinics(id),
  patient_id    UUID NOT NULL REFERENCES patients(id),
  phone         TEXT NOT NULL,
  wamid         TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  error_code    TEXT,
  error_message TEXT,
  sent_at       TIMESTAMPTZ,
  delivered_at  TIMESTAMPTZ,
  read_at       TIMESTAMPTZ,
  failed_at     TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_whatsapp_config_clinic ON clinic_whatsapp_config(clinic_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_clinic ON crm_campaigns(clinic_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_status ON crm_campaigns(status);
CREATE INDEX IF NOT EXISTS idx_campaign_messages_campaign ON crm_campaign_messages(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_messages_wamid ON crm_campaign_messages(wamid);
CREATE INDEX IF NOT EXISTS idx_campaign_messages_clinic ON crm_campaign_messages(clinic_id);

-- RLS
ALTER TABLE clinic_whatsapp_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_campaign_messages ENABLE ROW LEVEL SECURITY;
