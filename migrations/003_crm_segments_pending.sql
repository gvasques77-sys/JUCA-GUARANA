-- ============================================================
-- Migration 003 — Tabela crm_segments (PENDENTE)
-- JUCA GUARANÁ — GV AUTOMAÇÕES
--
-- ATENÇÃO: Esta tabela NÃO existe no banco de produção.
-- O código em campaignService.js referencia esta tabela com
-- try/catch graceful (retorna erro amigável se ausente).
-- Revisar e aplicar manualmente quando segmentos forem implementados.
-- ============================================================

CREATE TABLE IF NOT EXISTS crm_segments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id   UUID NOT NULL REFERENCES clinics(id),
  name        TEXT NOT NULL,
  description TEXT,
  filters     JSONB NOT NULL DEFAULT '{}',
  created_by  UUID,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_segments_clinic ON crm_segments(clinic_id);
ALTER TABLE crm_segments ENABLE ROW LEVEL SECURITY;
