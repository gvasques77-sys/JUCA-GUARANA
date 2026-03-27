-- ============================================================
-- Migration 004 — Correções do Code Review (Codex)
-- JUCA GUARANÁ — GV AUTOMAÇÕES
-- Criada em: 2026-03-27
-- Status: PENDENTE DE APLICAÇÃO MANUAL via Supabase Studio
-- ============================================================
-- INSTRUÇÃO: Executar no SQL Editor do Supabase Studio.
-- Todos os comandos usam IF EXISTS / IF NOT EXISTS — são idempotentes.
-- ============================================================

-- ============================================================
-- 1. ON DELETE CASCADE na FK de crm_campaign_messages.campaign_id
-- ============================================================
-- Motivo: Garantir atomicidade no rollback de createCampaign.
-- O código em campaignService.js faz:
--   await sb.from('crm_campaigns').delete().eq('id', campaign.id)
-- Se a FK não tiver CASCADE, as mensagens órfãs impedem a deleção da campanha.
-- Com CASCADE, deletar a campanha remove automaticamente todas as mensagens.
-- ============================================================
-- ATENÇÃO: Antes de executar, verifique o nome exato da constraint:
--   SELECT conname FROM pg_constraint
--   WHERE conrelid = 'crm_campaign_messages'::regclass AND contype = 'f';
-- Se o nome for diferente de 'crm_campaign_messages_campaign_id_fkey',
-- substitua no DROP abaixo.
-- ============================================================
ALTER TABLE crm_campaign_messages
DROP CONSTRAINT IF EXISTS crm_campaign_messages_campaign_id_fkey;

ALTER TABLE crm_campaign_messages
ADD CONSTRAINT crm_campaign_messages_campaign_id_fkey
FOREIGN KEY (campaign_id) REFERENCES crm_campaigns(id) ON DELETE CASCADE;

-- ============================================================
-- 2. Partial unique index em clinic_whatsapp_config
-- ============================================================
-- Motivo: whatsappConfigHelper.js usa .maybeSingle() que falha silenciosamente
-- se houver mais de 1 config ativa para a mesma clínica, caindo no fallback
-- de env vars e potencialmente enviando campanhas com credenciais erradas.
-- Este index garante no nível do banco: 1 config ativa por clínica.
-- ============================================================
-- PRÉ-REQUISITO: Verificar se não há duplicados antes de criar:
--   SELECT clinic_id, count(*) FROM clinic_whatsapp_config
--   WHERE is_active = true GROUP BY clinic_id HAVING count(*) > 1;
-- Se retornar linhas, resolver duplicados manualmente antes de continuar.
-- ============================================================
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_active_whatsapp_config
ON clinic_whatsapp_config (clinic_id)
WHERE is_active = true;

-- ============================================================
-- Validação pós-aplicação (executar separadamente para confirmar):
-- ============================================================
-- Verificar FK com CASCADE:
--   SELECT tc.constraint_name, rc.delete_rule
--   FROM information_schema.table_constraints tc
--   JOIN information_schema.referential_constraints rc
--     ON rc.constraint_name = tc.constraint_name
--   WHERE tc.table_name = 'crm_campaign_messages'
--   AND tc.constraint_type = 'FOREIGN KEY';
--   -- Deve retornar delete_rule = 'CASCADE'
--
-- Verificar unique index:
--   SELECT indexname, indexdef FROM pg_indexes
--   WHERE tablename = 'clinic_whatsapp_config'
--   AND indexname = 'idx_unique_active_whatsapp_config';
--   -- Deve retornar 1 linha com o index
