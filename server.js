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
import { schedulingToolsDefinitions, executeSchedulingTool } from './tools/schedulingTools.js';

// ======================================================
// STATE MACHINE — Estados explícitos do fluxo de agendamento
// ======================================================
const BOOKING_STATES = {
  IDLE: 'idle',
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
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ======================================================
// PAINEL ADMINISTRATIVO (RECEPÇÃO)
// ======================================================
app.use('/admin', express.static(path.join(__dirname, 'public', 'admin')));
app.use('/admin', adminRoutes);

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
app.get('/health', (req, res) => {
  return res.json({ ok: true, service: 'agent-service' });
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

/**
 * Merge slots extraídos pelo LLM no estado persistente.
 * Valida especialidade e médico contra dados reais da clínica.
 * Suporta os dois naming conventions do extract_intent.
 */
function mergeExtractedSlots(currentState, extractedSlots, doctors, services) {
  const updates = { ...currentState };

  // Nome do paciente
  if (extractedSlots.patient_name) {
    updates.patient_name = extractedSlots.patient_name;
  }

  // Especialidade (extract_intent usa 'specialty_or_reason')
  const specialtyInput = extractedSlots.specialty || extractedSlots.specialty_or_reason;
  if (specialtyInput) {
    const normalizedSpec = specialtyInput.toLowerCase();
    const matchingDoctor = doctors.find(d =>
      d.specialty.toLowerCase().includes(normalizedSpec) ||
      normalizedSpec.includes(d.specialty.toLowerCase())
    );
    if (matchingDoctor) {
      updates.specialty = matchingDoctor.specialty;
      updates.doctor_name = matchingDoctor.name;
      updates.doctor_id = matchingDoctor.id;
    }
  }

  // Médico específico (extract_intent usa 'doctor_preference')
  const doctorInput = extractedSlots.doctor_name || extractedSlots.doctor_preference;
  if (doctorInput) {
    const normalizedDoc = doctorInput.toLowerCase();
    const matchingDoctor = doctors.find(d =>
      d.name.toLowerCase().includes(normalizedDoc) ||
      normalizedDoc.includes((d.name.toLowerCase().split(' ')[1]) || '')
    );
    if (matchingDoctor) {
      updates.doctor_name = matchingDoctor.name;
      updates.doctor_id = matchingDoctor.id;
      updates.specialty = matchingDoctor.specialty;
    }
  }

  // Data (extract_intent usa 'preferred_date_text')
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
      console.log(`[STATE] Data resolvida: "${dateInput}" → ${resolvedDate}`);
    } else {
      // Manter texto original — LLM vai tentar interpretar depois
      updates.preferred_date = dateInput;
      if (extractedSlots.preferred_date_iso) {
        updates.preferred_date_iso = extractedSlots.preferred_date_iso;
      }
    }
  }

  // Horário (extract_intent usa 'preferred_time_text')
  const timeInput = extractedSlots.preferred_time || extractedSlots.preferred_time_text;
  if (timeInput) {
    // Tentar resolver para HH:MM antes de salvar
    const resolvedTime = resolveTimeChoice(
      timeInput,
      currentState.last_suggested_slots || []
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
  for (const slot of slots) {
    const [h, m] = slot.split(':').map(Number);
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

  // Dias da semana: próxima ocorrência
  const WEEKDAY_MAP = [
    { pattern: /segunda/, day: 1 },
    { pattern: /terca|terça/, day: 2 },
    { pattern: /quarta/, day: 3 },
    { pattern: /quinta/, day: 4 },
    { pattern: /sexta/, day: 5 },
    { pattern: /sabado|sábado/, day: 6 },
  ];
  for (const { pattern, day } of WEEKDAY_MAP) {
    if (pattern.test(input)) return formatISO(nextWeekday(referenceDate, day));
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

  // Referências posicionais
  if (/prim[ea]ira?|^1[ao°]?$|^1$/.test(input) && suggestedSlots[0]) return suggestedSlots[0];
  if (/segunda?|^2[ao°]?$|^2$/.test(input) && suggestedSlots[1]) return suggestedSlots[1];
  if (/terceira?|^3[ao°]?$|^3$/.test(input) && suggestedSlots[2]) return suggestedSlots[2];
  if (/quarta?|^4[ao°]?$|^4$/.test(input) && suggestedSlots[3]) return suggestedSlots[3];

  // Períodos do dia
  if (/manha/.test(input)) {
    const manha = suggestedSlots.find(s => parseInt(s.split(':')[0]) < 12);
    if (manha) return manha;
  }
  if (/tarde/.test(input)) {
    const tarde = suggestedSlots.find(s => {
      const h = parseInt(s.split(':')[0]);
      return h >= 12 && h < 18;
    });
    if (tarde) return tarde;
  }
  if (/noite/.test(input)) {
    const noite = suggestedSlots.find(s => parseInt(s.split(':')[0]) >= 18);
    if (noite) return noite;
  }

  // Horário explícito: "14h", "14:00", "às 14", "14h30", "2pm"
  const hourMatch = input.match(/(\d{1,2})(?::(\d{2}))?h?/);
  if (hourMatch) {
    const h = hourMatch[1].padStart(2, '0');
    const m = hourMatch[2] || '00';
    const formatted = `${h}:${m}`;
    const exact = suggestedSlots.find(s => s === formatted);
    if (exact) return exact;
    const closest = findClosestSlot(formatted, suggestedSlots);
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

  // REGRA 1: Tem médico e data, mas não tem horário → DEVE verificar disponibilidade
  if (doctor_id && preferred_date && !preferred_time && booking_state !== BOOKING_STATES.AWAITING_SLOTS) {
    return {
      tool: 'verificar_disponibilidade',
      params: { doctor_id, date: preferred_date },
      reason: 'guard_rail: date_set_no_time',
    };
  }

  // REGRA 2: Tem médico, mas não tem data → DEVE buscar próximas datas disponíveis
  if (doctor_id && !preferred_date && booking_state === BOOKING_STATES.COLLECTING_DATE) {
    return {
      tool: 'buscar_proximas_datas',
      params: { doctor_id, dias: 14 },
      reason: 'guard_rail: doctor_set_no_date',
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
      fallback: tool === 'verificar_disponibilidade'
        ? 'Não encontrei horários disponíveis nessa data. Vou buscar as próximas datas com vagas.'
        : 'Não consegui buscar as datas disponíveis no momento.',
    };
  }

  if (tool === 'verificar_disponibilidade') {
    const slots = toolResult.slots || toolResult.available_slots || [];
    if (!Array.isArray(slots) || slots.length === 0) {
      return {
        valid: false,
        noSlots: true,
        fallback: 'Essa data não tem horários disponíveis. Quer que eu busque as próximas datas com vagas?',
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
 */
function buildConfirmationMessage(state, doctorName, clinicName) {
  const { preferred_date, preferred_time, patient_name } = state;
  const dateFormatted = formatDateBR(preferred_date);
  const doctor = doctorName || state.doctor_name || '[MÉDICO]';
  const clinic = clinicName || 'Clínica';

  return `✅ *Confirmar agendamento?*\n\n` +
    `👤 Paciente: ${patient_name || 'não informado'}\n` +
    `👨‍⚕️ Médico: ${doctor}\n` +
    `📅 Data: ${dateFormatted}\n` +
    `🕐 Horário: ${preferred_time}\n` +
    `🏥 Clínica: ${clinic}\n\n` +
    `Responda *SIM* para confirmar ou *NÃO* para cancelar.`;
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
Você é Juca, secretária virtual da clínica. Seja acolhedora, profissional e humana.

## TOM DE VOZ
- Natural, como pessoa real
- Breve e direta
- Máximo 1-2 emojis (😊 📅 ✅)
- PROIBIDO: "Se precisar de mais informações, é só avisar!"
- PROIBIDO: Repetir perguntas já respondidas
- PROIBIDO: Fazer múltiplas perguntas de uma vez

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
Se o paciente fizer uma pergunta de informação (convênio, endereço, valores, horário da clínica):
1. Responda objetivamente em 1-2 frases.
2. Retome com UMA pergunta sobre o campo pendente mais prioritário.
3. NÃO reinicie o fluxo. NÃO repita dados já coletados.

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
Se ESTÁGIO é "greeting", responda: "Olá! Sou a Juca, secretária virtual da clínica. Posso ajudar com agendamentos e informações. Como posso te ajudar hoje?"
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
  const { data: historyRows } = await supabase
    .from('conversation_history')
    .select('role, message_text')
    .eq('clinic_id', envelope.clinic_id)
    .eq('from_number', envelope.from)
    .order('created_at', { ascending: false })
    .limit(10);

  if (historyRows && historyRows.length > 0) {
    previousMessages = historyRows.reverse().map(r => ({
      role: r.role,
      content: r.message_text,
    }));
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

// Parse resultado da extração (JG-P0-002)
const callExtract = extraction.choices[0]?.message?.tool_calls?.[0];
extracted = callExtract?.function?.arguments
  ? safeJsonParse(callExtract.function.arguments)
  : null;
step++;

if (DEBUG) {
  log.debug({ extracted }, 'extraction_result');
}

// ========== MERGEAR SLOTS NO ESTADO PERSISTENTE ==========
const updatedState = mergeExtractedSlots(
  activeConvState,
  extracted?.slots || {},
  doctors,
  services
);

// Salvar estado atualizado (sem sobrescrever last_question_asked ainda)
await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
  ...updatedState,
  intent: extracted?.intent || conversationState.intent,
});

console.log('📊 Estado após merge:', JSON.stringify(updatedState, null, 2));

    // ======================================================
    // 7) CONFIDENCE GUARD
    // ======================================================
    if (!extracted || extracted.confidence < 0.6) {
      clearTimeout(timeoutId);
      return res.json({
        correlation_id: envelope.correlation_id,
        final_message:
          'Só para confirmar: você quer marcar, remarcar, cancelar ou tirar uma dúvida?',
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

      if (/^sim|^s$|confirmar|^ok$|^yes/.test(userSaidConfirmation)) {
        // Usuário confirmou → avançar para BOOKED e deixar scheduling agent criar
        const newState = await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
          booking_state: BOOKING_STATES.BOOKED,
        });
        Object.assign(updatedState, newState);
        logDecision('state_transition', {
          from: BOOKING_STATES.CONFIRMING,
          to: BOOKING_STATES.BOOKED,
          trigger: 'user_confirmed',
        }, envelope.clinic_id, envelope.from);
        // Continua o flow — scheduling agent vai chamar criar_agendamento

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
        clearTimeout(timeoutId);
        return res.json({
          correlation_id: envelope.correlation_id,
          final_message: 'Tudo bem! O agendamento foi cancelado. O que você gostaria de fazer? 😊',
          actions: [],
          debug: DEBUG ? { state: newState } : undefined,
        });

      } else {
        // Resposta ambígua → reenviar mensagem de confirmação
        clearTimeout(timeoutId);
        return res.json({
          correlation_id: envelope.correlation_id,
          final_message: buildConfirmationMessage(updatedState, updatedState.doctor_name, clinicRules?.name),
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
      clearTimeout(timeoutId);
      return res.json({
        correlation_id: envelope.correlation_id,
        final_message: buildConfirmationMessage(updatedState, updatedState.doctor_name, clinicRules?.name),
        actions: [{ type: 'confirmation_requested' }],
        debug: DEBUG ? { booking_state: BOOKING_STATES.CONFIRMING } : undefined,
      });
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
        // Sem slots → fallback automático para buscar próximas datas
        console.log('[INTERCEPTOR] No slots found — falling back to buscar_proximas_datas');
        const fallbackResult = await executeSchedulingTool(
          'buscar_proximas_datas',
          { doctor_id: updatedState.doctor_id, dias: 14 },
          { clinicId: envelope.clinic_id, userPhone: envelope.from }
        );
        if (fallbackResult?.success && fallbackResult?.dates?.length > 0) {
          await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
            last_suggested_dates: fallbackResult.dates,
            booking_state: BOOKING_STATES.COLLECTING_DATE,
          });
          const dateList = fallbackResult.dates.slice(0, 5)
            .map((d, i) => `${i + 1}) ${d.day_of_week}, ${d.formatted_date}`).join('\n');
          decided = {
            decision_type: 'proceed',
            message: `Essa data não tem horários disponíveis. As próximas datas com vagas para ${updatedState.doctor_name} são:\n${dateList}\n\nQual dessas datas funciona melhor?`,
            actions: [{ type: 'log' }],
            confidence: 1,
          };
          skipSchedulingAgent = true;
          step = MAX_STEPS;
        }
      } else if (toolResult?.success) {
        if (forcedCall.tool === 'buscar_proximas_datas' && toolResult?.dates?.length > 0) {
          await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
            last_suggested_dates: toolResult.dates,
            booking_state: BOOKING_STATES.COLLECTING_DATE,
          });
          const dateList = toolResult.dates.slice(0, 5)
            .map((d, i) => `${i + 1}) ${d.day_of_week}, ${d.formatted_date}`).join('\n');
          decided = {
            decision_type: 'proceed',
            message: `Tenho os seguintes horários disponíveis com ${updatedState.doctor_name}:\n${dateList}\n\nQual dessas datas funciona melhor pra você?`,
            actions: [{ type: 'log' }],
            confidence: 1,
          };
          skipSchedulingAgent = true;
          step = MAX_STEPS;
        } else if (forcedCall.tool === 'verificar_disponibilidade') {
          const slots = toolResult.available_slots || toolResult.slots || [];
          await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
            last_suggested_slots: slots,
            booking_state: BOOKING_STATES.AWAITING_SLOTS,
          });
          // Deixa o scheduling agent formatar a resposta com os slots
          // Injetar resultado no contexto para o LLM
        }
      } else if (!validation.valid) {
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
          { doctor_id: updatedState.doctor_id, dias: 14 },
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
              // Sem slots nessa data → fallback automático
              console.log('[TOOL] No slots — auto-fallback to buscar_proximas_datas');
              const fallbackRes = await executeSchedulingTool(
                'buscar_proximas_datas',
                { doctor_id: updatedState.doctor_id, dias: 14 },
                { clinicId: envelope.clinic_id, userPhone: envelope.from }
              );
              // Injetar resultado do fallback como resposta da tool
              agentMessages.push({
                role: 'tool',
                tool_call_id: toolCall.id + '_fallback',
                content: JSON.stringify(fallbackRes || { error: 'sem datas disponíveis' }),
              });
              if (fallbackRes?.dates?.length > 0) {
                await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
                  last_suggested_dates: fallbackRes.dates,
                  booking_state: BOOKING_STATES.COLLECTING_DATE,
                });
              }
            }
          }

          // Persistir opções apresentadas no estado para suportar respostas como "o primeiro"
          if (toolCall.function.name === 'buscar_proximas_datas' && toolResult?.success) {
            await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
              last_suggested_dates: toolResult.dates || [],
              booking_state: BOOKING_STATES.COLLECTING_DATE,
            });
          }
          if (toolCall.function.name === 'verificar_disponibilidade' && toolResult?.success) {
            await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
              last_suggested_slots: toolResult.available_slots || [],
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

    clearTimeout(timeoutId);
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
app.listen(PORT, () => {
  log.info({ port: PORT }, '🚀 agent-service listening');
});
