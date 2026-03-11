/**
 * CRM V2 Service — Módulo Event-Centric para JUCA GUARANÁ
 * 
 * Arquitetura: Eventos imutáveis → Projeções derivadas → Tarefas
 * 
 * REGRAS ABSOLUTAS:
 * - NUNCA faz throw — se falhar, retorna { success: false }
 * - Toda inserção usa ON CONFLICT DO NOTHING (idempotência)
 * - Prefixo [CRM] em todos os logs
 * - Recebe supabase client como parâmetro (não cria instância própria)
 */

// ======================================================
// CATÁLOGO DE EVENTOS (referência — usado para validação)
// ======================================================
const VALID_EVENT_TYPES = [
  'first_contact',
  'triage_started',
  'intent_detected',
  'booking_requested',
  'booking_created',
  'booking_confirmed',
  'booking_canceled',
  'appointment_completed',
  'no_show',
  'follow_up_created',
  'follow_up_completed',
  'reactivation_started',
  'returning_patient_detected',
  'conversation_ended',
  'info_requested',
  'note_added',
  'tag_added',
  'stage_override',
];

// ======================================================
// CATÁLOGO DE TIPOS DE TAREFAS
// ======================================================
const VALID_TASK_TYPES = [
  'reminder_24h',
  'post_consultation',
  'reactivation',
  'no_show_recovery',
  'booking_confirmation',
  'custom',
];

// ======================================================
// 1. emitEvent — Função FUNDAMENTAL do CRM V2
// ======================================================

/**
 * Registra um evento imutável no CRM.
 * Toda ação relevante do paciente se torna um evento.
 * Idempotente: duplicatas são ignoradas silenciosamente.
 *
 * @param {object} supabase - Cliente Supabase
 * @param {string} clinicId - UUID da clínica
 * @param {string} patientId - UUID do paciente
 * @param {string} eventType - Tipo do evento (do catálogo)
 * @param {object} options - Opções adicionais
 * @param {string} [options.conversationId] - UUID da conversa
 * @param {string} [options.appointmentId] - UUID do agendamento
 * @param {string} [options.sourceSystem='agent'] - Sistema de origem
 * @param {string} [options.sourceReference] - Referência de origem
 * @param {string} [options.idempotencyQualifier] - Qualificador da chave de idempotência
 * @param {object} [options.payload={}] - Dados adicionais do evento
 * @returns {Promise<{success: boolean, eventId?: string, deduplicated?: boolean, error?: string}>}
 */
async function emitEvent(supabase, clinicId, patientId, eventType, options = {}) {
  try {
    // Validar event_type contra o catálogo
    if (!VALID_EVENT_TYPES.includes(eventType)) {
      console.warn(`[CRM] event_type desconhecido: '${eventType}' — registrando mesmo assim`);
    }

    const {
      conversationId = null,
      appointmentId = null,
      sourceSystem = 'agent',
      sourceReference = null,
      idempotencyQualifier = null,
      payload = {},
    } = options;

    // Montar chave de idempotência
    // Formato: event_type:clinic_id:qualifier
    const qualifier = idempotencyQualifier || patientId;
    const idempotencyKey = `${eventType}:${clinicId}:${qualifier}`;

    // Inserir evento — ON CONFLICT ignora duplicatas
    const { data, error } = await supabase
      .from('crm_events')
      .insert({
        clinic_id: clinicId,
        patient_id: patientId,
        conversation_id: conversationId,
        appointment_id: appointmentId,
        event_type: eventType,
        source_system: sourceSystem,
        source_reference: sourceReference,
        idempotency_key: idempotencyKey,
        occurred_at: new Date().toISOString(),
        payload: payload,
      })
      .select('id');

    // Verificar se é duplicata (unique_violation = código 23505)
    if (error) {
      if (error.code === '23505') {
        console.log(`[CRM] Evento deduplicado: ${eventType} (key: ${idempotencyKey})`);
        return { success: true, deduplicated: true };
      }
      console.error(`[CRM] Erro ao inserir evento ${eventType}:`, error.message);
      return { success: false, error: error.message };
    }

    const eventId = data?.[0]?.id || null;
    console.log(`[CRM] Evento registrado: ${eventType} (id: ${eventId})`);

    // Recalcular projeção do paciente a partir dos eventos
    try {
      await supabase.rpc('fn_recalculate_patient_projection', {
        p_patient_id: patientId,
      });
      console.log(`[CRM] Projeção recalculada para patient_id: ${patientId}`);
    } catch (rpcErr) {
      // Falha no recálculo não invalida o evento já registrado
      console.error(`[CRM] Erro ao recalcular projeção:`, rpcErr.message);
    }

    return { success: true, eventId, deduplicated: false };
  } catch (error) {
    console.error(`[CRM] Erro em emitEvent (${eventType}):`, error.message);
    return { success: false, error: error.message };
  }
}

// ======================================================
// 2. scheduleTask — Agendar tarefa com idempotência
// ======================================================

/**
 * Cria uma tarefa no CRM (follow-up, lembrete, reativação, etc.).
 * Idempotente: duplicatas são ignoradas silenciosamente.
 *
 * @param {object} supabase - Cliente Supabase
 * @param {string} clinicId - UUID da clínica
 * @param {string} patientId - UUID do paciente
 * @param {string} taskType - Tipo da tarefa (do catálogo)
 * @param {string|Date} dueAt - Data/hora de execução
 * @param {object} options - Opções adicionais
 * @param {string} [options.reason] - Motivo da tarefa
 * @param {string} [options.sourceEventId] - UUID do evento que gerou a tarefa
 * @param {string} [options.messageTemplate] - Template de mensagem para envio
 * @param {string} [options.idempotencyQualifier] - Qualificador da chave
 * @returns {Promise<{success: boolean, taskId?: string, deduplicated?: boolean, error?: string}>}
 */
async function scheduleTask(supabase, clinicId, patientId, taskType, dueAt, options = {}) {
  try {
    // Validar task_type
    if (!VALID_TASK_TYPES.includes(taskType)) {
      console.warn(`[CRM] task_type desconhecido: '${taskType}' — registrando mesmo assim`);
    }

    const {
      reason = null,
      sourceEventId = null,
      messageTemplate = null,
      idempotencyQualifier = null,
    } = options;

    // Normalizar dueAt para ISO string
    const dueAtIso = dueAt instanceof Date ? dueAt.toISOString() : dueAt;
    const dueAtDatePart = dueAtIso.split('T')[0];

    // Montar chave de idempotência
    // Formato: task_type:patient_id:qualifier_ou_data
    const qualifier = idempotencyQualifier || dueAtDatePart;
    const idempotencyKey = `${taskType}:${patientId}:${qualifier}`;

    // Inserir tarefa — ON CONFLICT ignora duplicatas
    const { data, error } = await supabase
      .from('crm_tasks')
      .insert({
        clinic_id: clinicId,
        patient_id: patientId,
        task_type: taskType,
        reason: reason,
        due_at: dueAtIso,
        status: 'pending',
        source_event_id: sourceEventId,
        idempotency_key: idempotencyKey,
        message_template: messageTemplate,
      })
      .select('id');

    // Verificar duplicata
    if (error) {
      if (error.code === '23505') {
        console.log(`[CRM] Tarefa deduplicada: ${taskType} (key: ${idempotencyKey})`);
        return { success: true, deduplicated: true };
      }
      console.error(`[CRM] Erro ao inserir tarefa ${taskType}:`, error.message);
      return { success: false, error: error.message };
    }

    const taskId = data?.[0]?.id || null;
    console.log(`[CRM] Tarefa criada: ${taskType} para ${dueAtDatePart} (id: ${taskId})`);

    // Atualizar next_follow_up_at na projeção se esta tarefa é mais próxima
    try {
      const { data: projection } = await supabase
        .from('patient_crm_projection')
        .select('next_follow_up_at')
        .eq('patient_id', patientId)
        .eq('clinic_id', clinicId)
        .single();

      const currentNext = projection?.next_follow_up_at
        ? new Date(projection.next_follow_up_at)
        : null;
      const newDue = new Date(dueAtIso);

      if (!currentNext || newDue < currentNext) {
        await supabase
          .from('patient_crm_projection')
          .update({ next_follow_up_at: dueAtIso, updated_at: new Date().toISOString() })
          .eq('patient_id', patientId)
          .eq('clinic_id', clinicId);
        console.log(`[CRM] next_follow_up_at atualizado para ${dueAtDatePart}`);
      }
    } catch (projErr) {
      // Não crítico — a tarefa já foi criada
      console.warn(`[CRM] Erro ao atualizar next_follow_up_at:`, projErr.message);
    }

    return { success: true, taskId, deduplicated: false };
  } catch (error) {
    console.error(`[CRM] Erro em scheduleTask (${taskType}):`, error.message);
    return { success: false, error: error.message };
  }
}

// ======================================================
// 3. calculateLeadScore — Pontuação do lead
// ======================================================

/**
 * Calcula e atualiza o lead_score do paciente na projeção CRM.
 * Baseado em engajamento, comparecimento e recência.
 *
 * @param {object} supabase - Cliente Supabase
 * @param {string} patientId - UUID do paciente
 * @param {string} clinicId - UUID da clínica
 * @returns {Promise<{success: boolean, score?: number, error?: string}>}
 */
async function calculateLeadScore(supabase, patientId, clinicId) {
  try {
    let score = 0;

    // Buscar dados agregados dos eventos do paciente
    const { data: events, error: eventsErr } = await supabase
      .from('crm_events')
      .select('event_type, occurred_at')
      .eq('patient_id', patientId)
      .eq('clinic_id', clinicId);

    if (eventsErr) {
      console.error(`[CRM] Erro ao buscar eventos para lead_score:`, eventsErr.message);
      return { success: false, error: eventsErr.message };
    }

    const eventTypes = (events || []).map(e => e.event_type);
    const eventDates = (events || []).map(e => new Date(e.occurred_at));

    // +30 — Tem agendamento confirmado
    if (eventTypes.includes('booking_created') || eventTypes.includes('booking_confirmed')) {
      score += 30;
    }

    // +20 por consulta comparecida (máx +40)
    const attendedCount = eventTypes.filter(t => t === 'appointment_completed').length;
    score += Math.min(attendedCount * 20, 40);

    // +15 — Último contato nas últimas 48h
    const now = new Date();
    const recentThreshold = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    const hasRecentContact = eventDates.some(d => d > recentThreshold);
    if (hasRecentContact) {
      score += 15;
    }

    // +15 — Nunca deu no-show
    const hasNoShow = eventTypes.includes('no_show');
    if (!hasNoShow) {
      score += 15;
    }

    // +10 — Total de conversas > 3 (engajamento alto)
    const conversationEvents = eventTypes.filter(t =>
      ['first_contact', 'conversation_ended', 'info_requested', 'booking_requested'].includes(t)
    );
    if (conversationEvents.length > 3) {
      score += 10;
    }

    // Limitar score a 0-100
    score = Math.max(0, Math.min(100, score));

    // Atualizar na projeção
    const { error: updateErr } = await supabase
      .from('patient_crm_projection')
      .update({ lead_score: score, updated_at: new Date().toISOString() })
      .eq('patient_id', patientId)
      .eq('clinic_id', clinicId);

    if (updateErr) {
      console.error(`[CRM] Erro ao atualizar lead_score:`, updateErr.message);
      return { success: false, error: updateErr.message };
    }

    console.log(`[CRM] Lead score calculado: ${score} (patient_id: ${patientId})`);
    return { success: true, score };
  } catch (error) {
    console.error(`[CRM] Erro em calculateLeadScore:`, error.message);
    return { success: false, error: error.message };
  }
}

// ======================================================
// 4. processPostConversation — Orquestrador principal
// ======================================================

/**
 * Função PRINCIPAL chamada após o agente terminar de processar.
 * Orquestra emitEvent e scheduleTask baseado no outcome da conversa.
 * 
 * IMPORTANTE: Esta função é fire-and-forget. Nunca deve bloquear
 * a resposta ao paciente nem derrubar o agente.
 *
 * @param {object} supabase - Cliente Supabase
 * @param {string} patientPhone - Telefone do paciente
 * @param {string} clinicId - UUID da clínica
 * @param {string} conversationOutcome - Outcome: booked, completed, cancelled, no_show, abandoned, info_provided, conversation
 * @param {string|null} conversationId - UUID da conversa (tabela conversations)
 * @param {string|null} appointmentId - UUID do agendamento (se houver)
 * @returns {Promise<{success: boolean, skipped?: boolean, outcome?: string, error?: string}>}
 */
async function processPostConversation(supabase, patientPhone, clinicId, conversationOutcome, conversationId = null, appointmentId = null) {
  try {
    // 1. Buscar patient_id pelo telefone
    const { data: patientData, error: patientErr } = await supabase
      .from('patients')
      .select('id')
      .eq('clinic_id', clinicId)
      .eq('phone', patientPhone)
      .limit(1)
      .single();

    if (patientErr || !patientData) {
      // Paciente não encontrado — não é erro, pode ser um contato novo sem cadastro
      console.log(`[CRM] Paciente não encontrado para phone: ${patientPhone} — pulando CRM hooks`);
      return { success: true, skipped: true, reason: 'patient_not_found' };
    }

    const patientId = patientData.id;
    console.log(`[CRM] processPostConversation: outcome=${conversationOutcome}, patient_id=${patientId}`);

    // 2. Orquestrar por outcome
    switch (conversationOutcome) {
      case 'booked': {
        // Agendamento criado com sucesso
        const eventResult = await emitEvent(supabase, clinicId, patientId, 'booking_created', {
          conversationId,
          appointmentId,
          idempotencyQualifier: appointmentId || conversationId || patientId,
          payload: { outcome: 'booked' },
        });

        // Agendar lembrete 24h antes (se tiver appointmentId, buscar data)
        if (appointmentId) {
          try {
            const { data: appt } = await supabase
              .from('appointments')
              .select('appointment_date, start_time')
              .eq('id', appointmentId)
              .single();

            if (appt?.appointment_date) {
              const apptDateTime = new Date(`${appt.appointment_date}T${appt.start_time || '08:00'}:00`);
              const reminder24h = new Date(apptDateTime.getTime() - 24 * 60 * 60 * 1000);

              // Só agendar se o lembrete for no futuro
              if (reminder24h > new Date()) {
                await scheduleTask(supabase, clinicId, patientId, 'reminder_24h', reminder24h, {
                  reason: 'Lembrete automático 24h antes da consulta',
                  sourceEventId: eventResult.eventId || null,
                  idempotencyQualifier: appointmentId,
                  messageTemplate: 'Olá! Lembrando da sua consulta amanhã. Confirma presença?',
                });
              }
            }
          } catch (apptErr) {
            console.warn(`[CRM] Erro ao buscar appointment para reminder:`, apptErr.message);
          }
        }

        // Agendar confirmação 2h depois
        const confirmation2h = new Date(Date.now() + 2 * 60 * 60 * 1000);
        await scheduleTask(supabase, clinicId, patientId, 'booking_confirmation', confirmation2h, {
          reason: 'Confirmação de agendamento pós-conversa',
          sourceEventId: eventResult.eventId || null,
          idempotencyQualifier: appointmentId || conversationId || patientId,
        });

        await calculateLeadScore(supabase, patientId, clinicId);
        break;
      }

      case 'completed': {
        // Paciente compareceu à consulta
        await emitEvent(supabase, clinicId, patientId, 'appointment_completed', {
          conversationId,
          appointmentId,
          idempotencyQualifier: appointmentId || conversationId || patientId,
          payload: { outcome: 'completed' },
        });

        // Agendar follow-up pós-consulta (48h depois)
        const followUp48h = new Date(Date.now() + 48 * 60 * 60 * 1000);
        await scheduleTask(supabase, clinicId, patientId, 'post_consultation', followUp48h, {
          reason: 'Follow-up automático pós-consulta',
          idempotencyQualifier: appointmentId || conversationId || patientId,
          messageTemplate: 'Olá! Como você está se sentindo após a consulta? Posso ajudar com algo?',
        });

        await calculateLeadScore(supabase, patientId, clinicId);
        break;
      }

      case 'cancelled': {
        // Agendamento cancelado
        await emitEvent(supabase, clinicId, patientId, 'booking_canceled', {
          conversationId,
          appointmentId,
          idempotencyQualifier: appointmentId || conversationId || patientId,
          payload: { outcome: 'cancelled' },
        });

        await calculateLeadScore(supabase, patientId, clinicId);
        break;
      }

      case 'no_show': {
        // Paciente não compareceu
        await emitEvent(supabase, clinicId, patientId, 'no_show', {
          conversationId,
          appointmentId,
          idempotencyQualifier: appointmentId || conversationId || patientId,
          payload: { outcome: 'no_show' },
        });

        // Agendar recuperação 2h depois
        const recovery2h = new Date(Date.now() + 2 * 60 * 60 * 1000);
        await scheduleTask(supabase, clinicId, patientId, 'no_show_recovery', recovery2h, {
          reason: 'Recuperação automática pós no-show',
          idempotencyQualifier: appointmentId || conversationId || patientId,
          messageTemplate: 'Olá! Notamos que você não compareceu à consulta. Gostaria de reagendar?',
        });

        await calculateLeadScore(supabase, patientId, clinicId);
        break;
      }

      case 'abandoned': {
        // Conversa abandonada (paciente não completou o fluxo)
        await emitEvent(supabase, clinicId, patientId, 'conversation_ended', {
          conversationId,
          idempotencyQualifier: conversationId || patientId,
          payload: { outcome: 'abandoned', reason: 'flow_not_completed' },
        });

        // Agendar reativação em 7 dias
        const reactivation7d = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        await scheduleTask(supabase, clinicId, patientId, 'reactivation', reactivation7d, {
          reason: 'Reativação automática — conversa abandonada',
          idempotencyQualifier: conversationId || patientId,
          messageTemplate: 'Olá! Vi que você entrou em contato conosco recentemente. Posso ajudar com algo?',
        });

        await calculateLeadScore(supabase, patientId, clinicId);
        break;
      }

      case 'info_provided': {
        // Paciente pediu informação sem intenção de agendar
        await emitEvent(supabase, clinicId, patientId, 'info_requested', {
          conversationId,
          idempotencyQualifier: conversationId || patientId,
          payload: { outcome: 'info_provided' },
        });

        await calculateLeadScore(supabase, patientId, clinicId);
        break;
      }

      default: {
        // Conversa genérica (small talk, encerramento, etc.)
        await emitEvent(supabase, clinicId, patientId, 'conversation_ended', {
          conversationId,
          idempotencyQualifier: conversationId || `${patientId}:${new Date().toISOString().split('T')[0]}`,
          payload: { outcome: conversationOutcome || 'conversation' },
        });
        break;
      }
    }

    console.log(`[CRM] processPostConversation concluído: outcome=${conversationOutcome}`);
    return { success: true, outcome: conversationOutcome };
  } catch (error) {
    console.error(`[CRM] Erro em processPostConversation:`, error.message);
    return { success: false, error: error.message };
  }
}

// ======================================================
// EXPORTS (ESM)
// ======================================================
export {
  emitEvent,
  scheduleTask,
  calculateLeadScore,
  processPostConversation,
  VALID_EVENT_TYPES,
  VALID_TASK_TYPES,
};
