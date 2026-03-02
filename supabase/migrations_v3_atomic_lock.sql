-- =======================================================
-- JUCA GUARANA — Migração v3: Lock Atômico via state_json
-- Data: 2026-03-02
-- Executar no Supabase SQL Editor
-- =======================================================
-- Correção P1: Race Condition no Cooldown (causa das boas-vindas duplicadas)
-- Esta função usa UPDATE condicional atômico no state_json da conversation_state
-- em vez do SELECT não-atômico anterior que tinha race condition.
-- =======================================================

CREATE OR REPLACE FUNCTION try_acquire_processing_lock(
  p_clinic_id UUID,
  p_from_number TEXT,
  p_cooldown_seconds INT DEFAULT 10
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  v_rows_updated INT;
BEGIN
  UPDATE conversation_state
  SET
    state_json = jsonb_set(
      COALESCE(state_json, '{}'::jsonb),
      '{last_processed_at}',
      to_jsonb(NOW()::TEXT)
    )
  WHERE
    clinic_id = p_clinic_id
    AND from_number = p_from_number
    AND (
      state_json->>'last_processed_at' IS NULL
      OR (NOW() - (state_json->>'last_processed_at')::TIMESTAMPTZ) >
          (p_cooldown_seconds || ' seconds')::INTERVAL
    );

  GET DIAGNOSTICS v_rows_updated = ROW_COUNT;

  -- Se não atualizou nenhuma linha E o registro existe → lock negado
  -- Se não atualizou E o registro não existe → é novo usuário → permitir
  IF v_rows_updated > 0 THEN
    RETURN TRUE;
  END IF;

  -- Verificar se o registro existe (novo usuário → permitir)
  RETURN NOT EXISTS (
    SELECT 1 FROM conversation_state
    WHERE clinic_id = p_clinic_id AND from_number = p_from_number
  );
END;
$$;
