-- =======================================================
-- JUCA GUARANA — Migrações v2 (Melhorias)
-- Data: 2026-03-02
-- Executar no Supabase SQL Editor
-- =======================================================

-- -------------------------------------------------------
-- PRIORIDADE 3 — Deduplicação de Mensagens (Lock Atômico)
-- Adicionar colunas de lock na tabela conversation_state
-- (que é o equivalente a 'sessions' neste projeto)
-- -------------------------------------------------------

ALTER TABLE public.conversation_state
ADD COLUMN IF NOT EXISTS last_processed_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS is_processing BOOLEAN DEFAULT FALSE;

-- Índice para performance na query de lock
CREATE INDEX IF NOT EXISTS idx_conversation_state_lock
ON public.conversation_state (from_number, clinic_id, last_processed_at);

-- -------------------------------------------------------
-- Função atômica de lock para evitar processamento duplicado
-- -------------------------------------------------------

CREATE OR REPLACE FUNCTION acquire_processing_lock(
  p_phone TEXT,
  p_clinic UUID,
  p_cooldown_seconds INT DEFAULT 8
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_acquired BOOLEAN := FALSE;
  v_session_id UUID;
BEGIN
  -- Operação atômica: verifica E atualiza em uma única transação
  UPDATE public.conversation_state
  SET
    last_processed_at = NOW(),
    is_processing = TRUE
  WHERE
    from_number = p_phone
    AND clinic_id = p_clinic
    AND (
      last_processed_at IS NULL
      OR last_processed_at < NOW() - (p_cooldown_seconds || ' seconds')::INTERVAL
      OR is_processing = FALSE
    )
  RETURNING id INTO v_session_id;

  v_acquired := v_session_id IS NOT NULL;

  RETURN jsonb_build_object('acquired', v_acquired, 'session_id', v_session_id);
END;
$$;

-- -------------------------------------------------------
-- Função para liberar o lock após processamento
-- -------------------------------------------------------

CREATE OR REPLACE FUNCTION release_processing_lock(
  p_phone TEXT,
  p_clinic UUID
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public.conversation_state
  SET is_processing = FALSE
  WHERE from_number = p_phone AND clinic_id = p_clinic;
END;
$$;
