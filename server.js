import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { z } from 'zod';
import pino from 'pino';
import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';
import path from 'path';
import { fileURLToPath } from 'url';
import adminRoutes from './routes/adminRoutes.js';
import googleCalendarRoutes from './routes/googleCalendarRoutes.js';
import { schedulingToolsDefinitions, executeSchedulingTool } from './tools/schedulingTools.js';
import { redisHealthCheck } from './services/redisService.js';
import { getOrCreateConversation, updateConversationTurn, finalizeConversation } from './services/conversationTracker.js';
import { processPostConversation } from './services/crmService.js';
import { startTaskProcessor } from './services/taskProcessor.js';
import { createCrmApiRouter } from './routes/crmDashboardRoutes.js';
import campaignRoutes from './routes/campaignRoutes.js';
import { startCampaignScheduler } from './services/campaignService.js';
import { authMiddleware } from './middleware/authMiddleware.js';



// ======================================================
// STATE MACHINE — Estados explícitos do fluxo de agendamento
// ======================================================

// FIX 1 — Constantes para busca aberta (sem data específica)
const BUSCA_SLOTS_ABERTA_DIAS = 30  // quantos dias à frente buscar
const BUSCA_SLOTS_ABERTA_MAX  = 5   // quantos slots retornar no máximo

// FIX 3 — Limite de tentativas antes de fallback definitivo
const STUCK_LIMIT = 3

// ======================================================
// TAREFA 2 — FIX 1: Mapeamento direto de intenções curtas
// Intercepta respostas de 1-2 palavras ANTES do LLM
// ======================================================
const INTENCOES_DIRETAS = {
  'marcar':           'schedule_new',
  'agendar':          'schedule_new',
  'consulta':         'schedule_new',
  'quero marcar':     'schedule_new',
  'queria marcar':    'schedule_new',
  'quero agendar':    'schedule_new',
  'queria agendar':   'schedule_new',
  'marcar consulta':  'schedule_new',
  'agendar consulta': 'schedule_new',
  'remarcar':         'reschedule',
  'reagendar':        'reschedule',
  'remarcar consulta':'reschedule',
  'reagendar consulta':'reschedule',
  'quero reagendar':  'reschedule',
  'quero remarcar':   'reschedule',
  'reagendar meu horario':'reschedule',
  'quero reagendar meu horario':'reschedule',
  'cancelar':         'cancel',
  'desmarcar':        'cancel',
  'cancelar consulta':'cancel',
  'duvida':           'info',
  'informacao':       'info',
  'informacoes':      'info',
  'tirar duvida':     'info',
  'tirar uma duvida': 'info',
  'tenho uma duvida': 'info',
  'valor':            'info',
  'precos':           'info',
  'preco':            'info',
  'valores':          'info',
  'convenios':        'info',
  'convenio':         'info',
  'plano de saude':   'info',
  'parcelamento':     'info',
  'parcela':          'info',
  'formas de pagamento': 'info',
  'forma de pagamento':  'info',
  'aceita cartao':    'info',
  'tem horario':      'check_availability',
  'tem vaga':         'check_availability',
  'horario disponivel':'check_availability',
  'encaixe':          'schedule_encaixe',
  'encaixar':         'schedule_encaixe',
  'meus agendamentos':      'view_appointments',
  'ver meus agendamentos':  'view_appointments',
  'quero ver meus agendamentos': 'view_appointments',
  'minhas consultas':       'view_appointments',
  'meus horarios':          'view_appointments',
  'esta semana':            'week_current',
  'essa semana':            'week_current',
  'semana atual':           'week_current',
  'proxima semana':         'week_next',
  'semana que vem':         'week_next',
}

/**
 * Detector de perguntas informativas por padrão (não exige match exato).
 * Detecta frases como "qual o valor da consulta com psicólogo",
 * "vocês aceitam unimed?", "parcelam em quantas vezes?", etc.
 * @param {string} text
 * @returns {boolean}
 */
function detectInfoQuestion(text) {
  if (!text) return false;
  const normalized = text.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, '').trim();
  const INFO_PATTERNS = [
    /\b(valor|preco|precos|valores|custa|custo)\b/,
    /\b(convenio|convenios|plano|planos|unimed|bradesco|amil|sulamerica|porto seguro)\b/,
    /\b(parcela|parcelam|parcelamento|cartao|credito|debito|pix|pagamento)\b/,
    /\b(duracao|dura|quanto tempo|demora)\b.*\b(consulta|procedimento|atendimento|sessao)\b/,
    /\bquanto\b.*\b(custa|cobra|sai|fica|paga)\b/,
    /\bqual\b.*\b(valor|preco)\b/,
    /\baceitam?\b.*\b(convenio|plano|cartao)\b/,
    /\b(formas?|meios?)\b.*\bpagamento\b/,
    /\bgostaria\b.*\b(saber|informac)\b/,
    /\bquero\b.*\b(saber|informac)\b/,
    /\b(tirar|tenho)\b.*\b(duvida|duvidas)\b/,
  ];
  return INFO_PATTERNS.some(p => p.test(normalized));
}

/**
 * Interceptor de intenções curtas — executa ANTES do LLM.
 * Normaliza o input (lowercase + sem acentos) e verifica match exato.
 * @param {string} text - Texto da mensagem do usuário
 * @returns {string|null} intent mapeado ou null se não houver match
 */
function interceptarIntencaoDireta(text) {
  if (!text) return null;
  const normalized = text.toLowerCase().trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, '').trim();
  return INTENCOES_DIRETAS[normalized] || null;
}

// ======================================================
// CAMADA 1: Helper para mapear intent → intent_group
// ======================================================
function resolveIntentGroup(intent) {
  const SCHEDULING_INTENTS = ['schedule_new', 'view_appointments', 'try_other_date', 'try_other_doctor', 'confirm_yes', 'confirm_no', 'week_current', 'week_next'];
  const HANDOFF_INTENTS    = ['human_handoff', 'ask_question'];
  if (SCHEDULING_INTENTS.includes(intent)) return 'scheduling';
  if (HANDOFF_INTENTS.includes(intent))    return 'other';
  return 'other';
}

// ======================================================
// TAREFA 2 — FIX 3: Constante de timeout de sessão
// ======================================================
const SESSION_TIMEOUT_MINUTES = 30

// ======================================================
// TAREFA 2 — FIX 4: Constantes de stages do booking
// ======================================================
const BOOKING_STAGES = {
  IDLE:                  'idle',
  COLLECTING_SPECIALTY:  'collecting_specialty',
  COLLECTING_DATE:       'collecting_date',
  COLLECTING_TIME:       'collecting_time',
  AWAITING_CONFIRMATION: 'awaiting_confirmation',
  CONFIRMED:             'confirmed',
  CANCELLED:             'cancelled',
}
const BOOKING_STATES = {
  IDLE: 'idle',
  COLLECTING_SPECIALTY: 'collecting_specialty',
  COLLECTING_DOCTOR: 'collecting_doctor',
  COLLECTING_DATE: 'collecting_date',
  AWAITING_SLOTS: 'awaiting_slots',     // chamou verificar_disponibilidade, aguardando escolha
  COLLECTING_TIME: 'collecting_time',
  CONFIRMING: 'confirming',             // mostrou resumo, aguardando "sim"
  BOOKED: 'booked',
  RESCHEDULING: 'rescheduling',
  CANCELLING: 'cancelling',
};

// Para usar __dirname com ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// CORS — restrito via ALLOWED_ORIGINS (CSV), fallback para '*' se não configurado
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : null;
app.use(cors(allowedOrigins ? { origin: allowedOrigins, credentials: true } : {}));

app.use(express.json({ limit: '1mb' }));

// ======================================================
// PAINEL ADMINISTRATIVO (RECEPÇÃO)
// ======================================================
app.use('/admin', express.static(path.join(__dirname, 'public', 'admin')));
app.use('/admin', adminRoutes);
app.use('/admin/gcal', googleCalendarRoutes);

// ======================================================
// DASHBOARD CRM (Fase 4)
// ======================================================
// API endpoints em /crm/api/* (montados após criação do supabase client, abaixo)
// SPA estática em /crm/*
app.use('/crm', express.static(path.join(__dirname, 'public', 'crm')));
// Fallback SPA: qualquer rota /crm/ que não seja /crm/api ou /crm/login retorna o index.html
// Usa regex em vez de '/crm/*' para compatibilidade com path-to-regexp v8+
app.get(/^\/crm\/(?!api|login).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'crm', 'index.html'));
});

const log = pino({
  transport: { target: 'pino-pretty' },
});

// ======================================================
// VARIÁVEIS DE AMBIENTE
// ======================================================
const PORT = Number(process.env.PORT || 3000);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Avisos se variáveis estiverem faltando
if (!OPENAI_API_KEY) log.warn('⚠️  OPENAI_API_KEY não definido (coloque no .env)');
if (!SUPABASE_URL) log.warn('⚠️  SUPABASE_URL não definido (coloque no .env)');
if (!SUPABASE_SERVICE_ROLE_KEY) log.warn('⚠️  SUPABASE_SERVICE_ROLE_KEY não definido (coloque no .env)');

// Inicializar clientes
const openai = new OpenAI({ apiKey: OPENAI_API_KEY || 'missing' });

const supabase = createClient(
  SUPABASE_URL || 'missing',
  SUPABASE_SERVICE_ROLE_KEY || 'missing',
  { auth: { persistSession: false } }
);

// — F9D: Campaign API (must be before generic CRM routes) —
app.use('/crm/api/campaigns', authMiddleware(supabase), campaignRoutes);

// — CRM Dashboard API (montada aqui porque depende do supabase client) —
app.use('/crm/api', createCrmApiRouter(supabase));



// ======================================================
// SCHEMA DE VALIDAÇÃO (Zod)
// ======================================================
const ClinicIdSchema = z.string().uuid('clinic_id precisa ser um UUID valido');

const EnvelopeSchema = z.object({
  correlation_id: z.string().min(6),
  clinic_id: ClinicIdSchema,
  from: z.string().min(5),
  message_text: z.string().min(1),
  phone_number_id: z.string().optional(),
  received_at_iso: z.string().optional(),
  intent_override: z.string().optional(), // CAMADA 1: intent pré-classificada por botão interativo
  context: z
    .object({
      previous_messages: z
        .array(z.object({ role: z.string(), content: z.string() }))
        .optional(),
    })
    .optional(),
});

const fallbackClinicId = '09e5240f-9c26-47ee-a54d-02934a36ebfd';
const sampleClinicIdCandidate =
  process.env.DEFAULT_CLINIC_ID || process.env.CLINIC_ID || fallbackClinicId;
const sampleClinicId = ClinicIdSchema.safeParse(sampleClinicIdCandidate).success
  ? sampleClinicIdCandidate
  : fallbackClinicId;

const sampleEnvelope = {
  correlation_id: 'abc123456',
  clinic_id: sampleClinicId,
  from: '5511999999999',
  message_text: 'Quero marcar consulta amanha',
  phone_number_id: 'whatsapp-123',
  received_at_iso: '2026-02-16T20:00:00.000Z',
};

// ======================================================
// AUTENTICAÇÃO DO /process (JG-P0-004)
// ======================================================
const AGENT_API_KEY = process.env.AGENT_API_KEY;
if (!AGENT_API_KEY) {
  log.warn('⚠️  AGENT_API_KEY não definido — /process está aberto (apenas dev)');
}

function checkAgentAuth(req, res, next) {
  if (!AGENT_API_KEY) return next(); // dev mode sem key: permite

  const key =
    req.headers['x-api-key'] ||
    (req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : null);

  if (!key || key !== AGENT_API_KEY) {
    return res.status(401).json({
      error: 'unauthorized',
      message: 'x-api-key ou Authorization: Bearer <token> requerido.',
    });
  }
  next();
}

// ======================================================
// ROTA DE HEALTH CHECK
// ======================================================
app.get('/health', async (req, res) => {
    const redis = await redisHealthCheck();
    return res.json({ ok: true, service: 'agent-service', redis });
});

// Rota amigavel para navegador
app.get('/', (req, res) => {
  return res.json({
    ok: true,
    service: 'agent-service',
    endpoints: {
      health: 'GET /health',
      tester: 'GET /process',
      process: 'POST /process',
    },
  });
});

// /process aceita apenas POST com JSON
app.get('/process', (req, res) => {
  const acceptHeader = req.get('accept') || '';
  const wantsHtml = acceptHeader.includes('text/html');

  if (wantsHtml) {
    return res.status(200).type('html').send(`<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Tester /process</title>
  <style>
    body { font-family: Segoe UI, sans-serif; max-width: 860px; margin: 24px auto; padding: 0 14px; }
    h1 { margin-bottom: 8px; }
    p { margin-top: 0; color: #333; }
    textarea { width: 100%; min-height: 240px; font-family: Consolas, monospace; font-size: 13px; padding: 10px; }
    button { margin-top: 10px; padding: 10px 14px; cursor: pointer; }
    pre { background: #f6f8fa; border: 1px solid #ddd; padding: 12px; overflow: auto; }
    .small { color: #444; font-size: 13px; }
  </style>
</head>
<body>
  <h1>Tester local: POST /process</h1>
  <p>Cole ou edite o JSON abaixo e clique em <b>Enviar</b>.</p>
  <textarea id="payload">${JSON.stringify(sampleEnvelope, null, 2)}</textarea>
  <br />
  <button id="sendBtn">Enviar para /process</button>
  <p class="small">Dica: use um clinic_id em formato UUID (de preferencia um clinic_id real do seu banco).</p>
  <h3>Resposta</h3>
  <pre id="result">Aguardando envio...</pre>
  <script>
    const btn = document.getElementById('sendBtn');
    const payloadField = document.getElementById('payload');
    const result = document.getElementById('result');
    btn.addEventListener('click', async () => {
      result.textContent = 'Enviando...';
      let payload;
      try {
        payload = JSON.parse(payloadField.value);
      } catch (e) {
        result.textContent = 'JSON invalido: ' + e.message;
        return;
      }
      try {
        const resp = await fetch('/process', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const text = await resp.text();
        let parsed;
        try { parsed = JSON.parse(text); } catch { parsed = text; }
        result.textContent = JSON.stringify(
          { status: resp.status, statusText: resp.statusText, body: parsed },
          null,
          2
        );
      } catch (e) {
        result.textContent = 'Falha na requisicao: ' + e.message;
      }
    });
  </script>
</body>
</html>`);
  }

  res.set('Allow', 'POST');
  return res.status(405).json({
    error: 'method_not_allowed',
    message: 'Use POST /process com Content-Type: application/json.',
    allow: ['POST'],
    example_body: sampleEnvelope,
    examples: {
      curl:
        'curl -X POST http://localhost:3000/process -H "Content-Type: application/json" -d "{\\"correlation_id\\":\\"abc123456\\",\\"clinic_id\\":\\"09e5240f-9c26-47ee-a54d-02934a36ebfd\\",\\"from\\":\\"5511999999999\\",\\"message_text\\":\\"Quero marcar consulta amanha\\"}"',
      powershell:
        '$body = @{ correlation_id="abc123456"; clinic_id="09e5240f-9c26-47ee-a54d-02934a36ebfd"; from="5511999999999"; message_text="Quero marcar consulta amanha" } | ConvertTo-Json; Invoke-RestMethod -Method Post -Uri "http://localhost:3000/process" -ContentType "application/json" -Body $body',
    },
  });
});

// ======================================================
// UTILITÁRIOS DE LOGGING
// ======================================================

/**
 * Salva um turno da conversa (user + assistant) em conversation_history.
 * Chamado antes de retornar a resposta final. Nunca lança exceção.
 */
async function saveConversationTurn({ clinicId, fromNumber, correlationId, userText, assistantText, intentGroup, intent, slots }) {
  try {
    const { error } = await supabase.from('conversation_history').insert([
      {
        clinic_id: clinicId,
        from_number: fromNumber,
        wa_message_id: correlationId || null,
        role: 'user',
        message_text: userText,
        intent_group: intentGroup || null,
        intent: intent || null,
        slots: slots || null,
      },
      {
        clinic_id: clinicId,
        from_number: fromNumber,
        wa_message_id: null,
        role: 'assistant',
        message_text: assistantText,
        intent_group: intentGroup || null,
        intent: intent || null,
        slots: null,
      },
    ]);
    if (error) log.warn({ err: String(error) }, 'conversation_history_insert_failed');
  } catch (e) {
    log.warn({ err: String(e) }, 'conversation_history_insert_exception');
  }
}

/**
 * Registra na tabela agent_logs situações onde o agente não encontrou
 * informação na KB (knowledge gap), para popular a base proativamente.
 *
 * @param {string} clinicId
 * @param {string} correlationId
 * @param {string} question - pergunta original do paciente
 * @param {Object} context - contexto adicional (intent, slots, etc.)
 */
async function logKnowledgeGap(clinicId, correlationId, question, context) {
  try {
    await supabase.from('agent_logs').insert({
      clinic_id: clinicId,
      correlation_id: correlationId,
      log_type: 'knowledge_gap',
      extra_data: { question, context },
      latency_ms: 0,
    });
  } catch (e) {
    log.warn({ err: String(e) }, 'knowledge_gap_log_failed');
  }
}

/**
 * Loga decisões determinísticas do interceptor e transições de estado.
 * Quando ENABLE_AGENT_DECISION_LOGS=true, também salva em agent_decision_logs.
 */
async function logDecision(type, details, clinicId = null, fromNumber = null) {
  const entry = {
    timestamp: new Date().toISOString(),
    type, // 'interceptor_trigger' | 'state_transition' | 'tool_forced' | 'tool_validated' | 'session_timeout' | 'confirmation'
    ...details,
  };
  console.log(`[DECISION] ${JSON.stringify(entry)}`);

  if (process.env.ENABLE_AGENT_DECISION_LOGS === 'true' && clinicId) {
    try {
      await supabase.from('agent_decision_logs').insert({
        clinic_id: clinicId,
        from_number: fromNumber || 'unknown',
        decision_type: type,
        details: entry,
      });
    } catch (e) {
      // silencioso — não crítico
    }
  }
}

// ======================================================
// CÁLCULO DE CUSTO DE TOKENS (PONTO D — Conversation Tracking)
// ======================================================

/**
 * Calcula custo estimado de uma chamada OpenAI baseado nos tokens.
 * Preços do GPT-4.1 (atualizar se mudar de modelo).
 */
function calculateCost(promptTokens, completionTokens) {
  // Preços do GPT-4.1 por 1M tokens (verificar se mudou)
  const INPUT_PRICE_PER_1M = 2.00;    // USD por 1M tokens de input
  const OUTPUT_PRICE_PER_1M = 8.00;   // USD por 1M tokens de output

  const inputCost = (promptTokens / 1_000_000) * INPUT_PRICE_PER_1M;
  const outputCost = (completionTokens / 1_000_000) * OUTPUT_PRICE_PER_1M;

  return parseFloat((inputCost + outputCost).toFixed(6));
}

// ======================================================
// GERENCIAMENTO DE ESTADO PERSISTENTE
// ======================================================

/**
 * Carrega ou cria estado da conversa no banco.
 */
async function loadConversationState(supabase, clinicId, fromNumber) {
  const { data, error } = await supabase
    .from('conversation_state')
    .select('*')
    .eq('clinic_id', clinicId)
    .eq('from_number', fromNumber)
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error('Erro ao carregar estado:', error);
  }

  if (data) {
    if (new Date(data.expires_at) < new Date()) {
      console.log(`[STATE] Session expired (24h) for ${fromNumber} — resetting state`);
      logDecision('session_timeout', { reason: '24h_expires_at', from_number: fromNumber }, clinicId, fromNumber);
      return await resetConversationState(supabase, clinicId, fromNumber);
    }
    // Nova mensagem após agendamento confirmado → nova conversa
    if (data.state_json?.appointment_confirmed) {
      console.log('[STATE] Agendamento anterior confirmado — resetando estado para nova conversa');
      return await resetConversationState(supabase, clinicId, fromNumber);
    }

    // Check de timeout de 4h: se o estado de booking está ativo e ficou inativo por muito tempo
    const SESSION_TIMEOUT_HOURS = Number(process.env.SESSION_TIMEOUT_HOURS || 4);
    const stateJson = data.state_json || {};
    if (stateJson.last_activity_at) {
      const lastActivity = new Date(stateJson.last_activity_at);
      const hoursElapsed = (Date.now() - lastActivity.getTime()) / (1000 * 60 * 60);
      const bookingState = stateJson.booking_state;
      const activeStates = [BOOKING_STATES.COLLECTING_DATE, BOOKING_STATES.AWAITING_SLOTS,
                            BOOKING_STATES.COLLECTING_TIME, BOOKING_STATES.CONFIRMING];
      if (hoursElapsed > SESSION_TIMEOUT_HOURS && activeStates.includes(bookingState)) {
        console.log(`[STATE] Session timeout (${SESSION_TIMEOUT_HOURS}h) for ${fromNumber} — resetting booking state`);
        logDecision('session_timeout', {
          reason: `${SESSION_TIMEOUT_HOURS}h_booking_state`,
          hours_elapsed: hoursElapsed.toFixed(1),
          booking_state: bookingState,
          from_number: fromNumber,
        }, clinicId, fromNumber);
        // Não reseta tudo — apenas limpa dados de agendamento em andamento
        const resetUpdates = {
          ...stateJson,
          booking_state: BOOKING_STATES.IDLE,
          preferred_date: null,
          preferred_date_iso: null,
          preferred_time: null,
          last_suggested_slots: [],
          last_activity_at: new Date().toISOString(),
        };
        await supabase.from('conversation_state').update({
          state_json: resetUpdates,
          updated_at: new Date().toISOString(),
        }).eq('clinic_id', clinicId).eq('from_number', fromNumber);
        return resetUpdates;
      }
    }

    return stateJson;
  }

  return await resetConversationState(supabase, clinicId, fromNumber);
}

/**
 * Cria/reseta estado da conversa para valores iniciais.
 */
async function resetConversationState(supabase, clinicId, fromNumber) {
  const initialState = {
    patient_name: null,
    patient_phone: fromNumber,
    intent: null,
    doctor_id: null,
    doctor_name: null,
    specialty: null,
    service_id: null,
    service_name: null,
    preferred_date: null,
    preferred_date_iso: null,
    preferred_time: null,
    pending_fields: [],
    last_question_asked: null,
    conversation_stage: 'greeting',
    appointment_confirmed: false,
    // Memória operacional (anti-loop de disponibilidade)
    last_suggested_dates: [],
    last_suggested_slots: [],
    stuck_counter: {},
    // State machine de agendamento
    booking_state: BOOKING_STATES.IDLE,
    // Memória longa (running summary)
    running_summary: null,
    // Timestamp de última atividade (para timeout de 4h)
    last_activity_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from('conversation_state')
    .upsert({
      clinic_id: clinicId,
      from_number: fromNumber,
      state_json: initialState,
      turn_count: 0,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    }, { onConflict: 'clinic_id,from_number' });

  if (error) console.error('Erro ao resetar estado:', error);
  return initialState;
}

/**
 * Atualiza estado da conversa mesclando com o estado atual do banco.
 */
async function updateConversationState(supabase, clinicId, fromNumber, updates) {
  const { data: current } = await supabase
    .from('conversation_state')
    .select('state_json')
    .eq('clinic_id', clinicId)
    .eq('from_number', fromNumber)
    .single();

  const newState = {
    ...current?.state_json,
    ...updates,
    last_activity_at: new Date().toISOString(), // sempre atualizar para controle de timeout
  };

  const { error } = await supabase
    .from('conversation_state')
    .update({
      state_json: newState,
      updated_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    })
    .eq('clinic_id', clinicId)
    .eq('from_number', fromNumber);

  if (error) console.error('Erro ao atualizar estado:', error);
  return newState;
}

// ======================================================
// TAREFA 2 — FIX 2: Mapa expandido de sinônimos de especialidade
// ======================================================
// Valores reais do banco (com acentos): Dermatologia, Clínico Geral, Estética,
// Cardiologia, Ortopedia, Ginecologia, Pediatria, Nutrição, Psicologia
const SINONIMOS_ESPECIALIDADE = {
  // Formas coloquiais (sem acentos, lowercase) → nome exato no banco
  'cardiologista':     'Cardiologia',
  'cardiologia':       'Cardiologia',
  'ortopedista':       'Ortopedia',
  'ortopedia':         'Ortopedia',
  'dermatologista':    'Dermatologia',
  'dermatologia':      'Dermatologia',
  'ginecologista':     'Ginecologia',
  'ginecologia':       'Ginecologia',
  'pediatra':          'Pediatria',
  'pediatria':         'Pediatria',
  'neurologista':      'Neurologia',
  'neurologia':        'Neurologia',
  'psiquiatra':        'Psiquiatria',
  'psiquiatria':       'Psiquiatria',
  'urologista':        'Urologia',
  'urologia':          'Urologia',
  'oftalmo':           'Oftalmologia',
  'oftalmologista':    'Oftalmologia',
  'oftalmologia':      'Oftalmologia',
  'endocrino':         'Endocrinologia',
  'endocrinologista':  'Endocrinologia',
  'endocrinologia':    'Endocrinologia',
  'nutricionista':     'Nutrição',
  'nutricao':          'Nutrição',
  'nutri':             'Nutrição',
  'nutricionist':      'Nutrição',
  'psicologo':         'Psicologia',
  'psicologa':         'Psicologia',
  'psicologia':        'Psicologia',
  'psico':             'Psicologia',
  'psicoterapeuta':    'Psicologia',
  'esteticista':       'Estética',
  'estetica':          'Estética',
  'esteticien':        'Estética',
  'clinico geral':     'Clínico Geral',
  'clinico':           'Clínico Geral',
  'geral':             'Clínico Geral',
  'medico geral':      'Clínico Geral',
  'medico':            'Clínico Geral',
  'clinica geral':     'Clínico Geral',
}

/**
 * Normaliza variações linguísticas de especialidade antes do match.
 * TAREFA 2 FIX 2: Usa SINONIMOS_ESPECIALIDADE expandido.
 * Ex.: "cardiologista" → "cardiologia", "oftalmo" → "oftalmologia"
 * @param {string} input - Especialidade informada pelo paciente
 * @returns {string} Especialidade normalizada (sem acentos, lowercase)
 */
function normalizeSpecialty(input) {
  if (!input) return '';
  // Normalizar: lowercase + remover acentos
  const normalized = input.toLowerCase().trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, '').trim();

  // Verificar match exato no mapa
  if (SINONIMOS_ESPECIALIDADE[normalized]) {
    return SINONIMOS_ESPECIALIDADE[normalized];
  }

  // Verificar match parcial (ex: "cardiologista" contém "cardiologista")
  for (const [key, value] of Object.entries(SINONIMOS_ESPECIALIDADE)) {
    if (normalized.includes(key) || key.includes(normalized)) {
      return value;
    }
  }

  return normalized;
}

/**
 * Normaliza especialidade com fallback assíncrono no banco.
 * Se não houver match no mapa, busca via ILIKE no Supabase.
 * TAREFA 2 FIX 2: Fallback com query no banco.
 * @param {string} input - Especialidade informada pelo paciente
 * @param {object} supabaseClient - Cliente Supabase
 * @param {string} clinicId - UUID da clínica
 * @returns {Promise<string>} Especialidade normalizada
 */
async function normalizeSpecialtyWithFallback(input, supabaseClient, clinicId) {
  if (!input) return '';
  const fromMap = normalizeSpecialty(input);

  // Se o mapa retornou algo diferente do input normalizado, usar
  const inputNorm = input.toLowerCase().trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, '').trim();

  if (fromMap !== inputNorm) {
    return fromMap; // Match encontrado no mapa
  }

  // Fallback: buscar no banco via ILIKE
  try {
    const { data } = await supabaseClient
      .from('doctors')
      .select('specialty')
      .eq('clinic_id', clinicId)
      .ilike('specialty', `%${inputNorm}%`)
      .limit(1);

    if (data && data.length > 0) {
      const dbSpecialty = data[0].specialty.toLowerCase().trim()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9 ]/g, '').trim();
      console.log(`[FIX2] Especialidade resolvida via banco: '${input}' → '${dbSpecialty}'`);
      return dbSpecialty;
    }
  } catch (err) {
    console.error('[FIX2] Erro ao buscar especialidade no banco:', err.message);
  }

  return fromMap; // Retornar o que o mapa deu (mesmo que seja o input normalizado)
}

/**
 * Merge slots extraídos pelo LLM no estado persistente.
 * Valida especialidade e médico contra dados reais da clínica.
 * Suporta os dois naming conventions do extract_intent.
 */
async function mergeExtractedSlots(currentState, extractedSlots, doctors, services, supabaseClient, clinicId) {
  const updates = { ...currentState };

  // Nome do paciente
  if (extractedSlots.patient_name) {
    updates.patient_name = extractedSlots.patient_name;
  }

  // Especialidade (extract_intent usa 'specialty_or_reason')
  // TAREFA 2 FIX 2: Usar normalizeSpecialty expandido + persistir em specialty
  const specialtyInput = extractedSlots.specialty || extractedSlots.specialty_or_reason;
  if (specialtyInput) {
    // Usar versão com fallback no banco para especialidades não mapeadas
    const normalizedSpec = supabaseClient && clinicId
      ? await normalizeSpecialtyWithFallback(specialtyInput, supabaseClient, clinicId)
      : normalizeSpecialty(specialtyInput);
    console.log(`[FIX2] Especialidade normalizada (com fallback): '${specialtyInput}' → '${normalizedSpec}'`);
    const matchingDoctor = doctors.find(d => {
      const docSpec = d.specialty.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9 ]/g, '').trim();
      const inputNorm = normalizedSpec.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9 ]/g, '').trim();
      return docSpec.includes(inputNorm) || inputNorm.includes(docSpec);
    });
    if (matchingDoctor) {
      updates.specialty = matchingDoctor.specialty;
      updates.doctor_name = matchingDoctor.name;
      updates.doctor_id = matchingDoctor.id;
      console.log(`[FIX2] Especialidade "${specialtyInput}" → ${matchingDoctor.name} (${matchingDoctor.id})`);
    } else {
      // Persistir a especialidade normalizada mesmo sem match de médico
      // Isso garante que o valor fique no estado para o próximo turno
      updates.specialty = normalizedSpec;
      console.log(`[FIX2] Especialidade "${specialtyInput}" não encontrou médico. Normalizado: '${normalizedSpec}'. Disponíveis:`, doctors.map(d => d.specialty));
    }
  }

  // Médico específico (extract_intent usa 'doctor_preference')
  // CORREÇÃO 1: Matching robusto com remoção de prefixo Dr/Dra e busca parcial
  const doctorInput = extractedSlots.doctor_name || extractedSlots.doctor_preference;
  if (doctorInput) {
    // Normalizar: lowercase + remover acentos + remover prefixo Dr/Dra
    const normalizedDoc = doctorInput
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/^(dr\.?|dra\.?)\s*/i, '') // remove prefixo Dr/Dra
      .replace(/[^a-z0-9 ]/g, '')
      .trim();
    console.log(`[CORREÇÃO1] Buscando médico: '${doctorInput}' → normalizado: '${normalizedDoc}'`);
    // FIX v5.2: Usar scoring em vez de .find() para evitar falso positivo
    // Ex: "beatriz lima" matchava "julia lima" porque "lima" é token parcial
    let bestMatch = null;
    let bestScore = 0;
    for (const d of doctors) {
      const docNameNorm = d.name
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/^(dr\.?|dra\.?)\s*/i, '')
        .replace(/[^a-z0-9 ]/g, '')
        .trim();
      let score = 0;
      // Match exato (bidirecional)
      if (docNameNorm === normalizedDoc) { score = 100; }
      else if (docNameNorm.includes(normalizedDoc)) { score = 80; }
      else if (normalizedDoc.includes(docNameNorm)) { score = 80; }
      else {
        // Scoring por tokens: contar quantos tokens do input batem com o nome do banco
        const inputTokens = normalizedDoc.split(' ').filter(t => t.length > 2);
        const docTokens = docNameNorm.split(' ').filter(t => t.length > 2);
        const matchedTokens = inputTokens.filter(t => docTokens.includes(t));
        if (matchedTokens.length > 0) {
          // Score proporcional: mais tokens batendo = melhor match
          score = (matchedTokens.length / Math.max(inputTokens.length, docTokens.length)) * 60;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestMatch = d;
      }
    }
    const matchingDoctor = bestScore > 0 ? bestMatch : null;
    if (matchingDoctor) {
      updates.doctor_name = matchingDoctor.name;
      updates.doctor_id = matchingDoctor.id;
      updates.specialty = matchingDoctor.specialty;
      console.log(`[CORREÇÃO1] Médico encontrado: '${doctorInput}' → ${matchingDoctor.name} (${matchingDoctor.id})`);
    } else {
      console.warn(`[CORREÇÃO1] Médico NÃO encontrado: '${doctorInput}' (normalizado: '${normalizedDoc}'). Disponíveis:`, doctors.map(d => d.name));
    }
  }

  // Data (extract_intent usa 'preferred_date_text')
  // BUG 2 FIX: Resolver datas relativas (incluindo dias da semana) ANTES de salvar no estado
  const dateInput = extractedSlots.preferred_date_text || extractedSlots.preferred_date;
  if (dateInput) {
    // Tentar resolver para ISO (YYYY-MM-DD) antes de salvar
    const resolvedDate = resolveDateChoice(
      dateInput,
      currentState.last_suggested_dates || [],
      new Date()
    );
    if (resolvedDate) {
      updates.preferred_date = resolvedDate;
      updates.preferred_date_iso = resolvedDate;
      console.log(`[BUG2-FIX] Data resolvida: "${dateInput}" → ${resolvedDate}`);
    } else {
      // Tentar resolver como data ISO direta (YYYY-MM-DD)
      const isoPattern = /^\d{4}-\d{2}-\d{2}$/;
      if (isoPattern.test(dateInput)) {
        updates.preferred_date = dateInput;
        updates.preferred_date_iso = dateInput;
        console.log(`[BUG2-FIX] Data ISO direta: "${dateInput}"`);
      } else {
        // Manter texto original — LLM vai tentar interpretar depois
        updates.preferred_date = dateInput;
        if (extractedSlots.preferred_date_iso) {
          updates.preferred_date_iso = extractedSlots.preferred_date_iso;
        }
        console.log(`[BUG2-FIX] Data não resolvida, mantendo texto: "${dateInput}"`);
      }
    }
  }

  // Horário (extract_intent usa 'preferred_time_text')
  const timeInput = extractedSlots.preferred_time || extractedSlots.preferred_time_text;
  if (timeInput) {
    // FIX v5.1: Safety net — normalizar last_suggested_slots (pode ser objetos {date,time} ou strings)
    const rawSlots = currentState.last_suggested_slots || [];
    const normalizedSlots = rawSlots.map(s => typeof s === 'string' ? s : (s?.time || null)).filter(Boolean);
    // Tentar resolver para HH:MM antes de salvar
    const resolvedTime = resolveTimeChoice(
      timeInput,
      normalizedSlots
    );
    if (resolvedTime) {
      updates.preferred_time = resolvedTime;
      console.log(`[STATE] Horário resolvido: "${timeInput}" → ${resolvedTime}`);
    } else {
      updates.preferred_time = timeInput;
    }
  }

  updates.pending_fields = calculatePendingFields(updates);

  // Atualizar stuck_counter: incrementa campos que continuam pendentes
  const currentStuck = currentState.stuck_counter || {};
  const newStuck = { ...currentStuck };
  for (const field of updates.pending_fields) {
    newStuck[field] = (newStuck[field] || 0) + 1;
  }
  // Zerar contador de campos que foram preenchidos neste turno
  for (const field of Object.keys(newStuck)) {
    if (!updates.pending_fields.includes(field)) {
      newStuck[field] = 0;
    }
  }
  updates.stuck_counter = newStuck;

  updates.conversation_stage = determineConversationStage(updates);

  return updates;
}

/**
 * Calcula quais campos ainda faltam para agendar.
 */
function calculatePendingFields(state) {
  const pending = [];
  if (!state.patient_name) pending.push('patient_name');
  if (!state.specialty && !state.doctor_name) pending.push('specialty_or_doctor');
  if (!state.preferred_date) pending.push('preferred_date');
  if (!state.preferred_time) pending.push('preferred_time');
  return pending;
}

/**
 * Determina o estágio atual da conversa com base no estado.
 */
function determineConversationStage(state) {
  if (state.appointment_confirmed) return 'confirmed';
  if (state.pending_fields.length === 0) return 'ready_to_confirm';
  if (state.pending_fields.length === 1) return 'almost_complete';
  if (state.patient_name || state.specialty) return 'collecting_info';
  return 'greeting';
}

/**
 * Verifica se a nova resposta é muito similar à última pergunta feita.
 * Usa similaridade de Jaccard sobre palavras com mais de 3 letras.
 */
function isRepetition(newMessage, lastQuestion) {
  if (!lastQuestion) return false;

  const normalize = (text) => text.toLowerCase()
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 3)
    .sort()
    .join(' ');

  const setA = new Set(normalize(newMessage).split(' '));
  const setB = new Set(normalize(lastQuestion).split(' '));
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  if (union.size === 0) return false;
  return (intersection.size / union.size) > 0.7;
}

/**
 * Detecta se a mensagem do usuário é uma pergunta de disponibilidade.
 * Quando verdadeiro, o interceptor chama buscar_proximas_datas em vez de
 * perguntar "qual data você prefere?".
 */
function detectAvailabilityQuestion(text) {
  const normalized = text.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, ''); // remove acentos
  const patterns = [
    /disponiv/, /disponibilidade/, /quais dias/, /que dia/, /qual dia/,
    /tem agenda/, /tem horario/, /quais horarios/, /que horario/,
    /proximo/, /proxima/, /quando tem/, /quando voce/, /quando atende/,
  ];
  return patterns.some(p => p.test(normalized));
}

// ======================================================
// HELPERS DE DATA (nativos — sem library externa)
// ======================================================

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function formatISO(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function nextWeekday(referenceDate, targetDay) {
  const result = new Date(referenceDate);
  const currentDay = result.getDay();
  let daysUntil = targetDay - currentDay;
  if (daysUntil <= 0) daysUntil += 7;
  result.setDate(result.getDate() + daysUntil);
  return result;
}

function findClosestSlot(timeStr, slots) {
  if (!slots || slots.length === 0) return null;
  const [targetH, targetM] = timeStr.split(':').map(Number);
  const targetMinutes = targetH * 60 + (targetM || 0);
  let closest = null;
  let minDiff = Infinity;
  for (const rawSlot of slots) {
    // FIX v5.1: Guard — normalizar se for objeto {date, time}
    const slot = typeof rawSlot === 'string' ? rawSlot : (rawSlot?.time || null);
    if (!slot || typeof slot !== 'string' || !slot.includes(':')) continue;
    const [h, m] = slot.split(':').map(Number);
    if (isNaN(h) || isNaN(m)) continue;
    const diff = Math.abs((h * 60 + m) - targetMinutes);
    if (diff < minDiff) { minDiff = diff; closest = slot; }
  }
  return minDiff <= 60 ? closest : null; // máx 1h de diferença
}

// ======================================================
// RESOLUÇÃO DE ESCOLHAS RELATIVAS
// ======================================================

/**
 * Converte escolha relativa de data para ISO date string (YYYY-MM-DD).
 * Exemplos: "amanhã", "segunda", "semana que vem", "dia 15", "a primeira"
 * @param {string} userInput - texto do usuário
 * @param {Array} suggestedDates - last_suggested_dates do estado
 * @param {Date} referenceDate - data de referência (default: agora)
 * @returns {string|null} YYYY-MM-DD ou null se não resolver
 */
function resolveDateChoice(userInput, suggestedDates = [], referenceDate = new Date()) {
  if (!userInput) return null;
  const input = userInput.toLowerCase().trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, ''); // remove acentos

  // Referências posicionais (usam last_suggested_dates)
  if (/prim[ea]ira?|^1[ao°]?$|^1$/.test(input) && suggestedDates[0]) {
    return suggestedDates[0].date_iso || suggestedDates[0].formatted_date || null;
  }
  if (/segunda?|^2[ao°]?$|^2$/.test(input) && suggestedDates[1]) {
    return suggestedDates[1].date_iso || suggestedDates[1].formatted_date || null;
  }
  if (/terceira?|^3[ao°]?$|^3$/.test(input) && suggestedDates[2]) {
    return suggestedDates[2].date_iso || suggestedDates[2].formatted_date || null;
  }

  // Datas relativas
  if (/hoje/.test(input)) return formatISO(referenceDate);
  if (/amanha/.test(input)) return formatISO(addDays(referenceDate, 1));
  if (/semana que vem|proxima semana/.test(input)) return formatISO(addDays(referenceDate, 7));

  // Dias da semana: próxima ocorrência (BUG 2 FIX: suporte expandido a variações)
  const WEEKDAY_MAP = [
    { pattern: /\bsegunda([-\s]feira)?\b/, day: 1 },
    { pattern: /\b(terca|terça)([-\s]feira)?\b/, day: 2 },
    { pattern: /\bquarta([-\s]feira)?\b/, day: 3 },
    { pattern: /\bquinta([-\s]feira)?\b/, day: 4 },
    { pattern: /\bsexta([-\s]feira)?\b/, day: 5 },
    { pattern: /\b(sabado|sábado)\b/, day: 6 },
    { pattern: /\bdomingo\b/, day: 0 },
  ];
  for (const { pattern, day } of WEEKDAY_MAP) {
    if (pattern.test(input)) {
      const resolved = formatISO(nextWeekday(referenceDate, day));
      console.log(`[resolveDateChoice] Dia da semana detectado: '${userInput}' → ${resolved}`);
      return resolved;
    }
  }

  // Dia do mês: "dia 15", "15/03", "15 de março"
  const dayMatch = input.match(/(\d{1,2})\/(\d{1,2})/);
  if (dayMatch) {
    const d = parseInt(dayMatch[1]);
    const m = parseInt(dayMatch[2]) - 1;
    const year = referenceDate.getFullYear();
    const candidate = new Date(year, m, d);
    if (candidate >= referenceDate) return formatISO(candidate);
    return formatISO(new Date(year + 1, m, d));
  }

  const singleDayMatch = input.match(/^dia\s+(\d{1,2})$|^(\d{1,2})$/);
  if (singleDayMatch) {
    const d = parseInt(singleDayMatch[1] || singleDayMatch[2]);
    const now = referenceDate;
    let candidate = new Date(now.getFullYear(), now.getMonth(), d);
    if (candidate < now) candidate = new Date(now.getFullYear(), now.getMonth() + 1, d);
    if (!isNaN(candidate.getTime())) return formatISO(candidate);
  }

  return null; // não conseguiu resolver — LLM vai tentar de novo
}

/**
 * Converte escolha relativa de horário para "HH:MM".
 * Exemplos: "a primeira", "14h", "às 14", "de manhã", "à tarde"
 * @param {string} userInput - texto do usuário
 * @param {Array} suggestedSlots - last_suggested_slots do estado (strings "HH:MM")
 * @returns {string|null} "HH:MM" ou null se não resolver
 */
function resolveTimeChoice(userInput, suggestedSlots = []) {
  if (!userInput) return null;
  const input = userInput.toLowerCase().trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  // FIX v5.1: Normalizar last_suggested_slots — pode ser array de strings "HH:MM"
  // ou array de objetos {date, time}. Converter tudo para strings "HH:MM".
  const slots = suggestedSlots
    .map(s => typeof s === 'string' ? s : (s?.time || null))
    .filter(Boolean);

  // Referências posicionais
  if (/prim[ea]ira?|^1[ao°]?$|^1$/.test(input) && slots[0]) return slots[0];
  if (/segunda?|^2[ao°]?$|^2$/.test(input) && slots[1]) return slots[1];
  if (/terceira?|^3[ao°]?$|^3$/.test(input) && slots[2]) return slots[2];
  if (/quarta?|^4[ao°]?$|^4$/.test(input) && slots[3]) return slots[3];

  // Períodos do dia
  if (/manha/.test(input)) {
    const manha = slots.find(s => parseInt(s.split(':')[0]) < 12);
    if (manha) return manha;
  }
  if (/tarde/.test(input)) {
    const tarde = slots.find(s => {
      const h = parseInt(s.split(':')[0]);
      return h >= 12 && h < 18;
    });
    if (tarde) return tarde;
  }
  if (/noite/.test(input)) {
    const noite = slots.find(s => parseInt(s.split(':')[0]) >= 18);
    if (noite) return noite;
  }

  // Horário explícito: "14h", "14:00", "às 14", "14h30", "2pm"
  const hourMatch = input.match(/(\d{1,2})(?::(\d{2}))?h?/);
  if (hourMatch) {
    const h = hourMatch[1].padStart(2, '0');
    const m = hourMatch[2] || '00';
    const formatted = `${h}:${m}`;
    const exact = slots.find(s => s === formatted);
    if (exact) return exact;
    const closest = findClosestSlot(formatted, slots);
    if (closest) return closest;
    // Se não há lista de slots mas o horário parece válido, retornar mesmo assim
    if (parseInt(h) >= 6 && parseInt(h) <= 22) return formatted;
  }

  return null;
}

// ======================================================
// INTERCEPTORES DETERMINÍSTICOS
// ======================================================

/**
 * Deve ser executada ANTES do LLM a cada step.
 * Retorna uma `forcedToolCall` (ou null se o LLM pode decidir livremente).
 */
function applyDeterministicInterceptors(state, messageText) {
  const { doctor_id, preferred_date, preferred_time, booking_state } = state;

  // REGRA 1: Tem médico e data ISO válida, mas não tem horário → DEVE verificar disponibilidade
  // Guard: verificar se preferred_date é realmente um ISO (YYYY-MM-DD) antes de chamar a tool
  // Se for texto como "a primeira" ou "sexta", não passar para a tool (causaria DATA_INVALIDA)
  const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
  const preferredDateIsISO = preferred_date && ISO_DATE_PATTERN.test(preferred_date);

  if (doctor_id && preferredDateIsISO && !preferred_time && booking_state !== BOOKING_STATES.AWAITING_SLOTS) {
    return {
      tool: 'verificar_disponibilidade',
      params: { doctor_id, date: preferred_date },
      reason: 'guard_rail: date_set_no_time',
    };
  }

  // Se tem data mas não é ISO → dado ainda não foi resolvido pelo resolveDateChoice
  // O LLM vai tentar resolver ou pedir ao usuário que especifique melhor
  if (doctor_id && preferred_date && !preferredDateIsISO && !preferred_time) {
    console.log(`[INTERCEPTOR] preferred_date não-ISO detectado: "${preferred_date}" — aguardando resolução`);
  }

  // REGRA 2: Tem médico, mas não tem data → DEVE buscar próximas datas disponíveis
  // CORREÇÃO 2: Adicionar COLLECTING_DATE na lista de estados bloqueados para evitar loop
  // Quando booking_state já é COLLECTING_DATE, as datas já foram apresentadas ao paciente
  // e o sistema deve aguardar a escolha do paciente, não buscar novamente.
  if (doctor_id && !preferred_date &&
      booking_state !== BOOKING_STATES.AWAITING_SLOTS &&
      booking_state !== BOOKING_STATES.COLLECTING_DATE && // CORREÇÃO 2: evita loop após apresentar datas
      booking_state !== BOOKING_STATES.CONFIRMING &&
      booking_state !== BOOKING_STATES.BOOKED) {
    return {
      tool: 'buscar_proximas_datas',
      params: { doctor_id, dias: BUSCA_SLOTS_ABERTA_DIAS, busca_aberta: true },
      reason: 'guard_rail: doctor_set_no_date (busca_aberta)',
    };
  }

  // REGRA 3: Estado CONFIRMING — não chamar nenhuma tool, apenas aguardar "sim"/"não"
  if (booking_state === BOOKING_STATES.CONFIRMING) {
    return { tool: '__await_confirmation__', params: {}, reason: 'guard_rail: awaiting_confirmation' };
  }

  return null; // LLM decide livremente
}

// ======================================================
// VALIDAÇÃO DE RETORNO DE TOOLS
// ======================================================

/**
 * Valida o retorno de tools de disponibilidade antes de usar.
 */
function validateAvailabilityResult(toolResult, tool) {
  if (!toolResult || toolResult.error) {
    return {
      valid: false,
      // CORREÇÃO 2: Mensagem de fallback não promete busca futura (evita expectativa de loop)
      fallback: tool === 'verificar_disponibilidade'
        ? 'Não encontrei horários disponíveis nessa data. Gostaria de tentar outra data ou outro médico?'
        : 'Não consegui buscar as datas disponíveis no momento. Tente novamente em instantes.',
    };
  }

  if (tool === 'verificar_disponibilidade') {
    const slots = toolResult.slots || toolResult.available_slots || [];
    if (!Array.isArray(slots) || slots.length === 0) {
      return {
        valid: false,
        noSlots: true,
        // FIX-FALLBACK: Busca automática de alternativas será executada no bloco de tool execution
        fallback: 'Não há vagas nessa data. Buscando as próximas datas disponíveis...',
        // Preservar a data solicitada para usar como ponto de partida da busca alternativa
        requestedDate: toolResult.date || null,
      };
    }
  }

  return { valid: true };
}

// ======================================================
// CONFIRMAÇÃO OBRIGATÓRIA ANTES DE AGENDAR
// ======================================================

/**
 * Formata data ISO (YYYY-MM-DD) para pt-BR.
 */
function formatDateBR(dateStr) {
  if (!dateStr) return '[DATA NÃO DEFINIDA]';
  // Se já é formato pt-BR (DD/MM/YYYY), retornar direto
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(dateStr)) return dateStr;
  try {
    const date = new Date(dateStr + 'T00:00:00');
    return date.toLocaleDateString('pt-BR');
  } catch {
    return dateStr;
  }
}

/**
 * Gera mensagem de confirmação do agendamento para o usuário.
 * FIX v5.2: Inclui preço da consulta e informações de convênios.
 */
async function buildConfirmationMessage(state, doctorName, clinicName, clinicId) {
  const { preferred_date, preferred_time, patient_name, doctor_id } = state;
  const dateFormatted = formatDateBR(preferred_date);
  const doctor = doctorName || state.doctor_name || '[MÉDICO]';
  const clinic = clinicName || 'Clínica';

  // Buscar preço do serviço principal do médico
  let priceInfo = '';
  if (doctor_id && clinicId) {
    try {
      const { data: dsRows } = await supabase
        .from('doctor_services')
        .select('custom_price, service_id, services(name, price)')
        .eq('doctor_id', doctor_id)
        .eq('clinic_id', clinicId)
        .limit(5);
      if (dsRows && dsRows.length > 0) {
        // Usar custom_price se existir, senão price da tabela services
        // Pegar o primeiro serviço (consulta principal)
        const mainService = dsRows[0];
        const price = mainService.custom_price || mainService.services?.price;
        const serviceName = mainService.services?.name || 'Consulta';
        if (price) {
          const formatted = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(price);
          priceInfo = `💰 Valor: ${formatted} (${serviceName})`;
          if (dsRows.length > 1) {
            priceInfo += `\n   _Outros serviços disponíveis com este profissional_`;
          }
        }
      }
    } catch (e) {
      console.warn('[buildConfirmationMessage] Erro ao buscar preço:', e.message);
    }
  }

  // Buscar informações de convênios do clinic_kb
  let convenioInfo = '';
  if (clinicId) {
    try {
      const { data: kbRows } = await supabase
        .from('clinic_kb')
        .select('content')
        .eq('clinic_id', clinicId)
        .ilike('title', '%onvênio%')
        .limit(1);
      if (kbRows && kbRows.length > 0 && kbRows[0].content) {
        // Extrair só a parte relevante (ex: "Aceitamos: Unimed, Bradesco...")
        const content = kbRows[0].content;
        if (content.toLowerCase().includes('aceita')) {
          convenioInfo = `🏷️ ${content.split('.')[0]}.`; // primeira frase
        } else {
          convenioInfo = `🏷️ ${content}`;
        }
      }
    } catch (e) {
      console.warn('[buildConfirmationMessage] Erro ao buscar convênios:', e.message);
    }
  }

  let msg = `✅ *Confirmar agendamento?*\n\n` +
    `👤 Paciente: ${patient_name || 'não informado'}\n` +
    `👨‍⚕️ Médico: ${doctor}\n` +
    `📅 Data: ${dateFormatted}\n` +
    `🕐 Horário: ${preferred_time}\n` +
    `🏥 Clínica: ${clinic}`;

  if (priceInfo) msg += `\n${priceInfo}`;
  if (convenioInfo) msg += `\n\n${convenioInfo}`;

  msg += `\n\nPressione *Confirmar* para confirmar seu agendamento ou *Cancelar* para cancelar.`;

  return msg;
}

// ======================================================
// DYNAMIC SYSTEM PROMPT (com estado como fonte da verdade)
// ======================================================

// ======================================================
// RUNNING SUMMARY — Memória longa comprimida
// ======================================================

/**
 * Gera resumo comprimido a cada SUMMARY_TRIGGER_MESSAGES mensagens.
 * Salva em state.running_summary para injeção no system prompt.
 */
async function maybeGenerateSummary(conversationHistory, state, openaiClient) {
  const TRIGGER = Number(process.env.SUMMARY_TRIGGER_MESSAGES || 10);
  if (conversationHistory.length < TRIGGER) return state;
  if (conversationHistory.length % TRIGGER !== 0) return state;

  try {
    const historyText = conversationHistory
      .slice(-TRIGGER)
      .map(m => `${m.role}: ${m.content}`)
      .join('\n');

    const summaryResponse = await openaiClient.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [{
        role: 'user',
        content: `Resuma em 3-5 frases o que foi discutido nesta conversa de atendimento médico, ` +
          `focando em: nome do paciente, médico de interesse, datas mencionadas, intenção principal.\n\n` +
          `Conversa:\n${historyText}`,
      }],
      max_tokens: 200,
      temperature: 0.1,
    });

    const summary = summaryResponse.choices[0].message.content;
    const updatedState = { ...state, running_summary: summary };
    console.log(`[SUMMARY] Generated: ${summary.substring(0, 80)}...`);
    return updatedState;
  } catch (e) {
    console.warn('[SUMMARY] Failed to generate summary:', e.message);
    return state;
  }
}

// ======================================================
// DYNAMIC SYSTEM PROMPT (com estado como fonte da verdade)
// ======================================================

/**
 * Constrói o system prompt usando o estado persistente como fonte da verdade.
 * Substitui a abordagem anterior baseada em regex sobre previousMessages.
 */
const buildSystemPrompt = (clinicSettings, doctors, services, kbContext, conversationState) => {
  const doctorsList = doctors.map(d => `• ${d.name} — ${d.specialty}`).join('\n');
  const specialtiesList = [...new Set(doctors.map(d => d.specialty))].join(', ');

  // PRIORIDADE 2A — Injetar data atual dinamicamente
  const now = new Date();
  const DIAS_SEMANA_PT = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
  const CURRENT_DATE = now.toISOString().split('T')[0]; // YYYY-MM-DD
  const CURRENT_WEEKDAY = DIAS_SEMANA_PT[now.getDay()];
  const TOMORROW_DATE = new Date(now.getTime() + 86400000).toISOString().split('T')[0];

  const cs = conversationState || {};
  const stateDisplay = `
ESTADO ATUAL DA CONVERSA (FONTE DA VERDADE — NÃO PERGUNTE O QUE JÁ TEM):
${cs.patient_name ? `✅ Nome: ${cs.patient_name}` : '❌ Nome: PENDENTE'}
${cs.doctor_name ? `✅ Médico: ${cs.doctor_name} (${cs.specialty})` : cs.specialty ? `✅ Especialidade: ${cs.specialty}` : '❌ Médico/Especialidade: PENDENTE'}
${cs.preferred_date ? `✅ Data: ${cs.preferred_date}` : '❌ Data: PENDENTE'}
${cs.preferred_time ? `✅ Horário: ${cs.preferred_time}` : '❌ Horário: PENDENTE'}

ESTÁGIO: ${cs.conversation_stage || 'greeting'}
PRÓXIMO CAMPO A COLETAR: ${(cs.pending_fields || [])[0] || 'NENHUM — PRONTO PARA CONFIRMAR'}
${cs.last_question_asked ? `ÚLTIMA PERGUNTA FEITA (NÃO REPITA): "${cs.last_question_asked}"` : ''}
${(cs.last_suggested_dates || []).length > 0
  ? `DATAS JÁ APRESENTADAS AO PACIENTE: ${cs.last_suggested_dates.map((d, i) => `${i + 1}) ${d.day_of_week}, ${d.formatted_date}`).join(' | ')}`
  : ''}
${(cs.last_suggested_slots || []).length > 0
  ? `HORÁRIOS JÁ APRESENTADOS AO PACIENTE: ${cs.last_suggested_slots.map((s, i) => `${i + 1}) ${s}`).join(' | ')}`
  : ''}
`.trim();

  const summarySection = cs.running_summary
    ? `## RESUMO DA CONVERSA ANTERIOR:\n${cs.running_summary}\n\n---\n\n`
    : '';

  return `${summarySection}## IDENTIDADE
Você é Lara, secretária virtual da clínica. Seja acolhedora, profissional e humana.

## TOM DE VOZ
- Natural, como pessoa real
- Breve e direta
- Máximo 1-2 emojis (😊 📅 ✅)
- PROIBIDO: "Se precisar de mais informações, é só avisar!"
- PROIBIDO: Repetir perguntas já respondidas
- PROIBIDO: Fazer múltiplas perguntas de uma vez

## PRIORIDADE 5 — CLASSIFICAÇÃO DE INTENÇÃO (ANTES DE QUALQUER AÇÃO)

Antes de qualquer ação, classifique a mensagem do usuário em uma das categorias:

- **AGENDAMENTO**: usuário quer marcar, cancelar, remarcar ou verificar consulta
- **INFORMACAO**: usuário quer saber sobre médicos, horários, preços, endereço, convênio
- **CONVERSA**: cumprimentos, agradecimentos, despedidas, small talk, confirmações simples

Regras por categoria:
- Para **CONVERSA**: responda de forma natural e amigável em 1 frase. NÃO use nenhuma tool. NÃO tente agendar.
- Para **AGENDAMENTO** ou **INFORMACAO**: siga o fluxo normal de tools.

Exemplos de **CONVERSA** (não usar tools):
"obrigado", "ok", "entendi", "boa tarde", "tchau", "até mais", "perfeito", "certo", "👍", "sim obrigado"

---

## PRIORIDADE 2A — REGRAS DE DATA E HORÁRIO (OBRIGATÓRIO)

A data de hoje é: **${CURRENT_DATE}** (${CURRENT_WEEKDAY})
Amanhã é: **${TOMORROW_DATE}**

REGRAS OBRIGATÓRIAS antes de chamar verificar_disponibilidade:
1. Se o usuário disser um dia da semana (ex: "sexta", "segunda", "quarta-feira"), você DEVE calcular a data exata YYYY-MM-DD correspondente à próxima ocorrência desse dia.
2. "amanhã" = ${TOMORROW_DATE}
3. "hoje" = ${CURRENT_DATE}
4. "semana que vem" = próxima segunda-feira após hoje
5. NUNCA chame verificar_disponibilidade sem uma data no formato YYYY-MM-DD.
6. Se a tool retornar error: 'DATA_INVALIDA' ou error: 'DATA_PASSADA', informe o usuário claramente e peça uma nova data. NÃO tente novamente com a mesma entrada.
7. Se o usuário não informou nenhuma data, pergunte UMA VEZ qual data ou dia prefere. Não repita a pergunta.

## PRIORIDADE 4 — MOTOR DE ALTERNATIVAS (ANTI-LOOP)

Quando verificar_disponibilidade retornar vazio (sem slots) ou error:
1. Chame find_alternatives UMA Única VEZ com doctor_id e data.
2. Se encontrar alternativas, apresente de forma clara:
   - "A Dra. X não tem horário na sexta, mas tem vagas em [próxima data]"
   - OU "O Dr. Y (mesma especialidade) tem horário na sexta às [hora]"
3. Aguarde a escolha do usuário antes de prosseguir.
4. NUNCA chame verificar_disponibilidade ou find_alternatives mais de uma vez por turno de conversa.
5. Se find_alternatives também não encontrar nada, informe UMA Única VEZ que não há vagas.

## MÉDICOS DISPONÍVEIS
${doctorsList || 'Nenhum cadastrado'}

## ESPECIALIDADES
${specialtiesList || 'Nenhuma'}

## HORÁRIO
${clinicSettings?.policies_text || 'Segunda a sexta, 8h às 18h'}

## BASE DE CONHECIMENTO
${kbContext || 'Sem informações adicionais'}

---

${stateDisplay}

---

## REGRAS DE COMPORTAMENTO

### REGRA #1: NUNCA PERGUNTE O QUE JÁ TEM ✅
Se o estado mostra ✅, o dado já foi coletado. USE-O. Não pergunte novamente.

### REGRA #2: UMA PERGUNTA POR VEZ
Pergunte apenas UM campo pendente (❌) por mensagem.
Prioridade: 1) Especialidade/Médico → 2) Nome → 3) Data → 4) Horário

### REGRA #3: DISPONIBILIDADE — PROIBIDO INVENTAR ⚠️
NUNCA sugira datas ou horários que não tenham vindo de uma ferramenta (tool).
Se o paciente perguntar "que dia tem?", "quais horários?", "tem agenda?" ou similares:
- NÃO pergunte "qual data você prefere?" sem antes consultar a agenda.
- CHAME a ferramenta buscar_proximas_datas e mostre as datas reais retornadas.
Se o paciente escolher uma data específica:
- CHAME verificar_disponibilidade e liste apenas os horários retornados.
Se não houver horários na data pedida:
- Informe e ofereça as próximas datas (chame buscar_proximas_datas).

### REGRAS DE BUSCA DE DISPONIBILIDADE (ANTI-LOOP OBRIGATÓRIO)

1. Quando não encontrar horários na data solicitada, DEVE imediatamente executar nova busca
   para os próximos 14 dias a partir daquela data.

2. NUNCA repita a mesma mensagem de "não encontrei" duas vezes sem ter feito nova busca
   com intervalo maior.

3. Sempre que a busca específica falhar, apresente as próximas 3 datas disponíveis:
   "Não há vagas no dia X, mas encontrei em: [data 1], [data 2], [data 3]. Qual prefere?"

4. Só informe que não há vagas se a busca de 14 dias também não retornar resultados.

### REGRA #4: MEMÓRIA DE OPÇÕES APRESENTADAS
Se o paciente responder "a primeira", "a segunda", "de manhã", "o primeiro horário":
- Use DATAS JÁ APRESENTADAS ou HORÁRIOS JÁ APRESENTADOS (listados no estado acima) para resolver.
- Nunca peça para repetir uma escolha que já foi dada sobre opções que você apresentou.

### REGRA #5: ANTI-LOOP — STUCK COUNTER
${(cs.stuck_counter?.preferred_date || 0) >= 2
  ? '⚠️ ATENÇÃO: A data foi perguntada 2 ou mais vezes sem resposta. NÃO pergunte de novo. Chame buscar_proximas_datas e ofereça as opções diretamente.'
  : ''}
${(cs.stuck_counter?.preferred_time || 0) >= 2
  ? '⚠️ ATENÇÃO: O horário foi perguntado 2 ou mais vezes. NÃO pergunte de novo. Use verificar_disponibilidade se tiver a data, ou liste os períodos disponíveis (manhã/tarde).'
  : ''}

### REGRA #6: INTERRUPÇÕES NO MEIO DO AGENDAMENTO
Se o paciente fizer uma pergunta de informação (convênio, endereço, valores, horário da clínica, preço, parcelamento, duração, formas de pagamento):
1. Responda objetivamente e com todos os detalhes relevantes usando os dados da clínica.
2. Para perguntas sobre PREÇO: busque na lista de serviços abaixo e informe o valor. Se houver parcelamento, mencione.
3. Para perguntas sobre CONVÊNIOS: use as informações da base de conhecimento.
4. Para perguntas sobre DURAÇÃO: informe a duração do procedimento da lista de serviços.
5. NO FINAL, pergunte educadamente: "Posso ajudar com mais alguma informação ou gostaria de agendar uma consulta?"
6. NÃO force o agendamento. NÃO pergunte "com qual médico deseja agendar" a menos que o paciente demonstre interesse em agendar.
7. Se o paciente JÁ ESTÁ num fluxo de agendamento ativo (booking_state não é IDLE), aí sim retome o campo pendente após responder a dúvida.

### REGRA #7: QUANDO PERGUNTAREM SOBRE MÉDICOS/ESPECIALIDADES
Liste TODOS os médicos acima com suas especialidades. Depois pergunte com qual quer agendar.

### REGRA #8: VALIDAÇÃO
Se pedirem especialidade que NÃO existe na lista, diga educadamente e sugira as disponíveis.

### REGRA #9: CONFIRMAÇÃO (quando todos os campos estiverem preenchidos)
"${cs.patient_name || '[NOME]'}, confirmo sua consulta:
📅 ${cs.preferred_date || '[DATA]'} às ${cs.preferred_time || '[HORÁRIO]'}
👩‍⚕️ ${cs.doctor_name || '[MÉDICO]'}
Posso confirmar? 😊"

### REGRA #10: SAUDAÇÃO INICIAL
Se ESTÁGIO é "greeting", responda: "Olá! Sou a Lara, secretária virtual da clínica. Posso ajudar com agendamentos e informações. Como posso te ajudar hoje?"

### REGRA #11: NORMALIZAÇÃO DE DATA EM LINGUAGEM NATURAL (BUG 2 FIX)
Quando o usuário mencionar um dia da semana (ex: "sexta", "segunda-feira", "quinta"), você DEVE:
1. Calcular a data exata da PRÓXIMA ocorrência desse dia a partir de hoje
2. Converter para YYYY-MM-DD ANTES de chamar verificar_disponibilidade ou buscar_proximas_datas
3. NUNCA pedir ao usuário para confirmar a data numérica se ele já informou o dia da semana
4. Exemplos de conversão obrigatória:
   - "sexta feira" → calcular próxima sexta = YYYY-MM-DD exato
   - "segunda" → calcular próxima segunda = YYYY-MM-DD exato
   - "semana que vem" → hoje + 7 dias
   - "amanhã" → hoje + 1 dia
   - "essa semana" → buscar_proximas_datas com dias_ahead=7

### REGRA #12: LIMITE DE TENTATIVAS DE DISPONIBILIDADE (BUG 3 FIX)
Se verificar_disponibilidade retornar vazio ou erro:
1. Tente NO MÁXIMO 1 vez com parâmetros diferentes (ex: buscar_proximas_datas)
2. Após 2 tentativas sem resultado, informe o usuário UMA ÚNICA VEZ e peça nova preferência
3. NUNCA envie a mesma mensagem de "não encontrei horários" duas vezes seguidas sem ter feito nova busca
4. Se buscar_proximas_datas também não retornar resultados, informe UMA ÚNICA VEZ que não há vagas disponíveis
5. PROIBIDO: chamar a mesma tool mais de 2 vezes no mesmo ciclo de resposta

---

## FLUXO DE AGENDAMENTO: SEQUÊNCIA OBRIGATÓRIA (v4)

Ao agendar uma consulta, siga RIGOROSAMENTE esta sequência:

1. **ESPECIALIDADE/MÉDICO** — Pergunte qual especialidade ou médico o paciente deseja.
   Quando o paciente responder, resolva o médico e IMEDIATAMENTE chame a tool 'buscar_proximas_datas'
   com o doctor_id para obter os próximos horários disponíveis. NÃO pergunte a data antes de chamar a tool.

2. **DATA E HORÁRIO** — Apresente os horários disponíveis retornados pela tool e pergunte qual o paciente prefere.
   FORMATO OBRIGATÓRIO:
   "📅 A [nome do médico] ([especialidade]) tem os seguintes horários disponíveis:
   [dia da semana], [DD/MM] — [horário1], [horário2], [horário3]
   [dia da semana], [DD/MM] — [horário1], [horário2]
   Qual dia e horário você prefere?"
   NUNCA pergunte a data de forma aberta (ex: "Qual data você prefere?").
   SEMPRE mostre as opções disponíveis primeiro.

3. **NOME DO PACIENTE** — Pergunte o nome completo (se ainda não foi informado).
   NUNCA peça nome e data na mesma pergunta.

4. **CONFIRMAÇÃO** — Apresente um resumo e peça confirmação:
   "Vou confirmar:
   👨‍⚕️ [nome médico] — [especialidade]
   📅 [data] às [horário]
   👤 [nome paciente]
   Confirma o agendamento?"

5. **AGENDAR** — Somente após confirmação explícita ("sim", "confirmo", "pode agendar"),
   chame a tool 'criar_agendamento'.

REGRAS CRÍTICAS:
- Se o paciente pedir uma data que o médico não atende, NÃO diga apenas "não encontrei".
  Use a tool 'buscar_proximas_datas' para mostrar alternativas.
- NUNCA invente horários. Use SOMENTE dados retornados pelas tools.
- NUNCA repita a mesma pergunta que já foi respondida.
- Cada mensagem deve coletar NO MÁXIMO UM dado novo do paciente.
- Se você já tem especialidade + médico (✅ no estado), a PRÓXIMA AÇÃO DEVE SER chamar a tool 'buscar_proximas_datas'.
NUNCA envie a mesma mensagem duas vezes seguidas.

---

## CORREÇÃO 3 — EXTRAÇÃO DE SLOTS: MENSAGENS COMPOSTAS
IMPORTANTE: O paciente pode enviar múltiplos dados em UMA ÚNICA mensagem.
Sempre extraia TODOS os dados mencionados, mesmo que sejam especialidade + médico + data ao mesmo tempo.

Exemplos de mensagens compostas que você DEVE extrair completamente:
- 'quero ana santos dia 1 de março' → doctor='ana santos', date='2026-03-01'
- 'ginecologista, dra patricia, amanhã de manhã' → specialty='ginecologia', doctor='patricia', date='amanhã', period='manhã'
- 'marcar com cardiologista pra segunda' → specialty='cardiologia', date='próxima segunda'
- 'vou escolher ana santos, vou ter amanha e dia 1 de março 2026' → doctor='ana santos', date='amanhã'

Nunca descarte informações que o paciente já forneceu.
Se o paciente já disse o médico anteriormente no histórico, não pergunte novamente.

---

### REGRA #13: ENCERRAMENTO E RECUSAS
Quando o paciente disser algo que indique que NÃO quer continuar
(exemplos: 'não obrigada', 'não preciso', 'só isso',
'valeu', 'tchau', 'até logo', 'ok obrigado'):
1. NUNCA repita a última informação fornecida.
2. NUNCA ofereça novamente o serviço que foi recusado.
3. Responda com uma despedida CURTA e CORDIAL.
4. Exemplos de resposta adequada:
   - "Por nada! Qualquer coisa, é só chamar. Até logo!"
   - "Tudo bem! Estou aqui se precisar. Até mais!"
   - "Ok! Tenha um ótimo dia!"
5. NÃO faça novas perguntas após a despedida.
6. Se o paciente estava no meio de um agendamento e desiste,
   diga: "Sem problema! Se quiser retomar depois, é só chamar."

ATENÇÃO: Esta regra tem PRIORIDADE sobre qualquer outra.
Se há dúvida se o paciente quer continuar ou encerrar,
prefira encerrar educadamente. O paciente pode voltar a
qualquer momento enviando uma nova mensagem.
`.trim();
};

// ======================================================
// ROTA: GET /history — histórico de conversa por usuário
// ======================================================
app.get('/history', checkAgentAuth, async (req, res) => {
  const { from, clinic_id, limit = '10' } = req.query;

  if (!from || !clinic_id) {
    return res.status(400).json({ error: 'Parâmetros obrigatórios: from, clinic_id' });
  }

  const parsedLimit = Math.min(Number(limit) || 10, 30);

  const { data, error } = await supabase
    .from('conversation_history')
    .select('role, message_text')
    .eq('clinic_id', clinic_id)
    .eq('from_number', from)
    .order('created_at', { ascending: false })
    .limit(parsedLimit);

  if (error) {
    log.warn({ err: String(error) }, 'history_fetch_failed');
    return res.status(500).json({ error: 'Erro ao buscar histórico' });
  }

  // Inverter para ordem cronológica (mais antigo primeiro)
  const messages = (data || []).reverse().map(r => ({
    role: r.role,
    content: r.message_text,
  }));

  return res.json({ messages });
});

// ======================================================
// ROTA PRINCIPAL: /process
// ======================================================
app.post('/process', checkAgentAuth, async (req, res) => {
  const started = Date.now();
  const DEBUG = process.env.DEBUG === 'true';
  const MAX_STEPS = Number(process.env.AGENT_MAX_STEPS || 2);
  const GLOBAL_TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS || 12000);

  // 1) VALIDAR DADOS DE ENTRADA
  const parsed = EnvelopeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'invalid_envelope',
      details: parsed.error.flatten(),
    });
  }

  const envelope = parsed.data;

  // Helper: parser JSON seguro
  const safeJsonParse = (s) => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };

  // AbortController para timeout total da requisição (JG-P2-008)
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GLOBAL_TIMEOUT_MS);

  try {
    // ======================================================
    // COOLDOWN ATÔMICO — substitui o SELECT não-atômico anterior
    // O SELECT anterior tinha race condition: duas requisições simultâneas
    // passavam pelo guard porque ambas liam "sem resposta recente" antes
    // de qualquer uma terminar. Esta função SQL é atômica (UPDATE condicional).
    // ======================================================
    const COOLDOWN_SECONDS = Math.floor(Number(process.env.SESSION_COOLDOWN_MS || 10000) / 1000);
    try {
      const { data: lockAcquired, error: lockErr } = await supabase
        .rpc('try_acquire_processing_lock', {
          p_clinic_id: envelope.clinic_id,
          p_from_number: envelope.from,
          p_cooldown_seconds: COOLDOWN_SECONDS,
        });

      if (lockErr) {
        log.warn({ err: String(lockErr) }, '[LOCK] Erro ao tentar lock — continuando');
      } else if (lockAcquired === false) {
        log.info({ from: envelope.from }, '[LOCK] Lock não adquirido — requisição duplicada ignorada');
        clearTimeout(timeoutId);
        return res.json({
          correlation_id: envelope.correlation_id,
          final_message: null,
          actions: [{ type: 'cooldown_active' }],
        });
      }
    } catch (lockEx) {
      log.warn({ err: String(lockEx) }, '[LOCK] Exceção no lock — continuando sem proteção');
    }

    // ======================================================
    // 2) BUSCAR CONFIGURAÇÕES DA CLÍNICA
    // ======================================================
    const { data: settings, error: settingsErr } = await supabase
      .from('clinic_settings')
      .select('*')
      .eq('clinic_id', envelope.clinic_id)
      .maybeSingle();

    if (settingsErr) throw settingsErr;

    if (!settings) {
      log.warn(
        { clinic_id: envelope.clinic_id, correlation_id: envelope.correlation_id },
        'clinic_settings_not_found_using_defaults'
      );
    }

    const clinicRules = settings ?? {
      clinic_id: envelope.clinic_id,
      allow_prices: false,
      timezone: 'America/Cuiaba',
      business_hours: {
        mon: { open: '08:00', close: '18:00' },
        tue: { open: '08:00', close: '18:00' },
        wed: { open: '08:00', close: '18:00' },
        thu: { open: '08:00', close: '18:00' },
        fri: { open: '08:00', close: '18:00' },
        sat: {},
        sun: {},
      },
      policies_text: 'Atendemos de segunda a sexta, das 8h às 18h.',
    };

    // ======================================================
    // 3) BUSCAR BASE DE CONHECIMENTO (RAG)
    // ======================================================
    const { data: kbRows, error: kbErr } = await supabase
      .from('clinic_kb')
      .select('title, content')
      .eq('clinic_id', envelope.clinic_id)
      .limit(8);

    if (kbErr) throw kbErr;

    const kbContext = (kbRows ?? [])
      .map((r) => `• ${r.title}: ${r.content}`)
      .join('\n');

    // ======================================================
    // 3b) BUSCAR MÉDICOS, SERVIÇOS E ESTADO DA CONVERSA
    // ======================================================
    const [doctorsResult, servicesResult, conversationState] = await Promise.all([
      supabase
        .from('doctors')
        .select('id, name, specialty')
        .eq('clinic_id', envelope.clinic_id)
        .eq('active', true),
      supabase
        .from('services')
        .select('name, duration_minutes, price')
        .eq('clinic_id', envelope.clinic_id)
        .eq('active', true),
      loadConversationState(supabase, envelope.clinic_id, envelope.from),
    ]);
    const doctors = doctorsResult.data || [];
    const services = servicesResult.data || [];

    if (DEBUG) {
      log.debug({ state: conversationState }, 'conversation_state_loaded');
    }
    console.log('📊 Estado carregado:', JSON.stringify(conversationState, null, 2));

    if (DEBUG) {
      log.debug({ doctors: doctors.length, services: services.length }, 'clinic_data_loaded');
    }

    // — Conversation Tracking (ADITIVO — não altera fluxo existente) —
    let conversationRecord = null;
    try {
      conversationRecord = await getOrCreateConversation(
        supabase,
        envelope.clinic_id,
        envelope.from,
        conversationState?.id || null
      );
    } catch (trackingError) {
      console.warn('[ConversationTracker] Erro não-bloqueante:', trackingError.message);
      // NÃO interrompe o fluxo — tracking é best-effort
    }

    // Acumuladores de usage da OpenAI (para tracking de custo)
    let totalTokensInput = 0;
    let totalTokensOutput = 0;

    // ======================================================
    // 4) DEFINIR TOOLS (Function Calling)
    // ======================================================
    const tools = [
      {
        type: 'function',
        function: {
          name: 'extract_intent',
          strict: false, // 🔧 CORRIGIDO: strict false para evitar erros de schema
          description:
            'Classifica intenção (2 níveis) e extrai slots estruturados. Não escreve resposta ao usuário.',
          parameters: {
            type: 'object',
            properties: {
              intent_group: {
                type: 'string',
                enum: [
                  'scheduling',
                  'procedures',
                  'clinical',
                  'billing',
                  'logistics',
                  'results',
                  'other',
                ],
              },
              intent: { type: 'string' },
              slots: {
                type: 'object',
                properties: {
                  patient_name: { type: 'string' },
                  specialty_or_reason: { type: 'string' },
                  preferred_date_text: { type: 'string' },
                  preferred_time_text: { type: 'string' },
                  time_window: {
                    type: 'string',
                    enum: [
                      'morning',
                      'afternoon',
                      'evening',
                      'after_18',
                      'before_10',
                      'any',
                      'unknown',
                    ],
                  },
                  doctor_preference: { type: 'string' },
                  unit_preference: { type: 'string' },
                  procedure_name: { type: 'string' },
                  procedure_area: { type: 'string' },
                  goal: { type: 'string' },
                  price_request: { type: 'boolean' },
                  symptom_summary: { type: 'string' },
                  duration: { type: 'string' },
                  severity: { type: 'string' },
                  red_flags_present: {
                    type: 'array',
                    items: { type: 'string' },
                  },
                  comorbidities: { type: 'string' },
                  current_meds: { type: 'string' },
                  requested_care_type: { type: 'string' },
                  test_type: { type: 'string' },
                  result_status: { type: 'string' },
                  collection_date: { type: 'string' },
                  fasting_question: { type: 'boolean' },
                  abnormal_values_mentioned: { type: 'string' },
                  next_step_request: { type: 'string' },
                },
              },
              missing_fields: {
                type: 'array',
                items: { type: 'string' },
              },
              confidence: { type: 'number', minimum: 0, maximum: 1 },
            },
            required: ['intent_group', 'intent', 'confidence'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'decide_next_action',
          strict: false, // 🔧 CORRIGIDO: strict false para evitar erros de schema
          description:
            'Decide o próximo passo (policy), com base no extracted + regras + KB. Retorna mensagem curta e ações sugeridas.',
          parameters: {
            type: 'object',
            properties: {
              decision_type: {
                type: 'string',
                enum: ['ask_missing', 'block_price', 'handoff', 'proceed'],
              },
              message: { type: 'string' },
              actions: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    type: { type: 'string' },
                    payload: { type: 'object' },
                  },
                  required: ['type'],
                },
              },
              confidence: { type: 'number', minimum: 0, maximum: 1 },
            },
            required: ['decision_type', 'message'],
          },
        },
      },
    ];

    // ======================================================
    // 5) FEW-SHOT EXAMPLES
    // ======================================================
    const fewShots = `
Exemplo 1:
Usuário: "Quero marcar consulta amanhã de manhã"
extract_intent => {"intent_group":"scheduling","intent":"schedule_new","slots":{"time_window":"morning","preferred_date_text":"amanhã"},"missing_fields":["patient_name","specialty_or_reason"],"confidence":0.92}

Exemplo 2:
Usuário: "Quanto custa botox?"
extract_intent => {"intent_group":"billing","intent":"procedure_pricing_request","slots":{"procedure_name":"botox","price_request":true},"missing_fields":[],"confidence":0.95}
`.trim();

    // ======================================================
    // 6) LOOP CONTROLADO - STEP 0: extract_intent
    // ======================================================
    let step = 0;
    let extracted = null;
    let decided = null;
    let skipSchedulingAgent = false;
// Buscar histórico de conversas — usa o que o N8N enviou ou vai ao banco
let previousMessages = envelope.context?.previous_messages || [];

if (previousMessages.length === 0) {
  // CORREÇÃO Problema 2: buscar apenas as últimas 10 mensagens (evita timeout por excesso de tokens)
  const { data: historyRows } = await supabase
    .from('conversation_history')
    .select('role, message_text, created_at')
    .eq('clinic_id', envelope.clinic_id)
    .eq('from_number', envelope.from)
    .order('created_at', { ascending: false })
    .limit(10);

  if (historyRows && historyRows.length > 0) {
    // Inverter para ordem cronológica correta antes de passar ao OpenAI
    previousMessages = historyRows.reverse().map(r => ({
      role: r.role,
      content: r.message_text,
    }));
  } else {
    // CORREÇÃO Problema 1: histórico vazio (novo número ou deletado manualmente)
    // Resetar conversation_state para evitar que contexto antigo persista
    const currentState = conversationState;
    const hasStaleState = currentState && (
      currentState.doctor_id ||
      currentState.specialty ||
      currentState.preferred_date ||
      currentState.preferred_time ||
      (currentState.booking_state && currentState.booking_state !== 'idle')
    );
    if (hasStaleState) {
      console.log(`[HISTÓRICO] Histórico vazio mas estado antigo detectado — resetando conversation_state para ${envelope.from}`);
      logDecision('state_reset_on_empty_history', {
        reason: 'history_empty_stale_state_detected',
        stale_state: {
          doctor_id: currentState.doctor_id,
          specialty: currentState.specialty,
          booking_state: currentState.booking_state,
        },
      }, envelope.clinic_id, envelope.from);
      await resetConversationState(supabase, envelope.clinic_id, envelope.from);
      // Recarregar o estado resetado
      Object.assign(conversationState, await loadConversationState(supabase, envelope.clinic_id, envelope.from));
    }

    // CAMADA 2 — Cenário A: Primeira mensagem → retornar saudão com botões interativos
    // CORREÇÃO 4: Verificar se greeting já foi enviado recentemente (evita duplicação)
    // CORREÇÃO 2+4: Só retorna greeting se NÃO houver intent_override (botão clicado)
    const isFirstMessage = !envelope.intent_override;
    if (isFirstMessage) {
      // CORREÇÃO 4: Verificar se já existe um greeting recente no conversation_state
      // Isso evita duplicação quando duas mensagens chegam em rápida sucessão
      const greetingAlreadySent = conversationState?.greeting_sent_at &&
        (Date.now() - new Date(conversationState.greeting_sent_at).getTime()) < 10000; // 10s
      if (greetingAlreadySent) {
        console.log(`[CORREÇÃO 4] Greeting já enviado há menos de 10s para ${envelope.from} — bloqueando duplicação`);
        clearTimeout(timeoutId);
        return res.json({
          correlation_id: envelope.correlation_id,
          final_message: null,
          actions: [{ type: 'dedup_blocked', payload: { reason: 'greeting_already_sent' } }],
        });
      }
      const greetingMessage = 'Olá! Sou a Lara, secretária virtual da clínica. Como posso te ajudar?';
      // CORREÇÃO 2: Salvar histórico antes de retornar (evita loop de greeting)
      await saveConversationTurn({
        clinicId: envelope.clinic_id,
        fromNumber: envelope.from,
        correlationId: envelope.correlation_id,
        userText: envelope.message_text,
        assistantText: greetingMessage,
        intentGroup: 'other',
        intent: 'greeting',
        slots: null,
      });
      // CORREÇÃO 4: Marcar que greeting foi enviado no conversation_state
      await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
        greeting_sent_at: new Date().toISOString(),
        conversation_stage: 'greeting',
      });
      clearTimeout(timeoutId);
      return res.json({
        correlation_id: envelope.correlation_id,
        final_message: greetingMessage,
        actions: [{
          type: 'send_interactive_buttons',
          payload: {
            buttons: [
              { id: 'schedule_new',      title: '\uD83D\uDCC5 Agendar consulta' },   // 19 chars
              { id: 'view_appointments', title: '\uD83D\uDCCB Meus agendamentos' },   // 20 chars
              { id: 'ask_question',      title: '\u2753 Tirar uma dúvida' }, // 20 chars
            ],
          },
        }],
        debug: DEBUG ? { source: 'camada2_greeting' } : undefined,
      });
    }
  }
}

if (DEBUG) {
  log.debug({ count: previousMessages.length }, 'previous_messages_loaded');
}

// Construir array de mensagens incluindo histórico
const messages = [
  {
    role: 'system',
    content: [
      'Você é um classificador/estruturador. Sua única saída é JSON.',
      'Não gere texto para o usuário.',
      'Não invente dados. Se incerto, mantenha confidence baixa.',
      'Taxonomia: intent_group + intent.',
      'Use os slots definidos.',
      'Contexto KB (referência de domínio):',
      kbContext || 'SEM KB',
      '',
      fewShots,
    ].join('\n'),
  },
  // NOVO: Adicionar mensagens anteriores do histórico
  ...previousMessages.map(msg => ({
    role: msg.role === 'user' ? 'user' : 'assistant',
    content: msg.content
  })),
  // Mensagem atual
  {
    role: 'user',
    content: envelope.message_text,
  }
];

// NOVO: Log para debug
console.log(`📜 Histórico: ${previousMessages.length} mensagens anteriores`);

// Gerar summary comprimido se conversa está longa
let activeConvState = conversationState;
if (previousMessages.length > 0) {
  activeConvState = await maybeGenerateSummary(previousMessages, conversationState, openai);
  if (activeConvState.running_summary !== conversationState.running_summary) {
    await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
      running_summary: activeConvState.running_summary,
    });
  }
}

// ======================================================
// CAMADA 1: Se chegou intent_override de botão → pular extract_intent
// Isso elimina 1 chamada ao LLM e garante classificação 100% precisa
// ======================================================
if (envelope.intent_override) {
  console.log(`[INTENT_OVERRIDE] Intent pré-classificada por botão: ${envelope.intent_override}`);
  extracted = {
    intent_group: resolveIntentGroup(envelope.intent_override),
    intent: envelope.intent_override,
    slots: {},
    missing_fields: [],
    confidence: 1.0,
    source: 'button_override',
  };
  step = 1; // pular o step de extract_intent

  // FIX v5.2: Tratar view_appointments deterministicamente
  if (envelope.intent_override === 'view_appointments') {
    try {
      const appointments = await executeSchedulingTool(
        'listar_meus_agendamentos',
        { patient_phone: envelope.from },
        { clinicId: envelope.clinic_id, userPhone: envelope.from }
      );
      let viewMsg;
      if (appointments?.success && appointments?.appointments?.length > 0) {
        const list = appointments.appointments.map(a => 
          `📅 ${a.date || a.appointment_date} às ${a.time || a.start_time} — ${a.doctor_name || 'Médico'} (${a.status || 'agendado'})`
        ).join('\n');
        viewMsg = `Seus agendamentos:\n\n${list}\n\nDeseja remarcar, cancelar ou agendar uma nova consulta?`;
      } else {
        viewMsg = 'Você ainda não tem agendamentos. Gostaria de agendar uma consulta? 😊';
      }
      await saveConversationTurn({
        clinicId: envelope.clinic_id,
        fromNumber: envelope.from,
        correlationId: envelope.correlation_id,
        userText: envelope.message_text,
        assistantText: viewMsg,
        intentGroup: 'scheduling',
        intent: 'view_appointments',
        slots: null,
      });
      clearTimeout(timeoutId);
      return res.json({
        correlation_id: envelope.correlation_id,
        final_message: viewMsg,
        actions: [],
      });
    } catch (viewErr) {
      console.error('[VIEW_APPOINTMENTS] Erro:', viewErr);
    }
  }

  // FIX v5.3: Handler para botões "Esta semana" / "Próxima semana"
  if (envelope.intent_override === 'week_current' || envelope.intent_override === 'week_next') {
    const isCurrentWeek = envelope.intent_override === 'week_current';
    const allDates = conversationState?.last_suggested_dates || [];
    const doctorDisplayName = conversationState?.doctor_name || 'Médico';

    // Calcular intervalo da semana
    const now = new Date();
    const currentDay = now.getDay(); // 0=dom, 1=seg, ...
    let weekStart, weekEnd;
    if (isCurrentWeek) {
      weekStart = new Date(now);
      weekEnd = new Date(now);
      weekEnd.setDate(now.getDate() + (6 - currentDay)); // até sábado
    } else {
      weekStart = new Date(now);
      weekStart.setDate(now.getDate() + (7 - currentDay + 1)); // próxima segunda
      weekEnd = new Date(weekStart);
      weekEnd.setDate(weekStart.getDate() + 5); // até sábado
    }
    const weekStartStr = weekStart.toISOString().split('T')[0];
    const weekEndStr = weekEnd.toISOString().split('T')[0];

    // Filtrar datas da semana escolhida
    const weekDates = allDates.filter(d => {
      const dateStr = d.date_iso || d.date;
      return dateStr >= weekStartStr && dateStr <= weekEndStr;
    });

    // Filtrar horários passados no dia atual
    const todayStr = now.toISOString().split('T')[0];
    const currentTotalMin = now.getHours() * 60 + now.getMinutes();

    let weekMsg;
    if (weekDates.length > 0) {
      const label = isCurrentWeek ? 'Esta semana' : 'Próxima semana';
      weekMsg = `📅 *${doctorDisplayName}* — ${label}:\n\n`;
      weekDates.forEach(d => {
        let slots = d.slots || [];
        // Filtrar horários passados no dia atual
        if ((d.date_iso || d.date) === todayStr) {
          slots = slots.filter(s => {
            const [h, m] = s.split(':').map(Number);
            return (h * 60 + m) > currentTotalMin;
          });
        }
        if (slots.length > 0) {
          const slotsFormatted = slots.slice(0, 6).join(' · ');
          weekMsg += `📅 *${d.day_of_week}, ${d.formatted_date}*\n   ${slotsFormatted}\n\n`;
        }
      });
      weekMsg += `Qual dia e horário você prefere?`;
    } else {
      const otherLabel = isCurrentWeek ? 'próxima semana' : 'esta semana';
      weekMsg = `Não há horários disponíveis ${isCurrentWeek ? 'nesta' : 'na próxima'} semana. Gostaria de verificar ${otherLabel}?`;
    }

    await saveConversationTurn({
      clinicId: envelope.clinic_id,
      fromNumber: envelope.from,
      correlationId: envelope.correlation_id,
      userText: envelope.message_text,
      assistantText: weekMsg,
      intentGroup: 'scheduling',
      intent: envelope.intent_override,
      slots: null,
    });
    clearTimeout(timeoutId);
    return res.json({
      correlation_id: envelope.correlation_id,
      final_message: weekMsg,
      actions: [],
    });
  }

  // FIX v5.4: Handler para botão "Tirar uma dúvida"
  if (envelope.intent_override === 'ask_question') {
    const askMsg = `Claro! Posso te ajudar com informações sobre:\n\n` +
      `💰 Valores das consultas e procedimentos\n` +
      `🏷️ Convênios aceitos\n` +
      `💳 Formas de pagamento e parcelamento\n` +
      `⏱️ Duração dos procedimentos\n` +
      `👨‍⚕️ Especialidades disponíveis\n\n` +
      `O que você gostaria de saber?`;
    await saveConversationTurn({
      clinicId: envelope.clinic_id,
      fromNumber: envelope.from,
      correlationId: envelope.correlation_id,
      userText: envelope.message_text,
      assistantText: askMsg,
      intentGroup: 'other',
      intent: 'ask_question',
      slots: null,
    });
    clearTimeout(timeoutId);
    return res.json({
      correlation_id: envelope.correlation_id,
      final_message: askMsg,
      actions: [],
    });
  }
}

// ======================================================
// INTERCEPTOR DE ENCERRAMENTO / RECUSA (CORREÇÃO #16)
// Detecta quando o paciente recusa, agradece ou encerra
// a conversa, evitando loop de respostas desnecessárias.
// DEVE ser verificado ANTES do interceptor de agendamento.
// ======================================================
const ENCERRAMENTO_PATTERNS = [
  // Recusas diretas
  /^n[aã]o\s*(obrigad[ao]|,?\s*obrigad[ao])?$/i,
  /^n[aã]o\s*(preciso|quero|desejo|necessito)/i,
  /^n[aã]o\s*,?\s*(vlw|valeu|brigad[ao])/i,
  // Agradecimentos de encerramento
  /^(obrigad[ao]|brigad[ao]|vlw|valeu)\s*(!|\.)*$/i,
  /^(muito\s+)?obrigad[ao]/i,
  /^(agradec|thanks|thank)/i,
  // Despedidas
  /^(tchau|ate\s*(logo|mais|breve)|bye|flw|falou|fui)/i,
  /^(bom\s*dia|boa\s*(tarde|noite))\s*(!|\.)*$/i,
  // Encerramento implícito
  /^(s[oó]\s*(isso|era\s*isso)|era\s*s[oó]\s*isso|t[aá]\s*(bom|certo|ok))/i,
  /^(ok|beleza|blz|suave|tranquilo|perfeito)\s*(!|\.)*$/i,
  /^(entendi|entendido|certo)\s*(!|\.)*$/i,
  /^nada\s*(mais|n[aã]o)?$/i,
  /^(por\s*enquanto\s*)?[eé]\s*s[oó]$/i,
];

const normalizedMsgEncerramento = envelope.message_text.trim().toLowerCase()
  .replace(/[!?.]+$/g, '').trim();

const isEncerramento = ENCERRAMENTO_PATTERNS.some(
  pattern => pattern.test(normalizedMsgEncerramento)
);

if (isEncerramento) {
  console.log(`[INTERCEPTOR_ENCERRAMENTO] Encerramento detectado: "${normalizedMsgEncerramento}" | booking_state: ${conversationState?.booking_state || 'idle'}`);

  const shouldResetBooking = conversationState?.booking_state
    && conversationState.booking_state !== BOOKING_STATES.IDLE
    && conversationState.booking_state !== BOOKING_STATES.BOOKED;

  const encerramentoMsg = shouldResetBooking
    ? 'Tudo bem! Se quiser retomar o agendamento depois, é só me chamar. Até logo! 😊'
    : 'Por nada! Se precisar de algo, é só me chamar. Até logo! 😊';

  // Resetar estado da conversa
  await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
    booking_state: BOOKING_STATES.IDLE,
    pending_fields: [],
    last_question_asked: null,
    intent: null,
    running_summary: shouldResetBooking
      ? 'Paciente encerrou conversa durante agendamento.'
      : 'Paciente encerrou conversa após tirar dúvida.',
  });

  await saveConversationTurn({
    clinicId: envelope.clinic_id,
    fromNumber: envelope.from,
    correlationId: envelope.correlation_id,
    userText: envelope.message_text,
    assistantText: encerramentoMsg,
    intentGroup: 'other',
    intent: 'encerramento',
    slots: null,
  });

  clearTimeout(timeoutId);
  return res.json({
    correlation_id: envelope.correlation_id,
    final_message: encerramentoMsg,
    actions: [],
    debug: DEBUG ? { intercepted: true, type: 'encerramento', booking_reset: shouldResetBooking } : undefined,
  });
}

// ======================================================
// TAREFA 2 — FIX 1: Interceptor de intenções curtas
// Executa ANTES do LLM — zero latência para respostas simples
// ======================================================
const intentoDireto = interceptarIntencaoDireta(envelope.message_text);

if (intentoDireto) {
  console.log(`[FIX1] Intentão direta detectada: '${envelope.message_text}' → '${intentoDireto}' (sem LLM)`);

  // FIX v5.2: Tratar view_appointments por texto deterministicamente
  if (intentoDireto === 'view_appointments') {
    try {
      const appointments = await executeSchedulingTool(
        'listar_meus_agendamentos',
        { patient_phone: envelope.from },
        { clinicId: envelope.clinic_id, userPhone: envelope.from }
      );
      let viewMsg;
      if (appointments?.success && appointments?.appointments?.length > 0) {
        const list = appointments.appointments.map(a => 
          `📅 ${a.date || a.appointment_date} às ${a.time || a.start_time} — ${a.doctor_name || 'Médico'} (${a.status || 'agendado'})`
        ).join('\n');
        viewMsg = `Seus agendamentos:\n\n${list}\n\nDeseja remarcar, cancelar ou agendar uma nova consulta?`;
      } else {
        viewMsg = 'Você ainda não tem agendamentos. Gostaria de agendar uma consulta? 😊';
      }
      await saveConversationTurn({
        clinicId: envelope.clinic_id,
        fromNumber: envelope.from,
        correlationId: envelope.correlation_id,
        userText: envelope.message_text,
        assistantText: viewMsg,
        intentGroup: 'scheduling',
        intent: 'view_appointments',
        slots: null,
      });
      clearTimeout(timeoutId);
      return res.json({
        correlation_id: envelope.correlation_id,
        final_message: viewMsg,
        actions: [],
      });
    } catch (viewErr) {
      console.error('[VIEW_APPOINTMENTS-TEXT] Erro:', viewErr);
    }
  }

  // FIX v5.2: Tratar reschedule deterministicamente — listar agendamentos primeiro
  if (intentoDireto === 'reschedule') {
    try {
      const appointments = await executeSchedulingTool(
        'listar_meus_agendamentos',
        { patient_phone: envelope.from },
        { clinicId: envelope.clinic_id, userPhone: envelope.from }
      );
      let reschedMsg;
      if (appointments?.success && appointments?.appointments?.length > 0) {
        const upcoming = appointments.appointments.filter(a => 
          a.status === 'agendado' || a.status === 'scheduled' || a.status === 'confirmed'
        );
        if (upcoming.length > 0) {
          const list = upcoming.map((a, i) => 
            `${i + 1}. 📅 ${a.date || a.appointment_date} às ${a.time || a.start_time} — ${a.doctor_name || 'Médico'}`
          ).join('\n');
          reschedMsg = `Seus agendamentos atuais:\n\n${list}\n\nQual consulta você gostaria de reagendar?`;
        } else {
          reschedMsg = 'Você não tem agendamentos futuros para reagendar. Gostaria de agendar uma nova consulta? 😊';
        }
      } else {
        reschedMsg = 'Você não tem agendamentos para reagendar. Gostaria de agendar uma consulta? 😊';
      }
      await saveConversationTurn({
        clinicId: envelope.clinic_id,
        fromNumber: envelope.from,
        correlationId: envelope.correlation_id,
        userText: envelope.message_text,
        assistantText: reschedMsg,
        intentGroup: 'scheduling',
        intent: 'reschedule',
        slots: null,
      });
      clearTimeout(timeoutId);
      return res.json({
        correlation_id: envelope.correlation_id,
        final_message: reschedMsg,
        actions: [],
      });
    } catch (reschedErr) {
      console.error('[RESCHEDULE-TEXT] Erro:', reschedErr);
    }
  }

  // FIX v5.3: Handler "esta semana" / "próxima semana" por texto
  if (intentoDireto === 'week_current' || intentoDireto === 'week_next') {
    const isCurrentWeek = intentoDireto === 'week_current';
    const allDates = conversationState?.last_suggested_dates || [];
    const doctorDisplayName = conversationState?.doctor_name || 'Médico';

    const now = new Date();
    const currentDay = now.getDay();
    let weekStart, weekEnd;
    if (isCurrentWeek) {
      weekStart = new Date(now);
      weekEnd = new Date(now);
      weekEnd.setDate(now.getDate() + (6 - currentDay));
    } else {
      weekStart = new Date(now);
      weekStart.setDate(now.getDate() + (7 - currentDay + 1));
      weekEnd = new Date(weekStart);
      weekEnd.setDate(weekStart.getDate() + 5);
    }
    const weekStartStr = weekStart.toISOString().split('T')[0];
    const weekEndStr = weekEnd.toISOString().split('T')[0];

    const weekDates = allDates.filter(d => {
      const dateStr = d.date_iso || d.date;
      return dateStr >= weekStartStr && dateStr <= weekEndStr;
    });

    const todayStr = now.toISOString().split('T')[0];
    const currentTotalMin = now.getHours() * 60 + now.getMinutes();

    let weekMsg;
    if (weekDates.length > 0) {
      const label = isCurrentWeek ? 'Esta semana' : 'Próxima semana';
      weekMsg = `📅 *${doctorDisplayName}* — ${label}:\n\n`;
      weekDates.forEach(d => {
        let slots = d.slots || [];
        if ((d.date_iso || d.date) === todayStr) {
          slots = slots.filter(s => {
            const [h, m] = s.split(':').map(Number);
            return (h * 60 + m) > currentTotalMin;
          });
        }
        if (slots.length > 0) {
          const slotsFormatted = slots.slice(0, 6).join(' · ');
          weekMsg += `📅 *${d.day_of_week}, ${d.formatted_date}*\n   ${slotsFormatted}\n\n`;
        }
      });
      weekMsg += `Qual dia e horário você prefere?`;
    } else {
      const otherLabel = isCurrentWeek ? 'próxima semana' : 'esta semana';
      weekMsg = `Não há horários disponíveis ${isCurrentWeek ? 'nesta' : 'na próxima'} semana. Gostaria de verificar ${otherLabel}?`;
    }

    await saveConversationTurn({
      clinicId: envelope.clinic_id,
      fromNumber: envelope.from,
      correlationId: envelope.correlation_id,
      userText: envelope.message_text,
      assistantText: weekMsg,
      intentGroup: 'scheduling',
      intent: intentoDireto,
      slots: null,
    });
    clearTimeout(timeoutId);
    return res.json({
      correlation_id: envelope.correlation_id,
      final_message: weekMsg,
      actions: [],
    });
  }

  extracted = {
    intent_group: intentoDireto === 'cancel' ? 'scheduling' : (intentoDireto === 'info' ? 'other' : 'scheduling'),
    intent: intentoDireto,
    slots: {},
    missing_fields: [],
    confidence: 1.0,
    source: 'direct_map',
  };
  step++;
} else {
  const extraction = await openai.chat.completions.create(
    {
      model: OPENAI_MODEL,
      messages: messages,
      tools: [tools[0]],
      tool_choice: { type: 'function', function: { name: 'extract_intent' } },
      temperature: 0.3,
    },
    { signal: controller.signal }
  );

  // Acumular usage da chamada extract_intent
  if (extraction.usage) {
    totalTokensInput += extraction.usage.prompt_tokens || 0;
    totalTokensOutput += extraction.usage.completion_tokens || 0;
  }

  // Parse resultado da extração (JG-P0-002)
  const callExtract = extraction.choices[0]?.message?.tool_calls?.[0];
  extracted = callExtract?.function?.arguments
    ? safeJsonParse(callExtract.function.arguments)
    : null;

  // FIX v5.4: Se detectInfoQuestion() identifica pergunta informativa E o paciente
  // NÃO está num fluxo de agendamento ativo → forçar intent_group = 'other'
  // Isso impede que o scheduling agent rode e deixa o LLM responder naturalmente
  const bookingState = conversationState?.booking_state || BOOKING_STATES.IDLE;
  const isInfoQuery = detectInfoQuestion(envelope.message_text);
  if (isInfoQuery && bookingState === BOOKING_STATES.IDLE && extracted) {
    console.log(`[INFO_DETECT] Pergunta informativa detectada: "${envelope.message_text}" — forçando intent_group='other'`);
    extracted.intent_group = 'other';
    extracted.intent = extracted.intent || 'info_query';
  }

  step++;
}

if (DEBUG) {
  log.debug({ extracted }, 'extraction_result');
}

// ========== MERGEAR SLOTS NO ESTADO PERSISTENTE ==========
const updatedState = await mergeExtractedSlots(
  activeConvState,
  extracted?.slots || {},
  doctors,
  services,
  supabase,            // cliente Supabase disponível no escopo da rota
  envelope.clinic_id
);

// Salvar estado atualizado (sem sobrescrever last_question_asked ainda)
await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
  ...updatedState,
  intent: extracted?.intent || conversationState.intent,
});

// Se doctor_id foi resolvido agora e booking_state ainda é IDLE → avançar para COLLECTING_DATE
if (updatedState.doctor_id && !activeConvState.doctor_id &&
    (!updatedState.booking_state || updatedState.booking_state === BOOKING_STATES.IDLE || updatedState.booking_state === BOOKING_STATES.COLLECTING_SPECIALTY)) {
  console.log(`[STATE] doctor_id preenchido - mantendo COLLECTING_SPECIALTY para interceptor`);
  if (updatedState.booking_state !== BOOKING_STATES.COLLECTING_SPECIALTY) {
    await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
      booking_state: BOOKING_STATES.COLLECTING_SPECIALTY,
    });
    updatedState.booking_state = BOOKING_STATES.COLLECTING_SPECIALTY;
  }
  logDecision('state_transition', {
    from: BOOKING_STATES.IDLE,
    to: BOOKING_STATES.COLLECTING_SPECIALTY,
    trigger: 'doctor_id_resolved',
    doctor_id: updatedState.doctor_id,
    doctor_name: updatedState.doctor_name,
  }, envelope.clinic_id, envelope.from);
}

console.log('📊 Estado após merge:', JSON.stringify(updatedState, null, 2));

    // ======================================================
    // 7) CONFIDENCE GUARD + TAREFA 2 FIX 3: PRESERVAÇÃO DE ESTADO
    // Não resetar estado quando mensagem é inesperada mas há fluxo ativo.
    // ======================================================
    if (!extracted || extracted.confidence < 0.6) {
      // FIX 3: Verificar se há fluxo ativo de agendamento
      const activeBookingStates = [
        BOOKING_STATES.COLLECTING_SPECIALTY,
        BOOKING_STATES.COLLECTING_DATE,
        BOOKING_STATES.AWAITING_SLOTS,
        BOOKING_STATES.COLLECTING_TIME,
        BOOKING_STATES.CONFIRMING,
        BOOKING_STATES.COLLECTING_DOCTOR,
      ];
      const hasActiveFlow = activeBookingStates.includes(conversationState.booking_state)
        || conversationState.doctor_id
        || conversationState.specialty;

      // Verificar se é intenção explícita de cancelar
      const isCancelIntent = /cancelar|desistir|não quero|nao quero|para|chega/i.test(envelope.message_text);

      if (hasActiveFlow && !isCancelIntent) {
        // FIX 3: Preservar estado — incrementar stuck_counter_off_topic
        const currentStuckOffTopic = (conversationState.stuck_counter_off_topic || 0) + 1;
        await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
          stuck_counter_off_topic: currentStuckOffTopic,
        });
        console.log(`[FIX3] Mensagem fora do fluxo. Estado preservado. stuck_counter_off_topic=${currentStuckOffTopic}`);

        if (currentStuckOffTopic >= STUCK_LIMIT) {
          // Fallback definitivo após STUCK_LIMIT mensagens fora do fluxo
          await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
            booking_state: BOOKING_STATES.IDLE,
            stuck_counter_off_topic: 0,
            doctor_id: null,
            specialty: null,
            preferred_date: null,
            preferred_time: null,
          });
          const stuckLimitMsg = 'Parece que você saiu do fluxo de agendamento. Quando quiser, é só me dizer: você quer marcar, remarcar, cancelar ou tirar uma dúvida?';
          // CORREÇÃO 2: Salvar histórico antes de retornar
          await saveConversationTurn({
            clinicId: envelope.clinic_id,
            fromNumber: envelope.from,
            correlationId: envelope.correlation_id,
            userText: envelope.message_text,
            assistantText: stuckLimitMsg,
            intentGroup: 'other',
            intent: 'stuck_limit',
            slots: null,
          });
          clearTimeout(timeoutId);
          return res.json({
            correlation_id: envelope.correlation_id,
            final_message: stuckLimitMsg,
            actions: [],
            debug: DEBUG ? { fix3: 'stuck_limit_reached', stuck_counter_off_topic: currentStuckOffTopic } : undefined,
          });
        }

        // Retornar mensagem de contexto mantendo o estado
        const specialtyDisplay = conversationState.specialty || conversationState.doctor_name;
        const contextMsg = specialtyDisplay
          ? `Ainda estou buscando horários para ${specialtyDisplay}. Um momento por favor... Se quiser continuar o agendamento, é só me dizer a data de preferência.`
          : `Ainda estou aqui para te ajudar! Você quer marcar, remarcar, cancelar ou tirar uma dúvida?`;

        // CORREÇÃO 2: Salvar histórico antes de retornar
        await saveConversationTurn({
          clinicId: envelope.clinic_id,
          fromNumber: envelope.from,
          correlationId: envelope.correlation_id,
          userText: envelope.message_text,
          assistantText: contextMsg,
          intentGroup: 'other',
          intent: 'state_preserved',
          slots: null,
        });
        clearTimeout(timeoutId);
        return res.json({
          correlation_id: envelope.correlation_id,
          final_message: contextMsg,
          actions: [],
          debug: DEBUG ? { fix3: 'state_preserved', booking_state: conversationState.booking_state, specialty: conversationState.specialty } : undefined,
        });
      }

      // Sem fluxo ativo — comportamento original
      const noFlowMsg = 'Só para confirmar: você quer marcar, remarcar, cancelar ou tirar uma dúvida?';
      // CORREÇÃO 2: Salvar histórico antes de retornar
      await saveConversationTurn({
        clinicId: envelope.clinic_id,
        fromNumber: envelope.from,
        correlationId: envelope.correlation_id,
        userText: envelope.message_text,
        assistantText: noFlowMsg,
        intentGroup: 'other',
        intent: 'no_flow',
        slots: null,
      });
      clearTimeout(timeoutId);
      return res.json({
        correlation_id: envelope.correlation_id,
        final_message: noFlowMsg,
        actions: [],
        debug: DEBUG ? { extracted } : undefined,
      });
    }

    // ======================================================
    // 7b) CHECK DE ESTADO CONFIRMING (ANTES do LLM)
    // Quando todos os campos estão preenchidos → pedir confirmação.
    // Quando usuário responde SIM/NÃO → executar ação.
    // ======================================================
    const allFieldsReady = (state) => calculatePendingFields(state).length === 0;
    const userSaidConfirmation = envelope.message_text.toLowerCase().trim();

    if (updatedState.booking_state === BOOKING_STATES.CONFIRMING) {
      logDecision('confirmation', {
        user_said: userSaidConfirmation,
        booking_state: BOOKING_STATES.CONFIRMING,
      }, envelope.clinic_id, envelope.from);

      // CAMADA 1: Botão de confirmação tem prioridade sobre regex
      if (envelope.intent_override === 'confirm_yes') {
        // Ir direto para BOOKED
        const newState = await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
          booking_state: BOOKING_STATES.BOOKED,
        });
        Object.assign(updatedState, newState);
        logDecision('state_transition', {
          from: BOOKING_STATES.CONFIRMING,
          to: BOOKING_STATES.BOOKED,
          trigger: 'button_confirm_yes',
        }, envelope.clinic_id, envelope.from);
        // FIX v5.1: Chamar criar_agendamento DETERMINISTICAMENTE (sem depender do LLM)
        try {
          const agendResult = await executeSchedulingTool(
            'criar_agendamento',
            {
              doctor_id: updatedState.doctor_id,
              patient_name: updatedState.patient_name,
              patient_phone: envelope.from,
              data: updatedState.preferred_date_iso || updatedState.preferred_date,
              horario: updatedState.preferred_time,
              service_id: updatedState.service_id || null,
              observacoes: null,
            },
            { clinicId: envelope.clinic_id, userPhone: envelope.from }
          );
          console.log('[CONFIRM] criar_agendamento result:', JSON.stringify(agendResult));
          const successMsg = agendResult?.success
            ? `✅ Agendamento confirmado!\n\n👤 Paciente: ${updatedState.patient_name}\n👨‍⚕️ Médico: ${updatedState.doctor_name}\n📅 Data: ${updatedState.preferred_date_iso || updatedState.preferred_date}\n🕐 Horário: ${updatedState.preferred_time}\n\nAté lá! Se precisar de algo, é só chamar. 😊`
            : `Não foi possível concluir o agendamento: ${agendResult?.message || 'erro desconhecido'}. Tente novamente ou fale com um atendente.`;
          // Marcar como confirmado no state
          await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
            appointment_confirmed: agendResult?.success || false,
          });
          await saveConversationTurn({
            clinicId: envelope.clinic_id,
            fromNumber: envelope.from,
            correlationId: envelope.correlation_id,
            userText: envelope.message_text,
            assistantText: successMsg,
            intentGroup: 'scheduling',
            intent: 'confirm_yes',
            slots: null,
          });
          clearTimeout(timeoutId);
          return res.json({
            correlation_id: envelope.correlation_id,
            final_message: successMsg,
            actions: [],
            debug: DEBUG ? { agendResult } : undefined,
          });
        } catch (agendErr) {
          console.error('[CONFIRM] Erro ao criar agendamento:', agendErr);
          const errMsg = 'Houve um erro ao confirmar seu agendamento. Por favor, tente novamente ou fale com um atendente.';
          await saveConversationTurn({
            clinicId: envelope.clinic_id,
            fromNumber: envelope.from,
            correlationId: envelope.correlation_id,
            userText: envelope.message_text,
            assistantText: errMsg,
            intentGroup: 'scheduling',
            intent: 'confirm_yes_error',
            slots: null,
          });
          clearTimeout(timeoutId);
          return res.json({
            correlation_id: envelope.correlation_id,
            final_message: errMsg,
            actions: [],
          });
        }
      } else if (envelope.intent_override === 'confirm_no') {
        // Ir direto para IDLE + cancelar
        const newState = await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
          booking_state: BOOKING_STATES.IDLE,
          preferred_date: null,
          preferred_date_iso: null,
          preferred_time: null,
        });
        logDecision('state_transition', {
          from: BOOKING_STATES.CONFIRMING,
          to: BOOKING_STATES.IDLE,
          trigger: 'button_confirm_no',
        }, envelope.clinic_id, envelope.from);
        const cancelMsg1 = 'Tudo bem! O agendamento foi cancelado. O que você gostaria de fazer? 😊';
        // CORREÇÃO 2: Salvar histórico antes de retornar
        await saveConversationTurn({
          clinicId: envelope.clinic_id,
          fromNumber: envelope.from,
          correlationId: envelope.correlation_id,
          userText: envelope.message_text,
          assistantText: cancelMsg1,
          intentGroup: 'scheduling',
          intent: 'confirm_no',
          slots: null,
        });
        clearTimeout(timeoutId);
        return res.json({
          correlation_id: envelope.correlation_id,
          final_message: cancelMsg1,
          actions: [],
          debug: DEBUG ? { state: newState } : undefined,
        });
      } else if (/^sim|^s$|confirmar|^ok$|^yes/.test(userSaidConfirmation)) {
        // Usuário confirmou → avançar para BOOKED e criar agendamento
        const newState = await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
          booking_state: BOOKING_STATES.BOOKED,
        });
        Object.assign(updatedState, newState);
        logDecision('state_transition', {
          from: BOOKING_STATES.CONFIRMING,
          to: BOOKING_STATES.BOOKED,
          trigger: 'user_confirmed',
        }, envelope.clinic_id, envelope.from);
        // FIX v5.1: Chamar criar_agendamento DETERMINISTICAMENTE (sem depender do LLM)
        try {
          const agendResult = await executeSchedulingTool(
            'criar_agendamento',
            {
              doctor_id: updatedState.doctor_id,
              patient_name: updatedState.patient_name,
              patient_phone: envelope.from,
              data: updatedState.preferred_date_iso || updatedState.preferred_date,
              horario: updatedState.preferred_time,
              service_id: updatedState.service_id || null,
              observacoes: null,
            },
            { clinicId: envelope.clinic_id, userPhone: envelope.from }
          );
          console.log('[CONFIRM-TEXT] criar_agendamento result:', JSON.stringify(agendResult));
          const successMsg = agendResult?.success
            ? `✅ Agendamento confirmado!\n\n👤 Paciente: ${updatedState.patient_name}\n👨‍⚕️ Médico: ${updatedState.doctor_name}\n📅 Data: ${updatedState.preferred_date_iso || updatedState.preferred_date}\n🕐 Horário: ${updatedState.preferred_time}\n\nAté lá! Se precisar de algo, é só chamar. 😊`
            : `Não foi possível concluir o agendamento: ${agendResult?.message || 'erro desconhecido'}. Tente novamente ou fale com um atendente.`;
          await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
            appointment_confirmed: agendResult?.success || false,
          });
          await saveConversationTurn({
            clinicId: envelope.clinic_id,
            fromNumber: envelope.from,
            correlationId: envelope.correlation_id,
            userText: envelope.message_text,
            assistantText: successMsg,
            intentGroup: 'scheduling',
            intent: 'confirm_yes',
            slots: null,
          });
          clearTimeout(timeoutId);
          return res.json({
            correlation_id: envelope.correlation_id,
            final_message: successMsg,
            actions: [],
            debug: DEBUG ? { agendResult } : undefined,
          });
        } catch (agendErr) {
          console.error('[CONFIRM-TEXT] Erro ao criar agendamento:', agendErr);
          const errMsg = 'Houve um erro ao confirmar seu agendamento. Por favor, tente novamente ou fale com um atendente.';
          await saveConversationTurn({
            clinicId: envelope.clinic_id,
            fromNumber: envelope.from,
            correlationId: envelope.correlation_id,
            userText: envelope.message_text,
            assistantText: errMsg,
            intentGroup: 'scheduling',
            intent: 'confirm_yes_error',
            slots: null,
          });
          clearTimeout(timeoutId);
          return res.json({
            correlation_id: envelope.correlation_id,
            final_message: errMsg,
            actions: [],
          });
        }

      } else if (/^n[aã]o|^n$|cancelar|^no$/.test(userSaidConfirmation)) {
        // Usuário cancelou → resetar campos de data/hora
        const newState = await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
          booking_state: BOOKING_STATES.IDLE,
          preferred_date: null,
          preferred_date_iso: null,
          preferred_time: null,
        });
        logDecision('state_transition', {
          from: BOOKING_STATES.CONFIRMING,
          to: BOOKING_STATES.IDLE,
          trigger: 'user_cancelled',
        }, envelope.clinic_id, envelope.from);
        const cancelMsg2 = 'Tudo bem! O agendamento foi cancelado. O que você gostaria de fazer? 😊';
        // CORREÇÃO 2: Salvar histórico antes de retornar
        await saveConversationTurn({
          clinicId: envelope.clinic_id,
          fromNumber: envelope.from,
          correlationId: envelope.correlation_id,
          userText: envelope.message_text,
          assistantText: cancelMsg2,
          intentGroup: 'scheduling',
          intent: 'cancel',
          slots: null,
        });
        clearTimeout(timeoutId);
        return res.json({
          correlation_id: envelope.correlation_id,
          final_message: cancelMsg2,
          actions: [],
          debug: DEBUG ? { state: newState } : undefined,
        });

      } else {
        // Resposta ambígua → reenviar mensagem de confirmação
        const ambiguousConfirmMsg = await buildConfirmationMessage(updatedState, updatedState.doctor_name, clinicRules?.name, envelope.clinic_id);
        // CORREÇÃO 2: Salvar histórico antes de retornar
        await saveConversationTurn({
          clinicId: envelope.clinic_id,
          fromNumber: envelope.from,
          correlationId: envelope.correlation_id,
          userText: envelope.message_text,
          assistantText: ambiguousConfirmMsg,
          intentGroup: 'scheduling',
          intent: 'awaiting_confirmation',
          slots: null,
        });
        clearTimeout(timeoutId);
        return res.json({
          correlation_id: envelope.correlation_id,
          final_message: ambiguousConfirmMsg,
          actions: [],
          debug: DEBUG ? { booking_state: BOOKING_STATES.CONFIRMING } : undefined,
        });
      }
    } else if (
      allFieldsReady(updatedState) &&
      updatedState.booking_state !== BOOKING_STATES.BOOKED &&
      extracted?.intent_group === 'scheduling'
    ) {
      // Todos os campos preenchidos → entrar em CONFIRMING
      await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
        booking_state: BOOKING_STATES.CONFIRMING,
      });
      logDecision('state_transition', {
        from: updatedState.booking_state,
        to: BOOKING_STATES.CONFIRMING,
        trigger: 'all_fields_ready',
      }, envelope.clinic_id, envelope.from);
      // CORREÇÃO 5: Atualizar conversation_stage para 'awaiting_confirmation'
      await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
        conversation_stage: 'awaiting_confirmation',
      });
      const confirmMsg = await buildConfirmationMessage(updatedState, updatedState.doctor_name, clinicRules?.name, envelope.clinic_id);
      // CORREÇÃO 2: Salvar histórico antes de retornar
      await saveConversationTurn({
        clinicId: envelope.clinic_id,
        fromNumber: envelope.from,
        correlationId: envelope.correlation_id,
        userText: envelope.message_text,
        assistantText: confirmMsg,
        intentGroup: 'scheduling',
        intent: 'awaiting_confirmation',
        slots: null,
      });
      clearTimeout(timeoutId);
      return res.json({
        correlation_id: envelope.correlation_id,
        final_message: confirmMsg,
        // CAMADA 2 — Cenário B: Botões de confirmação interativos
        actions: [{
          type: 'send_interactive_buttons',
          payload: {
            buttons: [
              { id: 'confirm_yes', title: '\u2705 Confirmar' },
              { id: 'confirm_no',  title: '\u274C Cancelar' },
            ],
          },
        }],
        debug: DEBUG ? { booking_state: BOOKING_STATES.CONFIRMING } : undefined,
      });
    }

    // ======================================================
    // 7c-pre) TAREFA 2 FIX 4: BOOKING STAGES INTERCEPTOR
    // Usa BOOKING_STAGES para interceptar antes do LLM por stage.
    // ======================================================
    const currentBookingStage = updatedState.booking_state;

    // COLLECTING_SPECIALTY: doctor_id ainda nulo, intent de agendamento
    if (
      extracted?.intent_group === 'scheduling' &&
      !updatedState.doctor_id &&
      !updatedState.specialty &&
      currentBookingStage === BOOKING_STATES.IDLE
    ) {
      // Transicionar para COLLECTING_SPECIALTY (estado intermediário)
      await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
        booking_state: BOOKING_STATES.COLLECTING_SPECIALTY,
        // CORREÇÃO 5: Atualizar conversation_stage para 'scheduling'
        conversation_stage: 'scheduling',
      });
      updatedState.booking_state = BOOKING_STATES.COLLECTING_SPECIALTY;
      console.log('[FIX4] COLLECTING_SPECIALTY: doctor_id nulo, pedindo especialidade');
      const doctorList = doctors.map(d => `• ${d.name} — ${d.specialty}`).join('\n');
      const specialtyMsg = `Qual especialidade você gostaria de agendar?\n\nMédicos disponíveis:\n${doctorList}`;
      // CORREÇÃO 2: Salvar histórico antes de retornar
      await saveConversationTurn({
        clinicId: envelope.clinic_id,
        fromNumber: envelope.from,
        correlationId: envelope.correlation_id,
        userText: envelope.message_text,
        assistantText: specialtyMsg,
        intentGroup: 'scheduling',
        intent: 'schedule_new',
        slots: null,
      });
      clearTimeout(timeoutId);
      return res.json({
        correlation_id: envelope.correlation_id,
        final_message: specialtyMsg,
        actions: [],
        debug: DEBUG ? { fix4: 'collecting_specialty', booking_state: BOOKING_STATES.COLLECTING_DATE } : undefined,
      });
    }

    // AWAITING_CONFIRMATION: todos os campos prontos, aguardar confirmação explícita
    // (já tratado no bloco 7b acima — apenas garantir stage correto)
    if (
      updatedState.booking_state === BOOKING_STATES.CONFIRMING ||
      updatedState.booking_state === BOOKING_STATES.BOOKED
    ) {
      // Persistir stage AWAITING_CONFIRMATION para compatibilidade com BOOKING_STAGES
      if (updatedState.booking_state === BOOKING_STATES.CONFIRMING) {
        // Já tratado no bloco 7b — não fazer nada aqui
      }
    }

    // ======================================================
    // 7c) INTERCEPTORES DETERMINÍSTICOS
    // Substitui o detectAvailabilityQuestion anterior.
    // ======================================================
    const forcedCall = applyDeterministicInterceptors(updatedState, envelope.message_text);

    if (forcedCall && forcedCall.tool !== '__await_confirmation__') {
      logDecision('tool_forced', {
        tool: forcedCall.tool,
        reason: forcedCall.reason,
        booking_state: updatedState.booking_state,
      }, envelope.clinic_id, envelope.from);
      console.log(`[INTERCEPTOR] Forced tool: ${forcedCall.tool} — reason: ${forcedCall.reason}`);

      const toolResult = await executeSchedulingTool(
        forcedCall.tool,
        forcedCall.params,
        { clinicId: envelope.clinic_id, userPhone: envelope.from }
      );

      const validation = validateAvailabilityResult(toolResult, forcedCall.tool);
      logDecision('tool_validated', {
        tool: forcedCall.tool,
        valid: validation.valid,
        slots_returned: toolResult?.available_slots?.length || toolResult?.dates?.length || 0,
      }, envelope.clinic_id, envelope.from);

      if (!validation.valid && validation.noSlots) {
        // FIX 3: Sem slots → incrementar stuck_counter_slots e tentar busca aberta
        const currentStuckSlots = (updatedState.stuck_counter_slots || 0) + 1;
        await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
          stuck_counter_slots: currentStuckSlots,
        });
        updatedState.stuck_counter_slots = currentStuckSlots;
        console.log(`[FIX3] stuck_counter_slots = ${currentStuckSlots}`);

        if (currentStuckSlots >= STUCK_LIMIT) {
          // Fallback definitivo: resetar estado e encerrar com mensagem clara
          await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
            booking_state: BOOKING_STATES.IDLE,
            stuck_counter_slots: 0,
            preferred_date: null,
            preferred_date_iso: null,
          });
          decided = {
            decision_type: 'proceed',
            message: `Não encontrei vagas disponíveis para ${updatedState.specialty || updatedState.doctor_name || 'o médico solicitado'} nos próximos ${BUSCA_SLOTS_ABERTA_DIAS} dias.`,
            // CAMADA 2 — Cenário C: Botões de alternativa quando sem disponibilidade
            actions: [{
              type: 'send_interactive_buttons',
              payload: {
                buttons: [
                  { id: 'try_other_date',   title: '\uD83D\uDCC5 Tentar outra data' },
                  { id: 'try_other_doctor', title: '\uD83D\uDC68\u200D\u2695\uFE0F Outro médico' },
                  { id: 'ask_question',     title: '\u2753 Tirar uma dúvida' },
                ],
              },
            }],
            confidence: 1,
          };
          skipSchedulingAgent = true;
          step = MAX_STEPS;
        } else {
          // Primeira ou segunda tentativa: tentar busca aberta antes de desistir
          console.log('[INTERCEPTOR] No slots found — falling back to buscar_proximas_datas (busca_aberta)');
          const fallbackResult = await executeSchedulingTool(
            'buscar_proximas_datas',
            { doctor_id: updatedState.doctor_id, dias: BUSCA_SLOTS_ABERTA_DIAS, busca_aberta: true },
            { clinicId: envelope.clinic_id, userPhone: envelope.from }
          );
          if (fallbackResult?.success && fallbackResult?.dates?.length > 0) {
            // FIX 3: Resetar stuck_counter ao encontrar slots
            await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
              last_suggested_dates: fallbackResult.dates,
              booking_state: BOOKING_STATES.COLLECTING_DATE,
              stuck_counter_slots: 0,
            });
            const dateList = fallbackResult.dates.slice(0, BUSCA_SLOTS_ABERTA_MAX)
              .map((d, i) => `${i + 1}) ${d.day_of_week}, ${d.formatted_date}`).join('\n');
            decided = {
              decision_type: 'proceed',
              message: `Essa data não tem horários disponíveis. As próximas datas com vagas para ${updatedState.doctor_name} são:\n${dateList}\n\nQual dessas datas funciona melhor?`,
              actions: [{ type: 'log' }],
              confidence: 1,
            };
            skipSchedulingAgent = true;
            step = MAX_STEPS;
          } else {
            // Busca aberta também vazia: aguardar próximo turno (não prometer nada)
            decided = {
              decision_type: 'proceed',
              message: `Não encontrei horários disponíveis para ${updatedState.doctor_name} no momento.`,
              // CAMADA 2 — Cenário C: Botões de alternativa
              actions: [{
                type: 'send_interactive_buttons',
                payload: {
                  buttons: [
                    { id: 'try_other_date',   title: '\uD83D\uDCC5 Tentar outra data' },
                    { id: 'try_other_doctor', title: '\uD83D\uDC68\u200D\u2695\uFE0F Outro médico' },
                    { id: 'ask_question',     title: '\u2753 Tirar uma dúvida' },
                  ],
                },
              }],
              confidence: 1,
            };
            skipSchedulingAgent = true;
            step = MAX_STEPS;
          }
        }
      } else if (toolResult?.success) {
        if (forcedCall.tool === 'buscar_proximas_datas' && toolResult?.dates?.length > 0) {
          // FIX v5.3: Salvar datas e slots no state para uso pelos botões "Esta semana / Próxima semana"
          await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
            last_suggested_dates: toolResult.dates,
            last_suggested_slots: toolResult.dates.flatMap(d => (d.slots || []).map(s => ({ date: d.date_iso || d.date, time: s }))),
            booking_state: BOOKING_STATES.COLLECTING_DATE,
            stuck_counter_slots: 0,
          });
          updatedState.booking_state = BOOKING_STATES.COLLECTING_DATE;
          updatedState.last_suggested_dates = toolResult.dates;

          const weekMsg = `📅 *${updatedState.doctor_name || 'Médico selecionado'}*\n\nPara quando você gostaria de agendar sua consulta?`;
          await saveConversationTurn({
            clinicId: envelope.clinic_id,
            fromNumber: envelope.from,
            correlationId: envelope.correlation_id,
            userText: envelope.message_text,
            assistantText: weekMsg,
            intentGroup: 'scheduling',
            intent: 'buscar_proximas_datas',
            slots: null,
          });
          clearTimeout(timeoutId);
          return res.json({
            correlation_id: envelope.correlation_id,
            final_message: weekMsg,
            actions: [{
              type: 'send_interactive_buttons',
              payload: {
                buttons: [
                  { id: 'week_current', title: '📆 Esta semana' },
                  { id: 'week_next',    title: '📆 Próxima semana' },
                ],
              },
            }],
            debug: DEBUG ? { booking_state: BOOKING_STATES.COLLECTING_DATE, dates_count: toolResult.dates.length } : undefined,
          });
        } else if (forcedCall.tool === 'buscar_proximas_datas' && (!toolResult?.dates || toolResult.dates.length === 0)) {
          // FIX 3: buscar_proximas_datas retornou vazio — incrementar stuck_counter
          const currentStuckSlots = (updatedState.stuck_counter_slots || 0) + 1;
          await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
            stuck_counter_slots: currentStuckSlots,
          });
          updatedState.stuck_counter_slots = currentStuckSlots;
          console.log(`[FIX3] buscar_proximas_datas vazio, stuck_counter_slots = ${currentStuckSlots}`);

          if (currentStuckSlots >= STUCK_LIMIT) {
            await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
              booking_state: BOOKING_STATES.IDLE,
              stuck_counter_slots: 0,
            });
            decided = {
              decision_type: 'proceed',
              message: `Não encontrei vagas disponíveis para ${updatedState.specialty || updatedState.doctor_name || 'o médico solicitado'} nos próximos ${BUSCA_SLOTS_ABERTA_DIAS} dias.`,
              // CAMADA 2 — Cenário C: Botões de alternativa (stuck_limit)
              actions: [{
                type: 'send_interactive_buttons',
                payload: {
                  buttons: [
                    { id: 'try_other_date',   title: '\uD83D\uDCC5 Tentar outra data' },
                    { id: 'try_other_doctor', title: '\uD83D\uDC68\u200D\u2695\uFE0F Outro médico' },
                    { id: 'ask_question',     title: '\u2753 Tirar uma dúvida' },
                  ],
                },
              }],
              confidence: 1,
            };
          } else {
            // CORREÇÃO 2: Avançar booking_state para COLLECTING_DATE para evitar
            // que o interceptor dispare novamente na próxima mensagem (loop)
            await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
              booking_state: BOOKING_STATES.COLLECTING_DATE,
            });
            decided = {
              decision_type: 'proceed',
              message: `Não encontrei horários disponíveis para ${updatedState.doctor_name || updatedState.specialty || 'o médico solicitado'} nos próximos ${BUSCA_SLOTS_ABERTA_DIAS} dias. Gostaria de escolher outro médico ou especialidade?`,
              actions: [{ type: 'log' }],
              confidence: 1,
            };
          }
          skipSchedulingAgent = true;
          step = MAX_STEPS;
        } else if (forcedCall.tool === 'verificar_disponibilidade') {
          const slots = toolResult.available_slots || toolResult.slots || [];

          // FIX v5.2: Filtrar horários passados no dia atual
          const now = new Date();
          const todayStr = now.toISOString().split('T')[0];
          const requestedDate = forcedCall.params?.date || '';
          let filteredSlots = slots;
          if (requestedDate === todayStr) {
            const currentTotalMin = now.getHours() * 60 + now.getMinutes();
            filteredSlots = slots.filter(s => {
              const [h, m] = (typeof s === 'string' ? s : s?.time || '').split(':').map(Number);
              return (h * 60 + m) > currentTotalMin;
            });
          }

          // FIX 3: Resetar stuck_counter ao encontrar slots com sucesso
          await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
            last_suggested_slots: filteredSlots,
            booking_state: BOOKING_STATES.AWAITING_SLOTS,
            stuck_counter_slots: 0,
          });

          // FIX v5.3: Retornar horários do dia deterministicamente com formatação melhorada
          if (filteredSlots.length > 0) {
            const dateFormatted = formatDateBR(requestedDate);
            const slotsStr = filteredSlots.map(s => typeof s === 'string' ? s : s?.time).join(' · ');
            const doctorDisplay = updatedState.doctor_name || 'Médico selecionado';
            const displayMsg = `🕐 *${doctorDisplay}*\n📅 ${dateFormatted}\n\nHorários disponíveis:\n${slotsStr}\n\nQual horário você prefere?`;
            await saveConversationTurn({
              clinicId: envelope.clinic_id,
              fromNumber: envelope.from,
              correlationId: envelope.correlation_id,
              userText: envelope.message_text,
              assistantText: displayMsg,
              intentGroup: 'scheduling',
              intent: 'show_time_slots',
              slots: null,
            });
            clearTimeout(timeoutId);
            return res.json({
              correlation_id: envelope.correlation_id,
              final_message: displayMsg,
              actions: [],
              debug: DEBUG ? { booking_state: BOOKING_STATES.AWAITING_SLOTS, slots_count: filteredSlots.length } : undefined,
            });
          }
          // Se não há slots após filtro → cai no LLM para informar
        }
      } else if (!validation.valid) {
        // CORREÇÃO 2: Avançar booking_state para COLLECTING_DATE para evitar
        // que o interceptor dispare novamente na próxima mensagem (loop)
        await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
          booking_state: BOOKING_STATES.COLLECTING_DATE,
        });
        decided = {
          decision_type: 'proceed',
          message: validation.fallback,
          actions: [{ type: 'log' }],
          confidence: 1,
        };
        skipSchedulingAgent = true;
        step = MAX_STEPS;
      }
    } else if (!forcedCall) {
      // LLM decide livremente — manter flow normal com detectAvailabilityQuestion como fallback
      const isAvailabilityQuery = detectAvailabilityQuestion(envelope.message_text);
      const hasDoctorInState = !!(updatedState.doctor_id);
      if (isAvailabilityQuery && hasDoctorInState && extracted?.intent_group === 'scheduling') {
        console.log('[INTERCEPTOR] Availability question detected — forcing buscar_proximas_datas');
        const availResult = await executeSchedulingTool(
          'buscar_proximas_datas',
          { doctor_id: updatedState.doctor_id, dias: BUSCA_SLOTS_ABERTA_DIAS, busca_aberta: true },
          { clinicId: envelope.clinic_id, userPhone: envelope.from }
        );
        if (availResult?.success && availResult?.dates?.length > 0) {
          await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
            last_suggested_dates: availResult.dates,
          });
          const dateList = availResult.dates.slice(0, 5)
            .map((d, i) => `${i + 1}) ${d.day_of_week}, ${d.formatted_date}`).join('\n');
          decided = {
            decision_type: 'proceed',
            message: `Tenho os seguintes horários disponíveis com ${updatedState.doctor_name}:\n${dateList}\n\nQual dessas datas funciona melhor pra você?`,
            actions: [{ type: 'log' }],
            confidence: 1,
          };
          skipSchedulingAgent = true;
          step = MAX_STEPS;
        }
      }
    }

    // ======================================================
    // 8) STEP 1: decide_next_action
    // ======================================================
    if (step < MAX_STEPS) {
      const decision = await openai.chat.completions.create(
        {
          model: OPENAI_MODEL,
          messages: [
            {
              role: 'system',
              content: buildSystemPrompt(clinicRules, doctors, services, kbContext, updatedState) +
                `\n\n## RESTRIÇÕES OPERACIONAIS\n` +
                `allow_prices=${clinicRules.allow_prices}. ` +
                (clinicRules.allow_prices === false ? 'Se pedir preço: decision_type=block_price.\n' : '\n') +
                `Se faltar dado essencial: decision_type=ask_missing com pergunta direta (1 frase).\n` +
                `Se tiver informação suficiente: decision_type=proceed.\n` +
                `Sua saída DEVE ser via ferramenta decide_next_action.`,
            },
            // Incluir histórico para que o modelo saiba o que já foi respondido
            ...previousMessages.map(msg => ({
              role: msg.role === 'user' ? 'user' : 'assistant',
              content: msg.content,
            })),
            {
              role: 'user',
              content: JSON.stringify({ extracted }),
            },
          ],
          tools: [tools[1]],
          tool_choice: { type: 'function', function: { name: 'decide_next_action' } },
        },
        { signal: controller.signal }
      );

      // Acumular usage da chamada decide_next_action
      if (decision.usage) {
        totalTokensInput += decision.usage.prompt_tokens || 0;
        totalTokensOutput += decision.usage.completion_tokens || 0;
      }

      // 🔧 CORREÇÃO: acessar choices[0].message.tool_calls
      const call = decision.choices[0]?.message?.tool_calls?.[0];
      const parsedArgs = call?.function?.arguments
        ? safeJsonParse(call.function.arguments)
        : null;

      if (!parsedArgs) {
        decided = {
          decision_type: 'ask_missing',
          message:
            'Perfeito. Me diga seu nome completo e o melhor dia/horário (manhã/tarde/noite).',
          actions: [{ type: 'log' }],
        };
      } else {
        decided = parsedArgs;
      }

      step++;
    }

    // Fallback: garantir que decided sempre está definido (JG-P0-002)
    if (!decided) {
      decided = {
        decision_type: 'ask_missing',
        message: 'Desculpe, não consegui processar sua solicitação. Pode fornecer mais detalhes?',
        actions: [{ type: 'log' }],
        confidence: 0.5,
      };
    }

    // Registrar gap de conhecimento quando a confiança da decisão está baixa
    if (decided.confidence !== undefined && decided.confidence < 0.7) {
      await logKnowledgeGap(
        envelope.clinic_id,
        envelope.correlation_id,
        envelope.message_text,
        { intent: extracted.intent, slots: extracted.slots }
      );
    }

    // ======================================================
    // 9) STEP 2: AGENTE DE AGENDAMENTO (apenas quando proceed + scheduling)
    // ======================================================
    if (
      !skipSchedulingAgent &&
      decided.decision_type === 'proceed' &&
      extracted.intent_group === 'scheduling'
    ) {
      const agentSystemPrompt = buildSystemPrompt(clinicRules, doctors, services, kbContext, updatedState) +
        '\n\n## INSTRUÇÕES DE AGENDAMENTO\n' +
        'Use as ferramentas disponíveis para verificar disponibilidade REAL e criar agendamentos.\n' +
        'Nunca invente horários ou convênios — consulte sempre as tools.\n' +
        'Responda diretamente ao paciente em no máximo 3 frases.';

      const agentMessages = [
        { role: 'system', content: agentSystemPrompt },
        ...previousMessages.map(msg => ({
          role: msg.role === 'user' ? 'user' : 'assistant',
          content: msg.content,
        })),
        { role: 'user', content: envelope.message_text },
      ];

      // Loop do agente com tool_calls (máx 3 iterações)
      let agentStep = 0;
      // Rastreador: conta quantas vezes cada tool foi chamada neste ciclo
      // Evita o LLM chamar verificar_disponibilidade 3x e gerar 3 respostas iguais
      const toolCallCount = {};
      const MAX_CALLS_PER_TOOL = 1;
      while (agentStep < 3) {
        const agentResp = await openai.chat.completions.create(
          {
            model: OPENAI_MODEL,
            messages: agentMessages,
            tools: schedulingToolsDefinitions,
            temperature: 0.4,
          },
          { signal: controller.signal }
        );

        // Acumular usage da chamada do scheduling agent
        if (agentResp.usage) {
          totalTokensInput += agentResp.usage.prompt_tokens || 0;
          totalTokensOutput += agentResp.usage.completion_tokens || 0;
        }

        const choice = agentResp.choices[0];

        if (!choice.message.tool_calls || choice.message.tool_calls.length === 0) {
          // Resposta textual final — substituir mensagem do decided
          if (choice.message.content) {
            decided.message = choice.message.content;
          }
          break;
        }

        // Processar chamadas de tool
        agentMessages.push(choice.message);
        for (const toolCall of choice.message.tool_calls) {
          // Verificar limite de chamadas por tool
          const toolName = toolCall.function.name;
          toolCallCount[toolName] = (toolCallCount[toolName] || 0) + 1;
          if (toolCallCount[toolName] > MAX_CALLS_PER_TOOL) {
            log.warn({ tool: toolName, count: toolCallCount[toolName] }, '[LOOP] Tool chamada mais de uma vez neste ciclo — bloqueando');
            agentMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: JSON.stringify({
                success: false,
                blocked: true,
                message: 'Esta ferramenta já foi usada neste ciclo. Encerre sua resposta com o que você já sabe.',
              }),
            });
            continue;
          }

          let toolArgs = {};
          try { toolArgs = JSON.parse(toolCall.function.arguments); } catch { /* sem args */ }

          const toolResult = await executeSchedulingTool(
            toolCall.function.name,
            toolArgs,
            { clinicId: envelope.clinic_id, userPhone: envelope.from }
          );

          agentMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(toolResult),
          });

          // Validar resultado de tools de disponibilidade
          const availTools = ['verificar_disponibilidade', 'buscar_proximas_datas'];
          if (availTools.includes(toolCall.function.name)) {
            const valResult = validateAvailabilityResult(toolResult, toolCall.function.name);
            logDecision('tool_validated', {
              tool: toolCall.function.name,
              valid: valResult.valid,
              slots_returned: toolResult?.available_slots?.length || toolResult?.dates?.length || 0,
            }, envelope.clinic_id, envelope.from);

            if (!valResult.valid && valResult.noSlots && toolCall.function.name === 'verificar_disponibilidade') {
              // FIX-FALLBACK: Sem slots nessa data → buscar a partir da data solicitada (não de hoje)
              const dataSolicitada = valResult.requestedDate || updatedState.preferred_date || null;
              console.log(`[TOOL] No slots em ${dataSolicitada} — auto-fallback to buscar_proximas_datas a partir de ${dataSolicitada}`);
              const fallbackArgs = {
                doctor_id: updatedState.doctor_id,
                dias: 14,
              };
              // Passar dataInicio para buscar a partir da data solicitada, não de hoje
              if (dataSolicitada) {
                fallbackArgs.data_inicio = dataSolicitada;
              }
              const fallbackRes = await executeSchedulingTool(
                'buscar_proximas_datas',
                fallbackArgs,
                { clinicId: envelope.clinic_id, userPhone: envelope.from }
              );
              // Injetar resultado do fallback como contexto de sistema
              // (não como tool result com ID fictício — isso causa erro na API da OpenAI)
              if (fallbackRes?.dates?.length > 0) {
                // CORREÇÃO 3+5: Salvar last_suggested_dates e last_suggested_slots
                await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
                  last_suggested_dates: fallbackRes.dates,
                  last_suggested_slots: fallbackRes.dates.flatMap(d => (d.slots || []).map(s => ({ date: d.date, time: s }))),
                  booking_state: BOOKING_STATES.COLLECTING_DATE,
                  stuck_counter_slots: 0,
                });
                // CORREÇÃO 3: Usar mensagem já formatada com horários reais
                const fallbackMsg = fallbackRes.message && fallbackRes.message.includes('horários disponíveis')
                  ? fallbackRes.message
                  : (() => {
                      const dateList = fallbackRes.dates.slice(0, 5)
                        .map(d => {
                          const slotsStr = d.slots ? d.slots.join(', ') : `${d.slots_count || '?'} horários`;
                          return `${d.day_of_week}, ${d.formatted_date} — ${slotsStr}`;
                        }).join('\n');
                      return `${updatedState.doctor_name || 'O médico'} não atende nessa data. Os próximos horários disponíveis são:\n\n${dateList}\n\nQual dia e horário você prefere?`;
                    })();
                agentMessages.push({
                  role: 'system',
                  content: `[BUSCA AUTOMÁTICA DE ALTERNATIVAS] Não havia horários na data solicitada. ` +
                    `Use EXATAMENTE esta mensagem para responder ao paciente: "${fallbackMsg}". ` +
                    `Não invente outros horários. Não pergunte a data novamente.`,
                });
              } else {
                agentMessages.push({
                  role: 'system',
                  content: '[BUSCA AUTOMÁTICA DE ALTERNATIVAS] Não encontrei horários disponíveis nos próximos 14 dias. ' +
                    'Informe o paciente UMA Única VEZ e pergunte se deseja tentar outro médico ou especialidade.',
                });
              }
            }
          }

          // CORREÇÃO 5: Persistir opções apresentadas no estado com slots reais
          if (toolCall.function.name === 'buscar_proximas_datas' && toolResult?.success) {
            const datesWithSlots = (toolResult.dates || []).map(d => ({
              date: d.date,
              date_iso: d.date_iso || d.date,
              formatted_date: d.formatted_date,
              day_of_week: d.day_of_week,
              slots_count: d.slots_count || (d.slots || []).length,
              slots: d.slots || [], // CORREÇÃO 5: Incluir slots reais
            }));
            // CORREÇÃO 5: Salvar last_suggested_slots como lista plana de {date, time}
            const flatSlots = datesWithSlots.flatMap(d =>
              (d.slots || []).map(s => ({ date: d.date, time: s }))
            );
            await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
              last_suggested_dates: datesWithSlots,
              last_suggested_slots: flatSlots,
              booking_state: BOOKING_STATES.COLLECTING_DATE,
            });
          }
          if (toolCall.function.name === 'verificar_disponibilidade' && toolResult?.success) {
            const availSlots = toolResult.available_slots || toolResult.slots || [];
            await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
              last_suggested_slots: availSlots.map(s => ({ date: toolResult.date || null, time: s })),
              booking_state: BOOKING_STATES.AWAITING_SLOTS,
            });
          }
          if (toolCall.function.name === 'criar_agendamento' && toolResult?.success) {
            await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
              booking_state: BOOKING_STATES.BOOKED,
              appointment_confirmed: true,
            });
            logDecision('state_transition', {
              from: BOOKING_STATES.BOOKED,
              to: 'appointment_confirmed',
              trigger: 'criar_agendamento_success',
            }, envelope.clinic_id, envelope.from);

            // — Finalizar tracking da conversa (PONTO E) —
            if (conversationRecord) {
              try {
                await finalizeConversation(
                  supabase,
                  conversationRecord.id,
                  'completed',
                  'booked',
                  toolResult.appointment_id || null,
                  toolResult.patient_id || null
                );
              } catch (trackingError) {
                console.warn('[ConversationTracker] Erro ao finalizar:', trackingError.message);
              }
            }
          }

          if (DEBUG) {
            log.debug({ tool: toolCall.function.name, result: toolResult }, 'scheduling_tool_executed');
          }
        }

        agentStep++;
      }
    }

    // ======================================================
    // 10) VALIDAÇÃO BACKEND (proteção extra)
    // ======================================================
    if (
      extracted.intent_group === 'billing' &&
      clinicRules.allow_prices === false
    ) {
      decided = {
        decision_type: 'block_price',
        message:
          'Por aqui não informamos valores. Posso agendar uma avaliação — me diga seu nome e o melhor dia/horário 🙂',
        actions: [{ type: 'log' }],
        confidence: 1,
      };
    }

    // ======================================================
    // 10b) ANTI-REPETIÇÃO: salvar última pergunta no estado
    // ======================================================
    const finalMessage = decided.message;
    const questionMatch = finalMessage.match(/[^.!]*\?/);
    const lastQuestion = questionMatch ? questionMatch[0].trim() : null;

    if (isRepetition(finalMessage, updatedState.last_question_asked)) {
      log.warn({ msg: finalMessage, prev: updatedState.last_question_asked }, '⚠️ repetição detectada');
    }

    if (lastQuestion) {
      await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
        last_question_asked: lastQuestion,
      });
    }

    // ======================================================
    // 10c) BUG 3 FIX: CONTROLE DE ENVIO DUPLICADO
    // Verificar se a mesma mensagem já foi enviada nos últimos 30 segundos
    // para este número. Se sim, bloquear envio duplicado.
    // ======================================================
    try {
      const DEDUP_WINDOW_MS = 30 * 1000; // 30 segundos
      const { data: recentMessages } = await supabase
        .from('conversation_history')
        .select('message_text, created_at')
        .eq('clinic_id', envelope.clinic_id)
        .eq('from_number', envelope.from)
        .eq('role', 'assistant')
        .gte('created_at', new Date(Date.now() - DEDUP_WINDOW_MS).toISOString())
        .order('created_at', { ascending: false })
        .limit(3);

      if (recentMessages && recentMessages.length > 0) {
        const isDuplicate = recentMessages.some(msg => {
          // Normalizar para comparação (remover espaços extras e emojis)
          const normalize = (s) => s.replace(/\s+/g, ' ').trim().substring(0, 100);
          return normalize(msg.message_text) === normalize(finalMessage);
        });

        if (isDuplicate) {
          log.warn({
            from: envelope.from,
            clinic_id: envelope.clinic_id,
            msg_preview: finalMessage.substring(0, 80),
          }, '[BUG3-FIX] Mensagem duplicada detectada nos últimos 30s — bloqueando envio');
          clearTimeout(timeoutId);
          return res.json({
            correlation_id: envelope.correlation_id,
            final_message: null, // sinal para o Worker n8n não enviar
            actions: [{ type: 'dedup_blocked', payload: { reason: 'duplicate_within_30s' } }],
            debug: DEBUG ? { dedup: true, blocked_message: finalMessage.substring(0, 80) } : undefined,
          });
        }
      }
    } catch (dedupErr) {
      // Silencioso: não bloquear o fluxo por erro na dedup
      log.warn({ err: String(dedupErr) }, '[BUG3-FIX] Erro na verificação de dedup — continuando');
    }

    // ======================================================
    // 10) LOG ESTRUTURADO
    // ======================================================
    try {
      await supabase.from('agent_logs').insert({
        clinic_id: envelope.clinic_id,
        correlation_id: envelope.correlation_id,
        log_type: 'intent',
        intent_group: extracted.intent_group,
        intent: extracted.intent,
        confidence: extracted.confidence,
        decision_type: decided?.decision_type || null,
        latency_ms: Date.now() - started,
        extra_data: {
          // NOVOS campos de custo (PASSO 1.4)
          tokens: {
            input: totalTokensInput,
            output: totalTokensOutput,
            total: totalTokensInput + totalTokensOutput,
          },
          cost_usd: calculateCost(totalTokensInput, totalTokensOutput),
          model: process.env.OPENAI_MODEL || 'gpt-4.1',
        },
      });
    } catch (e) {
      log.warn({ err: String(e) }, 'agent_logs_insert_failed');
    }

    // ======================================================
    // 11) SALVAR HISTÓRICO + RESPOSTA FINAL
    // ======================================================
    await saveConversationTurn({
      clinicId: envelope.clinic_id,
      fromNumber: envelope.from,
      correlationId: envelope.correlation_id,
      userText: envelope.message_text,
      assistantText: decided.message,
      intentGroup: extracted?.intent_group,
      intent: extracted?.intent,
      slots: extracted?.slots,
    });

    // CORREÇÃO 5: Atualizar conversation_stage com base no intent_group
    // para que o estado reflita o estágio atual da conversa
    try {
      let newStage = null;
      const ig = extracted?.intent_group;
      if (ig === 'scheduling') {
        const bs = updatedState?.booking_state;
        if (bs === BOOKING_STATES.BOOKED) newStage = 'booked';
        else if (bs === BOOKING_STATES.CONFIRMING) newStage = 'awaiting_confirmation';
        else newStage = 'scheduling';
      } else if (ig === 'cancellation') {
        newStage = 'cancellation';
      } else if (ig === 'reschedule') {
        newStage = 'reschedule';
      } else if (ig === 'info') {
        newStage = 'info';
      } else {
        newStage = 'active';
      }
      if (newStage) {
        await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
          conversation_stage: newStage,
        });
      }
    } catch (stageErr) {
      log.warn({ err: String(stageErr) }, 'conversation_stage_update_failed');
    }

    // — Atualizar tracking com dados do turno (PONTO C) —
    if (conversationRecord) {
      try {
        await updateConversationTurn(supabase, conversationRecord.id, {
          tokensInput: totalTokensInput,
          tokensOutput: totalTokensOutput,
          costEstimated: calculateCost(totalTokensInput, totalTokensOutput),
        });
      } catch (trackingError) {
        console.warn('[ConversationTracker] Erro no update de turno:', trackingError.message);
      }
    }

    clearTimeout(timeoutId);

    // — CRM V2: Fire-and-forget (não bloqueia resposta ao paciente) —
    try {
      let conversationOutcome = 'conversation';
      if (updatedState?.booking_state === BOOKING_STATES.BOOKED) {
        conversationOutcome = 'booked';
      } else if (extracted?.intent === 'cancel' || extracted?.intent === 'confirm_no') {
        conversationOutcome = 'cancelled';
      } else if (extracted?.intent_group === 'info' || extracted?.intent === 'info_query') {
        conversationOutcome = 'info_provided';
      }

      processPostConversation(
        supabase,
        envelope.from,
        envelope.clinic_id,
        conversationOutcome,
        conversationRecord?.id || null,
        null // appointmentId — disponível apenas nos early returns de confirmação
      ).catch(err => console.error('[CRM] Erro no pós-processamento:', err.message));
    } catch (crmErr) {
      // Erro síncrono na preparação — nunca deve derrubar o agente
      console.error('[CRM] Erro ao iniciar CRM V2:', crmErr.message);
    }

    return res.json({
      correlation_id: envelope.correlation_id,
      final_message: decided.message,
      actions: decided.actions ?? [],
      debug: DEBUG
        ? {
            extracted,
            decided,
            kb_hits: (kbRows ?? []).length,
            latency_ms: Date.now() - started,
          }
        : undefined,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    const errName = err?.name || 'UnknownError';
    const errMessage = err?.message || String(err);

    log.error(
      {
        err_name: errName,
        err_message: errMessage,
        correlation_id: envelope.correlation_id,
        clinic_id: envelope.clinic_id,
      },
      'process_error'
    );

    const isTimeout = String(err?.name || '').toLowerCase().includes('abort');

    return res.status(200).json({
      correlation_id: envelope.correlation_id,
      final_message: isTimeout
        ? 'Demorei um pouco para responder. Pode repetir sua mensagem, por favor? 🙏'
        : 'Tive uma instabilidade agora. Pode repetir sua mensagem em 1 minuto?',
      actions: [{ type: 'log', payload: { event: 'agent_error' } }],
      debug: DEBUG
        ? { error_message: errMessage, error_name: errName }
        : undefined,
    });
  }
});

// ======================================================
// INICIAR SERVIDOR
// ======================================================
app.get("/health", async (req, res) => {
  const redisStatus = await redisHealthCheck();
  res.json({ ok: true, service: "agent-service", redis: redisStatus });
});

app.listen(PORT, "0.0.0.0", () => {
  log.info({ port: PORT }, '🚀 agent-service listening');

  // — CRM Fase 3: Iniciar Task Processor (varredura de crm_tasks pendentes) —
  // Fire-and-forget — se falhar, o server continua operando normalmente
  try {
    startTaskProcessor(supabase);
  } catch (err) {
    log.warn({ err: err.message }, '[TASK-PROCESSOR] Falha ao iniciar — server continua sem processor');
  }

  // — F9D: Campaign Scheduler (verifica campanhas agendadas a cada 30s) —
  try {
    startCampaignScheduler();
  } catch (err) {
    log.warn({ err: err.message }, '[CampaignScheduler] Falha ao iniciar — server continua sem scheduler');
  }
});
