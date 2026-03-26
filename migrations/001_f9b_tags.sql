-- ============================================================
-- Migration 001 — F9B: Tags de Clínica e Pacientes
-- JUCA GUARANÁ — GV AUTOMAÇÕES
-- Aplicada em: produção (Supabase edamtnxcwuuydwwbimvz)
-- ============================================================

-- Tags da clínica (categorias configuráveis)
CREATE TABLE IF NOT EXISTS clinic_tags (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id     UUID NOT NULL REFERENCES clinics(id),
  name          TEXT NOT NULL,
  color         TEXT NOT NULL DEFAULT '#6E9FFF',
  created_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE(clinic_id, name)
);

-- Associação paciente ↔ tag (N:N)
CREATE TABLE IF NOT EXISTS patient_tags (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id     UUID NOT NULL REFERENCES clinics(id),
  patient_id    UUID NOT NULL REFERENCES patients(id),
  tag_id        UUID NOT NULL REFERENCES clinic_tags(id),
  created_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE(clinic_id, patient_id, tag_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_clinic_tags_clinic ON clinic_tags(clinic_id);
CREATE INDEX IF NOT EXISTS idx_patient_tags_clinic_patient ON patient_tags(clinic_id, patient_id);
CREATE INDEX IF NOT EXISTS idx_patient_tags_tag ON patient_tags(tag_id);

-- RLS
ALTER TABLE clinic_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient_tags ENABLE ROW LEVEL SECURITY;
