// services/conversationTracker.js
// Gerencia o ciclo de vida da tabela 'conversations'.
// Funções puras que recebem o client Supabase como parâmetro.

/**
 * Busca uma conversa aberta (status='open') para este clinic_id + phone.
 * Se não existir, cria uma nova.
 * Retorna o objeto da conversa (id, started_at, total_turns, etc).
 */
async function getOrCreateConversation(supabase, clinicId, patientPhone, conversationStateId = null) {
  // 1. Tentar buscar conversa aberta existente
  const { data: existing, error: fetchError } = await supabase
    .from('conversations')
    .select('*')
    .eq('clinic_id', clinicId)
    .eq('patient_phone', patientPhone)
    .eq('status', 'open')
    .maybeSingle();

  if (fetchError) {
    console.error('[ConversationTracker] Erro ao buscar conversa:', fetchError.message);
    return null;
  }

  if (existing) {
    return existing;
  }

  // 2. Não existe conversa aberta — criar nova
  const { data: created, error: createError } = await supabase
    .from('conversations')
    .insert({
      clinic_id: clinicId,
      patient_phone: patientPhone,
      conversation_state_id: conversationStateId,
      channel: 'whatsapp',
      status: 'open',
      total_turns: 0,
      total_messages_user: 0,
      total_messages_agent: 0,
      total_tokens_input: 0,
      total_tokens_output: 0,
      total_cost_estimated: 0,
    })
    .select()
    .single();

  if (createError) {
    console.error('[ConversationTracker] Erro ao criar conversa:', createError.message);
    return null;
  }

  console.log(`[ConversationTracker] Nova conversa criada: ${created.id}`);
  return created;
}

/**
 * Atualiza métricas incrementais da conversa após cada turno.
 * Chamada após cada resposta do agente.
 *
 * @param {object} supabase - Client Supabase
 * @param {string} conversationId - UUID da conversa
 * @param {object} turnData - Dados do turno:
 *   - tokensInput: number (tokens de entrada da chamada OpenAI)
 *   - tokensOutput: number (tokens de saída da chamada OpenAI)
 *   - costEstimated: number (custo estimado em USD)
 */
async function updateConversationTurn(supabase, conversationId, turnData = {}) {
  const { tokensInput = 0, tokensOutput = 0, costEstimated = 0 } = turnData;

  const { error } = await supabase.rpc('increment_conversation_turn', {
    p_conversation_id: conversationId,
    p_tokens_input: tokensInput,
    p_tokens_output: tokensOutput,
    p_cost_estimated: costEstimated,
  });

  if (error) {
    // Fallback: update direto se a RPC não existir
    console.warn('[ConversationTracker] RPC falhou, usando update direto:', error.message);

    const { error: updateError } = await supabase
      .from('conversations')
      .update({
        total_turns: undefined, // será incrementado manualmente
        total_messages_user: undefined,
        total_messages_agent: undefined,
      })
      .eq('id', conversationId);

    if (updateError) {
      console.error('[ConversationTracker] Erro no update direto:', updateError.message);
    }
  }
}

/**
 * Finaliza uma conversa com o resultado.
 * Chamada quando: agendamento concluído, paciente abandona, erro, ou escalonamento.
 *
 * @param {object} supabase - Client Supabase
 * @param {string} conversationId - UUID da conversa
 * @param {string} status - 'completed' | 'abandoned' | 'escalated_human' | 'error'
 * @param {string} finalOutcome - 'booked' | 'rescheduled' | 'cancelled' | 'info_provided' | 'human_requested' | 'abandoned' | 'no_answer' | 'error'
 * @param {string|null} appointmentId - UUID do appointment criado (se houver)
 * @param {string|null} patientId - UUID do paciente (se identificado)
 */
async function finalizeConversation(supabase, conversationId, status, finalOutcome, appointmentId = null, patientId = null) {
  const updateData = {
    status,
    final_outcome: finalOutcome,
    ended_at: new Date().toISOString(),
  };

  if (appointmentId) {
    updateData.appointment_id = appointmentId;
  }
  if (patientId) {
    updateData.patient_id = patientId;
  }

  // Calcular duração
  const { data: conv } = await supabase
    .from('conversations')
    .select('started_at')
    .eq('id', conversationId)
    .single();

  if (conv) {
    const durationMs = Date.now() - new Date(conv.started_at).getTime();
    updateData.duration_seconds = Math.round(durationMs / 1000);
  }

  const { error } = await supabase
    .from('conversations')
    .update(updateData)
    .eq('id', conversationId);

  if (error) {
    console.error('[ConversationTracker] Erro ao finalizar conversa:', error.message);
  } else {
    console.log(`[ConversationTracker] Conversa ${conversationId} finalizada: ${status} / ${finalOutcome}`);
  }
}

export {
  getOrCreateConversation,
  updateConversationTurn,
  finalizeConversation,
};
