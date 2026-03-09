/* crmService.js — Orquestração de CRM (Lead Stages, Timeline, Follow-ups, Lead Scoring)
   JUCA GUARANÁ — Secretária Inteligente
   Fire-and-forget: erros não propagam para o agente */

import { createClient } from '@supabase/supabase-js';
const supabase = createClient(
  process.env.SUPABASE_URL || 'missing',
  process.env.SUPABASE_SERVICE_ROLE_KEY || 'missing',
);

// ─── 1. updateLeadStage ───
// Atualiza o estágio do lead e registra evento na timeline
export async function updateLeadStage(patientId, clinicId, newStageSlug) {
  try {
    // Buscar o lead_stage_id correspondente ao slug
    const { data: stageData, error: stageError } = await supabase
      .from('lead_stages')
      .select('id')
      .eq('slug', newStageSlug)
      .single();

    if (stageError || !stageData) {
      console.error(`[CRM] Estágio '${newStageSlug}' não encontrado`);
      return { success: false, error: `Estágio '${newStageSlug}' não encontrado` };
    }

    // Atualizar patient_crm.lead_stage_id
    const { error: updateError } = await supabase
      .from('patient_crm')
      .update({ lead_stage_id: stageData.id, updated_at: new Date().toISOString() })
      .eq('patient_id', patientId)
      .eq('clinic_id', clinicId);

    if (updateError) {
      console.error(`[CRM] Erro ao atualizar lead_stage:`, updateError.message);
      return { success: false, error: updateError.message };
    }

    // Registrar evento 'stage_change' na timeline
    await addTimelineEvent(
      patientId,
      clinicId,
      'stage_change',
      `Estágio alterado para: ${newStageSlug}`,
      { old_stage: null, new_stage: newStageSlug },
      'system'
    );

    console.log(`[CRM] Lead stage atualizado: ${patientId} → ${newStageSlug}`);
    return { success: true, newStage: newStageSlug };
  } catch (error) {
    console.error(`[CRM] Erro em updateLeadStage:`, error.message);
    return { success: false, error: error.message };
  }
}

// ─── 2. addTimelineEvent ───
// Insere evento na patient_timeline
export async function addTimelineEvent(
  patientId,
  clinicId,
  eventType,
  description,
  eventData = {},
  createdBy = 'system'
) {
  try {
    const validEventTypes = [
      'first_contact',
      'conversation',
      'booking',
      'cancellation',
      'no_show',
      'completed',
      'stage_change',
      'follow_up_sent',
      'note_added',
      'tag_added',
    ];

    if (!validEventTypes.includes(eventType)) {
      console.warn(`[CRM] Event type '${eventType}' inválido`);
      return { success: false, error: `Event type inválido: ${eventType}` };
    }

    const { error } = await supabase.from('patient_timeline').insert({
      patient_id: patientId,
      clinic_id: clinicId,
      event_type: eventType,
      description,
      event_data: eventData,
      created_by: createdBy,
      created_at: new Date().toISOString(),
    });

    if (error) {
      console.error(`[CRM] Erro ao inserir timeline event:`, error.message);
      return { success: false, error: error.message };
    }

    console.log(`[CRM] Timeline event adicionado: ${patientId} - ${eventType}`);
    return { success: true, eventType };
  } catch (error) {
    console.error(`[CRM] Erro em addTimelineEvent:`, error.message);
    return { success: false, error: error.message };
  }
}

// ─── 3. scheduleFollowUp ───
// Insere tarefa de follow-up
export async function scheduleFollowUp(
  patientId,
  clinicId,
  taskType,
  scheduledFor,
  referenceId = null,
  messageTemplate = null
) {
  try {
    const validTaskTypes = ['reminder_24h', 'post_consultation', 'reactivation', 'custom'];

    if (!validTaskTypes.includes(taskType)) {
      console.warn(`[CRM] Task type '${taskType}' inválido`);
      return { success: false, error: `Task type inválido: ${taskType}` };
    }

    const { error } = await supabase.from('follow_up_tasks').insert({
      patient_id: patientId,
      clinic_id: clinicId,
      task_type: taskType,
      status: 'pending',
      scheduled_for: scheduledFor,
      reference_id: referenceId,
      message_template: messageTemplate,
      created_at: new Date().toISOString(),
    });

    if (error) {
      console.error(`[CRM] Erro ao agendar follow-up:`, error.message);
      return { success: false, error: error.message };
    }

    console.log(`[CRM] Follow-up agendado: ${patientId} - ${taskType}`);
    return { success: true, taskType };
  } catch (error) {
    console.error(`[CRM] Erro em scheduleFollowUp:`, error.message);
    return { success: false, error: error.message };
  }
}

// ─── 4. calculateLeadScore ───
// Calcula score 0-100 baseado em múltiplos fatores
export async function calculateLeadScore(patientId, clinicId) {
  try {
    let score = 0;

    // Buscar dados do paciente
    const { data: patientData, error: patientError } = await supabase
      .from('patient_crm')
      .select('*')
      .eq('patient_id', patientId)
      .eq('clinic_id', clinicId)
      .single();

    if (patientError || !patientData) {
      console.warn(`[CRM] Paciente ${patientId} não encontrado para lead score`);
      return { success: false, error: 'Paciente não encontrado' };
    }

    // +30 se tem agendamento confirmado
    const { data: appointments } = await supabase
      .from('appointments')
      .select('id')
      .eq('patient_id', patientId)
      .eq('clinic_id', clinicId)
      .eq('status', 'confirmed')
      .limit(1);

    if (appointments && appointments.length > 0) {
      score += 30;
    }

    // +20 por consulta anterior (max +40)
    const { data: completedAppts } = await supabase
      .from('appointments')
      .select('id')
      .eq('patient_id', patientId)
      .eq('clinic_id', clinicId)
      .eq('status', 'completed');

    if (completedAppts) {
      score += Math.min(completedAppts.length * 20, 40);
    }

    // +15 se respondeu nas últimas 48h
    const { data: recentTimeline } = await supabase
      .from('patient_timeline')
      .select('created_at')
      .eq('patient_id', patientId)
      .eq('clinic_id', clinicId)
      .gte('created_at', new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString())
      .limit(1);

    if (recentTimeline && recentTimeline.length > 0) {
      score += 15;
    }

    // +15 se nunca deu no-show
    const { data: noShowEvents } = await supabase
      .from('patient_timeline')
      .select('id')
      .eq('patient_id', patientId)
      .eq('clinic_id', clinicId)
      .eq('event_type', 'no_show');

    if (!noShowEvents || noShowEvents.length === 0) {
      score += 15;
    }

    // +10 se total de conversas > 3
    const { data: conversations } = await supabase
      .from('conversations')
      .select('id')
      .eq('patient_phone', patientData.patient_phone)
      .eq('clinic_id', clinicId);

    if (conversations && conversations.length > 3) {
      score += 10;
    }

    // Capped at 100
    score = Math.min(score, 100);

    // Atualizar patient_crm.lead_score
    const { error: updateError } = await supabase
      .from('patient_crm')
      .update({ lead_score: score, updated_at: new Date().toISOString() })
      .eq('patient_id', patientId)
      .eq('clinic_id', clinicId);

    if (updateError) {
      console.error(`[CRM] Erro ao atualizar lead_score:`, updateError.message);
      return { success: false, error: updateError.message };
    }

    console.log(`[CRM] Lead score calculado: ${patientId} = ${score}`);
    return { success: true, score };
  } catch (error) {
    console.error(`[CRM] Erro em calculateLeadScore:`, error.message);
    return { success: false, error: error.message };
  }
}

// ─── 5. processPostConversation ───
// Função PRINCIPAL: orquestra outras funções baseada no outcome
export async function processPostConversation(
  patientPhone,
  clinicId,
  conversationOutcome,
  appointmentId = null
) {
  try {
    console.log(`[CRM] Processando pós-conversa: ${patientPhone} - ${conversationOutcome}`);

    // Buscar patient_id pelo phone
    const { data: patientData, error: patientError } = await supabase
      .from('patients')
      .select('id')
      .eq('phone', patientPhone)
      .eq('clinic_id', clinicId)
      .single();

    if (patientError || !patientData) {
      console.log(`[CRM] Paciente ${patientPhone} não encontrado — ignorando pós-processamento`);
      return { success: false, error: 'Paciente não encontrado' };
    }

    const patientId = patientData.id;

    // Atualizar last_contact_at em patient_crm
    await supabase
      .from('patient_crm')
      .update({ last_contact_at: new Date().toISOString() })
      .eq('patient_id', patientId)
      .eq('clinic_id', clinicId)
      .catch(err => console.error(`[CRM] Erro ao atualizar last_contact_at:`, err.message));

    // Switch por outcome
    switch (conversationOutcome) {
      case 'booked': {
        // Atualizar para 'booked'
        await updateLeadStage(patientId, clinicId, 'booked');
        // Registrar evento
        await addTimelineEvent(
          patientId,
          clinicId,
          'booking',
          'Paciente agendou uma consulta via WhatsApp',
          { appointment_id: appointmentId },
          'agent'
        );
        // Agendar reminder 24h antes (assumindo appointmentId válido)
        if (appointmentId) {
          const { data: apptData } = await supabase
            .from('appointments')
            .select('appointment_date, start_time')
            .eq('id', appointmentId)
            .single();

          if (apptData) {
            const appointmentDateTime = new Date(`${apptData.appointment_date}T${apptData.start_time}`);
            const reminderTime = new Date(appointmentDateTime.getTime() - 24 * 60 * 60 * 1000);
            await scheduleFollowUp(
              patientId,
              clinicId,
              'reminder_24h',
              reminderTime.toISOString(),
              appointmentId,
              'Lembrete: Você tem uma consulta marcada amanhã!'
            );
          }
        }
        // Calcular score
        await calculateLeadScore(patientId, clinicId);
        break;
      }

      case 'completed': {
        // Atualizar para 'attended'
        await updateLeadStage(patientId, clinicId, 'attended');
        // Registrar evento
        await addTimelineEvent(
          patientId,
          clinicId,
          'completed',
          'Paciente compareceu à consulta',
          { appointment_id: appointmentId },
          'system'
        );
        // Agendar follow-up 48h depois
        const followUpTime = new Date(Date.now() + 48 * 60 * 60 * 1000);
        await scheduleFollowUp(
          patientId,
          clinicId,
          'post_consultation',
          followUpTime.toISOString(),
          appointmentId,
          'Como foi sua consulta? Ficou com dúvidas?'
        );
        // Calcular score
        await calculateLeadScore(patientId, clinicId);
        break;
      }

      case 'cancelled': {
        // Apenas registrar evento
        await addTimelineEvent(
          patientId,
          clinicId,
          'cancellation',
          'Paciente cancelou a consulta',
          { appointment_id: appointmentId },
          'agent'
        );
        // Calcular score
        await calculateLeadScore(patientId, clinicId);
        break;
      }

      case 'no_show': {
        // Registrar evento
        await addTimelineEvent(
          patientId,
          clinicId,
          'no_show',
          'Paciente não compareceu à consulta',
          { appointment_id: appointmentId },
          'system'
        );
        // Incrementar total_no_shows
        const { data: crmData } = await supabase
          .from('patient_crm')
          .select('total_no_shows')
          .eq('patient_id', patientId)
          .eq('clinic_id', clinicId)
          .single();

        if (crmData) {
          await supabase
            .from('patient_crm')
            .update({
              total_no_shows: (crmData.total_no_shows || 0) + 1,
              updated_at: new Date().toISOString(),
            })
            .eq('patient_id', patientId)
            .eq('clinic_id', clinicId)
            .catch(err => console.error(`[CRM] Erro ao incrementar no_shows:`, err.message));
        }
        // Calcular score
        await calculateLeadScore(patientId, clinicId);
        break;
      }

      case 'abandoned': {
        // Agendar reativação 7 dias depois
        const reactivationTime = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        await scheduleFollowUp(
          patientId,
          clinicId,
          'reactivation',
          reactivationTime.toISOString(),
          null,
          'Sentimos sua falta! Gostaria de agendar uma consulta?'
        );
        // Registrar evento
        await addTimelineEvent(
          patientId,
          clinicId,
          'conversation',
          'Conversa abandonada — agendamento de reativação iniciado',
          { reason: 'abandoned' },
          'system'
        );
        // Calcular score
        await calculateLeadScore(patientId, clinicId);
        break;
      }

      case 'info_provided': {
        // Se estágio atual é 'new', avançar para 'qualified'
        const { data: crmData } = await supabase
          .from('patient_crm')
          .select('lead_stage_id')
          .eq('patient_id', patientId)
          .eq('clinic_id', clinicId)
          .single();

        if (crmData) {
          const { data: stageData } = await supabase
            .from('lead_stages')
            .select('slug')
            .eq('id', crmData.lead_stage_id)
            .single();

          if (stageData && stageData.slug === 'new') {
            await updateLeadStage(patientId, clinicId, 'qualified');
          }
        }
        // Registrar evento
        await addTimelineEvent(
          patientId,
          clinicId,
          'conversation',
          'Paciente recebeu informações sobre serviços',
          {},
          'agent'
        );
        // Calcular score
        await calculateLeadScore(patientId, clinicId);
        break;
      }

      default: {
        // Qualquer outro outcome: apenas registrar evento
        await addTimelineEvent(
          patientId,
          clinicId,
          'conversation',
          `Conversa finalizada com resultado: ${conversationOutcome}`,
          { outcome: conversationOutcome },
          'agent'
        );
        break;
      }
    }

    console.log(`[CRM] Pós-processamento concluído para ${patientId}`);
    return { success: true, patientId, outcome: conversationOutcome };
  } catch (error) {
    console.error(`[CRM] Erro em processPostConversation:`, error.message);
    // Não propagar erro — fire-and-forget
    return { success: false, error: error.message };
  }
}

export default {
  updateLeadStage,
  addTimelineEvent,
  scheduleFollowUp,
  calculateLeadScore,
  processPostConversation,
};
