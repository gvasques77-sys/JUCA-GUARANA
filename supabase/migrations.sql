-- =======================================================
-- JUCA GUARANA — Migração Multi-tenant + RLS
-- Ticket: JG-P0-006 + JG-P1-007
-- Execute este script no Supabase SQL Editor
-- =======================================================

-- -------------------------------------------------------
-- PARTE 1: Adicionar clinic_id a todas as tabelas
-- (pule colunas que já existem — sem IF NOT EXISTS no Supabase)
-- -------------------------------------------------------

-- 1.1 doctors
ALTER TABLE public.doctors
  ADD COLUMN IF NOT EXISTS clinic_id UUID REFERENCES public.clinic_settings(clinic_id) ON DELETE CASCADE;

-- 1.2 services
ALTER TABLE public.services
  ADD COLUMN IF NOT EXISTS clinic_id UUID REFERENCES public.clinic_settings(clinic_id) ON DELETE CASCADE;

-- 1.3 patients
ALTER TABLE public.patients
  ADD COLUMN IF NOT EXISTS clinic_id UUID REFERENCES public.clinic_settings(clinic_id) ON DELETE CASCADE;

-- 1.4 appointments (se não tiver)
ALTER TABLE public.appointments
  ADD COLUMN IF NOT EXISTS clinic_id UUID REFERENCES public.clinic_settings(clinic_id) ON DELETE CASCADE;

-- 1.5 schedules
ALTER TABLE public.schedules
  ADD COLUMN IF NOT EXISTS clinic_id UUID REFERENCES public.clinic_settings(clinic_id) ON DELETE CASCADE;

-- 1.6 schedule_blocks
ALTER TABLE public.schedule_blocks
  ADD COLUMN IF NOT EXISTS clinic_id UUID REFERENCES public.clinic_settings(clinic_id) ON DELETE CASCADE;

-- 1.7 doctor_services (tabela de relação)
ALTER TABLE public.doctor_services
  ADD COLUMN IF NOT EXISTS clinic_id UUID REFERENCES public.clinic_settings(clinic_id) ON DELETE CASCADE;

-- -------------------------------------------------------
-- PARTE 2: Índices para performance multi-tenant
-- -------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_doctors_clinic_id ON public.doctors(clinic_id);
CREATE INDEX IF NOT EXISTS idx_services_clinic_id ON public.services(clinic_id);
CREATE INDEX IF NOT EXISTS idx_patients_clinic_id ON public.patients(clinic_id);
CREATE INDEX IF NOT EXISTS idx_appointments_clinic_id ON public.appointments(clinic_id);
CREATE INDEX IF NOT EXISTS idx_appointments_clinic_date ON public.appointments(clinic_id, appointment_date);
CREATE INDEX IF NOT EXISTS idx_agent_logs_clinic_id ON public.agent_logs(clinic_id);
CREATE INDEX IF NOT EXISTS idx_schedules_clinic_id ON public.schedules(clinic_id);

-- -------------------------------------------------------
-- PARTE 3: Habilitar RLS em todas as tabelas (JG-P0-006)
-- -------------------------------------------------------
ALTER TABLE public.clinic_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clinic_kb ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.doctors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.services ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.schedule_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.doctor_services ENABLE ROW LEVEL SECURITY;

-- -------------------------------------------------------
-- PARTE 4: Policies RLS por service_role (acesso total do backend)
-- O service_role key do Supabase ignora RLS por padrão,
-- mas as policies abaixo protegem o acesso anon/authenticated.
-- -------------------------------------------------------

-- 4.1 clinic_settings — somente a própria clínica
DROP POLICY IF EXISTS "clinic_settings_isolation" ON public.clinic_settings;
CREATE POLICY "clinic_settings_isolation"
  ON public.clinic_settings
  FOR ALL
  USING (
    -- service_role sempre passa; authenticated só vê a própria clínica
    auth.role() = 'service_role'
    OR clinic_id = (current_setting('app.clinic_id', true))::uuid
  );

-- 4.2 clinic_kb
DROP POLICY IF EXISTS "clinic_kb_isolation" ON public.clinic_kb;
CREATE POLICY "clinic_kb_isolation"
  ON public.clinic_kb
  FOR ALL
  USING (
    auth.role() = 'service_role'
    OR clinic_id = (current_setting('app.clinic_id', true))::uuid
  );

-- 4.3 doctors
DROP POLICY IF EXISTS "doctors_isolation" ON public.doctors;
CREATE POLICY "doctors_isolation"
  ON public.doctors
  FOR ALL
  USING (
    auth.role() = 'service_role'
    OR clinic_id = (current_setting('app.clinic_id', true))::uuid
  );

-- 4.4 services
DROP POLICY IF EXISTS "services_isolation" ON public.services;
CREATE POLICY "services_isolation"
  ON public.services
  FOR ALL
  USING (
    auth.role() = 'service_role'
    OR clinic_id = (current_setting('app.clinic_id', true))::uuid
  );

-- 4.5 patients
DROP POLICY IF EXISTS "patients_isolation" ON public.patients;
CREATE POLICY "patients_isolation"
  ON public.patients
  FOR ALL
  USING (
    auth.role() = 'service_role'
    OR clinic_id = (current_setting('app.clinic_id', true))::uuid
  );

-- 4.6 appointments
DROP POLICY IF EXISTS "appointments_isolation" ON public.appointments;
CREATE POLICY "appointments_isolation"
  ON public.appointments
  FOR ALL
  USING (
    auth.role() = 'service_role'
    OR clinic_id = (current_setting('app.clinic_id', true))::uuid
  );

-- 4.7 agent_logs
DROP POLICY IF EXISTS "agent_logs_isolation" ON public.agent_logs;
CREATE POLICY "agent_logs_isolation"
  ON public.agent_logs
  FOR ALL
  USING (
    auth.role() = 'service_role'
    OR clinic_id = (current_setting('app.clinic_id', true))::uuid
  );

-- 4.8 schedules
DROP POLICY IF EXISTS "schedules_isolation" ON public.schedules;
CREATE POLICY "schedules_isolation"
  ON public.schedules
  FOR ALL
  USING (
    auth.role() = 'service_role'
    OR clinic_id = (current_setting('app.clinic_id', true))::uuid
  );

-- 4.9 schedule_blocks
DROP POLICY IF EXISTS "schedule_blocks_isolation" ON public.schedule_blocks;
CREATE POLICY "schedule_blocks_isolation"
  ON public.schedule_blocks
  FOR ALL
  USING (
    auth.role() = 'service_role'
    OR clinic_id = (current_setting('app.clinic_id', true))::uuid
  );

-- 4.10 doctor_services
DROP POLICY IF EXISTS "doctor_services_isolation" ON public.doctor_services;
CREATE POLICY "doctor_services_isolation"
  ON public.doctor_services
  FOR ALL
  USING (
    auth.role() = 'service_role'
    OR clinic_id = (current_setting('app.clinic_id', true))::uuid
  );

-- -------------------------------------------------------
-- PARTE 5: Negar acesso anon a colunas sensíveis
-- -------------------------------------------------------

-- Revogar acesso público a tabelas clínicas
REVOKE SELECT ON public.patients FROM anon;
REVOKE INSERT ON public.patients FROM anon;
REVOKE UPDATE ON public.patients FROM anon;
REVOKE DELETE ON public.patients FROM anon;

REVOKE SELECT ON public.appointments FROM anon;
REVOKE INSERT ON public.appointments FROM anon;
REVOKE UPDATE ON public.appointments FROM anon;
REVOKE DELETE ON public.appointments FROM anon;

REVOKE SELECT ON public.clinic_settings FROM anon;
REVOKE SELECT ON public.clinic_kb FROM anon;
REVOKE SELECT ON public.agent_logs FROM anon;

-- -------------------------------------------------------
-- PARTE 6: Verificação pós-migração
-- -------------------------------------------------------
-- Execute para confirmar que RLS está habilitado:
-- SELECT tablename, rowsecurity FROM pg_tables
--   WHERE schemaname = 'public'
--   ORDER BY tablename;
--
-- Esperado: rowsecurity = true para todas as tabelas acima.

-- =======================================================
-- PARTE 7: Adicionar colunas para knowledge gap logging
-- Ticket: ALT3 — robust memory + knowledge gap logging
-- =======================================================

ALTER TABLE public.agent_logs
  ADD COLUMN IF NOT EXISTS log_type VARCHAR(50) DEFAULT 'intent',
  ADD COLUMN IF NOT EXISTS extra_data JSONB;

CREATE INDEX IF NOT EXISTS idx_agent_logs_log_type
  ON public.agent_logs(clinic_id, log_type, created_at DESC);

-- =======================================================
-- PARTE 8: Dados iniciais de clinic_kb (convênios, políticas)
-- ATENÇÃO: substitua <CLINIC_ID> pelo UUID real da clínica
--          antes de executar. Exemplo:
--          09e5240f-9c26-47ee-a54d-02934a36ebfd
-- Execute apenas UMA VEZ por clínica.
-- =======================================================

-- INSERT INTO public.clinic_kb (clinic_id, title, content)
-- VALUES
--   ('<CLINIC_ID>', 'Convênios Aceitos', 'Aceitamos os seguintes planos de saúde: Unimed, Bradesco Saúde, SulAmérica, Amil e Porto Seguro. Não aceitamos planos municipais ou estaduais. Consultas particulares também são bem-vindas.'),
--   ('<CLINIC_ID>', 'Política de Cancelamento', 'Cancelamentos devem ser feitos com pelo menos 24 horas de antecedência. Faltas sem aviso podem acarretar cobrança de taxa.'),
--   ('<CLINIC_ID>', 'Documentos Necessários', 'Traga documento de identidade, cartão do convênio (se houver) e pedido médico quando necessário.');

-- =======================================================
-- PARTE 9: Tabela conversation_state (estado persistente)
-- Ticket: Estado Persistente — Single Source of Truth
-- Execute este bloco no Supabase SQL Editor
-- =======================================================

CREATE TABLE IF NOT EXISTS public.conversation_state (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id   UUID NOT NULL REFERENCES public.clinic_settings(clinic_id) ON DELETE CASCADE,
  from_number VARCHAR(50) NOT NULL,
  state_json  JSONB NOT NULL DEFAULT '{}',
  turn_count  INTEGER DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  expires_at  TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '24 hours'),
  UNIQUE(clinic_id, from_number)
);

CREATE INDEX IF NOT EXISTS idx_conversation_state_lookup
  ON public.conversation_state(clinic_id, from_number);

CREATE INDEX IF NOT EXISTS idx_conversation_state_expires
  ON public.conversation_state(expires_at);

-- RLS
ALTER TABLE public.conversation_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "conversation_state_isolation" ON public.conversation_state;
CREATE POLICY "conversation_state_isolation"
  ON public.conversation_state
  FOR ALL
  USING (
    auth.role() = 'service_role'
    OR clinic_id = (current_setting('app.clinic_id', true))::uuid
  );

-- Trigger para atualizar updated_at automaticamente
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  NEW.turn_count = OLD.turn_count + 1;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_conversation_state_updated_at ON public.conversation_state;
CREATE TRIGGER trg_conversation_state_updated_at
  BEFORE UPDATE ON public.conversation_state
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- =======================================================
-- PARTE 10: Guard Rails Determinísticos + State Machine
-- Ticket: Guard Rails + BOOKING_STATES + agent_decision_logs
-- Execute este bloco no Supabase SQL Editor
-- =======================================================

-- 10.1 Novos campos ao conversation_state via state_json JSONB
-- (booking_state, running_summary, last_activity_at são campos do state_json — sem ALTER TABLE necessário)
-- Registrar índice adicional para consulta por booking_state
CREATE INDEX IF NOT EXISTS idx_conversation_state_updated
  ON public.conversation_state(updated_at);

-- 10.2 Tabela de logs de decisões do agente (observabilidade)
CREATE TABLE IF NOT EXISTS public.agent_decision_logs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id     UUID REFERENCES public.clinic_settings(clinic_id) ON DELETE CASCADE,
  from_number   TEXT NOT NULL,
  decision_type TEXT NOT NULL, -- 'interceptor_trigger' | 'state_transition' | 'tool_forced' | 'tool_validated' | 'session_timeout' | 'confirmation'
  details       JSONB,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Índice para consulta por conversa
CREATE INDEX IF NOT EXISTS idx_agent_decision_logs_number
  ON public.agent_decision_logs(from_number, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_decision_logs_clinic
  ON public.agent_decision_logs(clinic_id, created_at DESC);

-- RLS
ALTER TABLE public.agent_decision_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "agent_decision_logs_isolation" ON public.agent_decision_logs;
CREATE POLICY "agent_decision_logs_isolation"
  ON public.agent_decision_logs
  FOR ALL
  USING (
    auth.role() = 'service_role'
    OR clinic_id = (current_setting('app.clinic_id', true))::uuid
  );
