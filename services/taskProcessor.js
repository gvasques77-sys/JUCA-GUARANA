/**
 * CRM Task Processor — Fase 3: Follow-up Automation
 * 
 * Responsabilidades:
 * - Varrer crm_tasks com status='pending' e due_at <= now()
 * - Lock atômico (UPDATE RETURNING) para evitar execução duplicada
 * - Executar a ação correspondente ao task_type
 * - Gerenciar retry com backoff em caso de falha
 * - Atualizar status (completed, failed, skipped)
 * 
 * REGRAS ABSOLUTAS:
 * - NUNCA faz throw — se falhar, loga e continua
 * - Lock atômico via UPDATE ... SET status='processing' WHERE status='pending' RETURNING *
 * - Prefixo [TASK-PROCESSOR] em todos os logs
 * - MAX_RETRIES = 3 antes de marcar como 'failed' definitivo
 * - Intervalo configurável via env var TASK_PROCESSOR_INTERVAL_MS (default: 60000 = 1 min)
 */

// ======================================================
// CONSTANTES
// ======================================================
const MAX_RETRIES = 3;
const DEFAULT_INTERVAL_MS = 60_000; // 1 minuto
const BATCH_SIZE = 10; // processar no máximo 10 tarefas por ciclo

// Status possíveis das tarefas
import { getClinicWhatsAppConfig } from './whatsappConfigHelper.js';

const TASK_STATUS = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
  SKIPPED: 'skipped',
  CANCELED: 'canceled',
};

// ======================================================
// ADAPTADOR DE ENVIO — PLUGÁVEL
// ======================================================

/**
 * Adaptador de envio de mensagens WhatsApp.
 * 
 * Conectado à Meta WhatsApp API usando as variáveis de ambiente:
 * - META_WA_TOKEN         → Bearer token da Meta
 * - META_PHONE_NUMBER_ID  → ID do número remetente
 * - META_API_VERSION      → Versão da Graph API (default: v21.0)
 * 
 * Se as credenciais estiverem ausentes, opera em modo simulação (sem envio real).
 * 
 * @param {string} patientPhone - Telefone do destinatário (formato: 55XXXXXXXXXXX)
 * @param {string} message - Mensagem a enviar
 * @param {object} options - Opções adicionais
 * @param {string} [options.templateName] - Nome do template Meta (para mensagens fora da janela de 24h)
 * @param {object} [options.templateParams] - Parâmetros do template
 * @param {string} [options.clinicId] - UUID da clínica (para buscar credenciais multi-tenant)
 * @returns {Promise<{success: boolean, messageId?: string, error?: string, simulated?: boolean}>}
 */
async function sendWhatsAppMessage(patientPhone, message, options = {}) {
  try {
    // Multi-tenant: buscar credenciais da clínica via whatsappConfigHelper
    const config = await getClinicWhatsAppConfig(options.clinicId);
    if (!config) {
      console.log(`[TASK-PROCESSOR] [SIMULAÇÃO] Sem config WhatsApp para clínica ${options.clinicId || 'N/A'} — Mensagem para ${patientPhone}: "${message.substring(0, 80)}..."`);
      return { success: true, simulated: true, message: 'Credenciais WhatsApp não configuradas — modo simulação' };
    }

    const whatsappToken  = config.access_token;
    const phoneNumberId  = config.phone_number_id;
    const apiVersion     = process.env.META_API_VERSION || 'v21.0';

    // === ENVIO REAL VIA META WHATSAPP API ===
    const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;

    let body;
    if (options.templateName) {
      // Mensagem via template (para fora da janela de 24h)
      body = {
        messaging_product: 'whatsapp',
        to: patientPhone,
        type: 'template',
        template: {
          name: options.templateName,
          language: { code: 'pt_BR' },
          components: options.templateParams ? [{
            type: 'body',
            parameters: Object.values(options.templateParams).map(v => ({ type: 'text', text: String(v) })),
          }] : [],
        },
      };
    } else {
      // Mensagem de texto simples (dentro da janela de 24h)
      body = {
        messaging_product: 'whatsapp',
        to: patientPhone,
        type: 'text',
        text: { body: message },
      };
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${whatsappToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = await response.json();

    if (!response.ok) {
      const errorMsg = data?.error?.message || `HTTP ${response.status}`;
      console.error(`[TASK-PROCESSOR] Erro Meta API:`, errorMsg);
      return { success: false, error: errorMsg };
    }

    const messageId = data?.messages?.[0]?.id || null;
    console.log(`[TASK-PROCESSOR] Mensagem enviada para ${patientPhone} (id: ${messageId})`);
    return { success: true, messageId, simulated: false };
  } catch (error) {
    console.error(`[TASK-PROCESSOR] Erro ao enviar WhatsApp:`, error.message);
    return { success: false, error: error.message };
  }
}

// ======================================================
// EXECUTOR DE TAREFAS — Switch por task_type
// ======================================================

/**
 * Executa a ação correspondente a uma tarefa CRM.
 * Cada task_type tem sua lógica específica.
 * 
 * @param {object} task - Row completa da crm_tasks
 * @param {object} supabase - Cliente Supabase
 * @returns {Promise<{success: boolean, action?: string, error?: string}>}
 */
async function executeTaskAction(task, supabase) {
  try {
    // Buscar dados do paciente para envio
    const { data: patient, error: patientErr } = await supabase
      .from('patients')
      .select('id, name, phone')
      .eq('id', task.patient_id)
      .single();

    if (patientErr || !patient) {
      console.warn(`[TASK-PROCESSOR] Paciente não encontrado: ${task.patient_id} — pulando tarefa`);
      return { success: false, error: 'patient_not_found', skip: true };
    }

    const patientPhone = patient.phone;
    const patientName = patient.name || 'Paciente';

    switch (task.task_type) {
      case 'reminder_24h': {
        // Lembrete 24h antes da consulta — dentro da janela de 24h
        const message = task.message_template
          || `Olá ${patientName}! 😊 Lembrando que você tem uma consulta amanhã. Confirma sua presença?`;
        const result = await sendWhatsAppMessage(patientPhone, message, { clinicId: task.clinic_id });
        return { success: result.success, action: 'whatsapp_sent', error: result.error, simulated: result.simulated };
      }

      case 'booking_confirmation': {
        // Confirmação de agendamento 2h após agendar
        const message = task.message_template
          || `Olá ${patientName}! Seu agendamento foi realizado com sucesso. Caso precise remarcar ou cancelar, é só me chamar! 📅`;
        const result = await sendWhatsAppMessage(patientPhone, message, { clinicId: task.clinic_id });
        return { success: result.success, action: 'whatsapp_sent', error: result.error, simulated: result.simulated };
      }

      case 'post_consultation': {
        // Follow-up pós-consulta 48h depois
        const message = task.message_template
          || `Olá ${patientName}! Como você está se sentindo após a consulta? Se tiver alguma dúvida, estou aqui para ajudar! 😊`;
        // 48h pode estar fora da janela — verificar necessidade de template
        const needsTemplate = task.created_at && (Date.now() - new Date(task.created_at).getTime()) > 24 * 60 * 60 * 1000;
        if (needsTemplate && !process.env.WHATSAPP_TEMPLATE_POST_CONSULTATION) {
          console.log(`[TASK-PROCESSOR] post_consultation fora da janela de 24h e sem template configurado — pulando`);
          return { success: false, error: 'template_required_not_configured', skip: true };
        }
        const templateName = needsTemplate ? process.env.WHATSAPP_TEMPLATE_POST_CONSULTATION : null;
        const result = await sendWhatsAppMessage(patientPhone, message, { clinicId: task.clinic_id, templateName });
        return { success: result.success, action: 'whatsapp_sent', error: result.error, simulated: result.simulated };
      }

      case 'no_show_recovery': {
        // Recuperação de no-show 2h depois — dentro da janela de 24h
        const message = task.message_template
          || `Olá ${patientName}! Notamos que você não compareceu à consulta de hoje. Gostaria de reagendar? Estou aqui para ajudar! 🗓️`;
        const result = await sendWhatsAppMessage(patientPhone, message, { clinicId: task.clinic_id });
        return { success: result.success, action: 'whatsapp_sent', error: result.error, simulated: result.simulated };
      }

      case 'reactivation': {
        // Reativação 7 dias depois — FORA da janela de 24h, requer template
        const templateName = process.env.WHATSAPP_TEMPLATE_REACTIVATION;
        if (!templateName) {
          console.log(`[TASK-PROCESSOR] reactivation requer template Meta aprovado — WHATSAPP_TEMPLATE_REACTIVATION não configurado — pulando`);
          return { success: false, error: 'template_required_not_configured', skip: true };
        }
        const message = task.message_template
          || `Olá ${patientName}! Vi que você entrou em contato conosco recentemente. Posso ajudar com algo?`;
        const result = await sendWhatsAppMessage(patientPhone, message, {
          clinicId: task.clinic_id,
          templateName,
          templateParams: { patient_name: patientName },
        });
        return { success: result.success, action: 'whatsapp_sent', error: result.error, simulated: result.simulated };
      }

      case 'custom': {
        // Tarefa customizada — usa message_template obrigatoriamente
        if (!task.message_template) {
          console.warn(`[TASK-PROCESSOR] Tarefa custom sem message_template — pulando`);
          return { success: false, error: 'custom_task_no_template', skip: true };
        }
        const result = await sendWhatsAppMessage(patientPhone, task.message_template, { clinicId: task.clinic_id });
        return { success: result.success, action: 'whatsapp_sent', error: result.error, simulated: result.simulated };
      }

      default: {
        console.warn(`[TASK-PROCESSOR] task_type desconhecido: '${task.task_type}' — pulando`);
        return { success: false, error: `unknown_task_type: ${task.task_type}`, skip: true };
      }
    }
  } catch (error) {
    console.error(`[TASK-PROCESSOR] Erro em executeTaskAction:`, error.message);
    return { success: false, error: error.message };
  }
}

// ======================================================
// PROCESSADOR PRINCIPAL — Ciclo de varredura
// ======================================================

/**
 * Executa um ciclo de processamento: busca tarefas prontas, faz lock,
 * executa e atualiza status.
 * 
 * @param {object} supabase - Cliente Supabase
 * @returns {Promise<{processed: number, completed: number, failed: number, skipped: number}>}
 */
async function processTaskCycle(supabase) {
  const stats = { processed: 0, completed: 0, failed: 0, skipped: 0 };

  try {
    // 1. Buscar e travar tarefas prontas (lock atômico)
    // UPDATE ... SET status='processing' WHERE status='pending' AND due_at <= now()
    // RETURNING * garante que só esta instância processa cada tarefa
    const { data: tasks, error: fetchErr } = await supabase
      .rpc('fn_claim_pending_tasks', { p_batch_size: BATCH_SIZE });

    // Se a função RPC não existir, usar fallback com query direta
    if (fetchErr) {
      if (fetchErr.message?.includes('fn_claim_pending_tasks')) {
        // Fallback: query direta (menos seguro em multi-réplica, mas funcional)
        return await processTaskCycleFallback(supabase);
      }
      console.error(`[TASK-PROCESSOR] Erro ao buscar tarefas:`, fetchErr.message);
      return stats;
    }

    if (!tasks || tasks.length === 0) {
      return stats; // Nada para processar — silencioso
    }

    console.log(`[TASK-PROCESSOR] ${tasks.length} tarefa(s) prontas para processar`);

    // 2. Processar cada tarefa
    for (const task of tasks) {
      stats.processed++;

      try {
        const result = await executeTaskAction(task, supabase);

        if (result.skip) {
          // Tarefa deve ser pulada (sem template, paciente não encontrado, etc.)
          await supabase
            .from('crm_tasks')
            .update({
              status: TASK_STATUS.SKIPPED,
              last_error: result.error || 'skipped',
              executed_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq('id', task.id);
          stats.skipped++;
          console.log(`[TASK-PROCESSOR] Tarefa ${task.id} (${task.task_type}) — SKIPPED: ${result.error}`);

        } else if (result.success) {
          // Tarefa executada com sucesso
          await supabase
            .from('crm_tasks')
            .update({
              status: TASK_STATUS.COMPLETED,
              executed_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq('id', task.id);
          stats.completed++;
          console.log(`[TASK-PROCESSOR] Tarefa ${task.id} (${task.task_type}) — COMPLETED${result.simulated ? ' [SIMULADO]' : ''}`);

        } else {
          // Tarefa falhou — verificar retry
          const newRetryCount = (task.retry_count || 0) + 1;

          if (newRetryCount >= MAX_RETRIES) {
            // Excedeu retries — marcar como failed definitivo
            await supabase
              .from('crm_tasks')
              .update({
                status: TASK_STATUS.FAILED,
                retry_count: newRetryCount,
                last_error: result.error || 'max_retries_exceeded',
                executed_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              })
              .eq('id', task.id);
            stats.failed++;
            console.error(`[TASK-PROCESSOR] Tarefa ${task.id} (${task.task_type}) — FAILED definitivo após ${newRetryCount} tentativas: ${result.error}`);

          } else {
            // Ainda pode tentar — voltar para pending com retry_count incrementado
            // Backoff: próxima tentativa em retry_count * 5 minutos
            const backoffMinutes = newRetryCount * 5;
            const nextDueAt = new Date(Date.now() + backoffMinutes * 60 * 1000);

            await supabase
              .from('crm_tasks')
              .update({
                status: TASK_STATUS.PENDING, // volta para fila
                retry_count: newRetryCount,
                last_error: result.error,
                due_at: nextDueAt.toISOString(),
                updated_at: new Date().toISOString(),
              })
              .eq('id', task.id);
            console.warn(`[TASK-PROCESSOR] Tarefa ${task.id} (${task.task_type}) — retry ${newRetryCount}/${MAX_RETRIES}, próxima em ${backoffMinutes}min`);
          }
        }
      } catch (taskErr) {
        // Erro inesperado no processamento individual — não derrubar o ciclo
        console.error(`[TASK-PROCESSOR] Erro inesperado processando tarefa ${task.id}:`, taskErr.message);
        await supabase
          .from('crm_tasks')
          .update({
            status: TASK_STATUS.PENDING, // devolver para fila
            retry_count: (task.retry_count || 0) + 1,
            last_error: taskErr.message,
            updated_at: new Date().toISOString(),
          })
          .eq('id', task.id);
        stats.failed++;
      }
    }

    if (stats.processed > 0) {
      console.log(`[TASK-PROCESSOR] Ciclo concluído: ${stats.processed} processadas, ${stats.completed} OK, ${stats.failed} falhas, ${stats.skipped} puladas`);
    }

    return stats;
  } catch (error) {
    console.error(`[TASK-PROCESSOR] Erro no ciclo de processamento:`, error.message);
    return stats;
  }
}

/**
 * Fallback do processador quando a RPC fn_claim_pending_tasks não existe.
 * Usa query direta — funcional, mas menos seguro em cenários multi-réplica.
 */
async function processTaskCycleFallback(supabase) {
  const stats = { processed: 0, completed: 0, failed: 0, skipped: 0 };

  try {
    // Buscar tarefas pendentes cujo due_at já chegou
    const { data: tasks, error } = await supabase
      .from('crm_tasks')
      .select('*')
      .eq('status', TASK_STATUS.PENDING)
      .lte('due_at', new Date().toISOString())
      .order('due_at', { ascending: true })
      .limit(BATCH_SIZE);

    if (error || !tasks || tasks.length === 0) {
      return stats;
    }

    console.log(`[TASK-PROCESSOR] [FALLBACK] ${tasks.length} tarefa(s) prontas`);

    // Marcar todas como processing antes de executar (lock otimista)
    const taskIds = tasks.map(t => t.id);
    await supabase
      .from('crm_tasks')
      .update({ status: TASK_STATUS.PROCESSING, updated_at: new Date().toISOString() })
      .in('id', taskIds);

    // Reutilizar a lógica de processamento do ciclo principal
    for (const task of tasks) {
      stats.processed++;
      try {
        const result = await executeTaskAction(task, supabase);

        if (result.skip) {
          await supabase
            .from('crm_tasks')
            .update({ status: TASK_STATUS.SKIPPED, last_error: result.error || 'skipped', executed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
            .eq('id', task.id);
          stats.skipped++;
        } else if (result.success) {
          await supabase
            .from('crm_tasks')
            .update({ status: TASK_STATUS.COMPLETED, executed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
            .eq('id', task.id);
          stats.completed++;
        } else {
          const newRetryCount = (task.retry_count || 0) + 1;
          if (newRetryCount >= MAX_RETRIES) {
            await supabase
              .from('crm_tasks')
              .update({ status: TASK_STATUS.FAILED, retry_count: newRetryCount, last_error: result.error, executed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
              .eq('id', task.id);
            stats.failed++;
          } else {
            const backoffMinutes = newRetryCount * 5;
            await supabase
              .from('crm_tasks')
              .update({ status: TASK_STATUS.PENDING, retry_count: newRetryCount, last_error: result.error, due_at: new Date(Date.now() + backoffMinutes * 60 * 1000).toISOString(), updated_at: new Date().toISOString() })
              .eq('id', task.id);
          }
        }
      } catch (taskErr) {
        await supabase
          .from('crm_tasks')
          .update({ status: TASK_STATUS.PENDING, retry_count: (task.retry_count || 0) + 1, last_error: taskErr.message, updated_at: new Date().toISOString() })
          .eq('id', task.id);
        stats.failed++;
      }
    }

    return stats;
  } catch (error) {
    console.error(`[TASK-PROCESSOR] [FALLBACK] Erro:`, error.message);
    return stats;
  }
}

// ======================================================
// SCHEDULER — Inicia o loop de processamento
// ======================================================

let processorInterval = null;

/**
 * Inicia o Task Processor como cron interno.
 * Roda a cada TASK_PROCESSOR_INTERVAL_MS (default: 60s).
 * 
 * IMPORTANTE: Chamar UMA VEZ no boot do server.js, após app.listen().
 * 
 * @param {object} supabase - Cliente Supabase
 * @returns {void}
 */
function startTaskProcessor(supabase) {
  const intervalMs = Number(process.env.TASK_PROCESSOR_INTERVAL_MS || DEFAULT_INTERVAL_MS);

  // Prevenir múltiplas instâncias
  if (processorInterval) {
    console.warn(`[TASK-PROCESSOR] Já está rodando — ignorando start duplicado`);
    return;
  }

  console.log(`[TASK-PROCESSOR] Iniciado — varredura a cada ${intervalMs / 1000}s (batch: ${BATCH_SIZE}, max_retries: ${MAX_RETRIES})`);

  // Executar primeiro ciclo imediatamente (após 5s de boot para garantir estabilidade)
  setTimeout(() => {
    processTaskCycle(supabase).catch(err =>
      console.error(`[TASK-PROCESSOR] Erro no ciclo inicial:`, err.message)
    );
  }, 5000);

  // Agendar ciclos subsequentes
  processorInterval = setInterval(() => {
    processTaskCycle(supabase).catch(err =>
      console.error(`[TASK-PROCESSOR] Erro no ciclo:`, err.message)
    );
  }, intervalMs);
}

/**
 * Para o Task Processor (usado em graceful shutdown).
 */
function stopTaskProcessor() {
  if (processorInterval) {
    clearInterval(processorInterval);
    processorInterval = null;
    console.log(`[TASK-PROCESSOR] Parado`);
  }
}

// ======================================================
// EXPORTS (ESM)
// ======================================================
export {
  startTaskProcessor,
  stopTaskProcessor,
  processTaskCycle,
  sendWhatsAppMessage,
  executeTaskAction,
  TASK_STATUS,
  MAX_RETRIES,
};
