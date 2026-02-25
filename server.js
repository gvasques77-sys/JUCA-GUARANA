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
// UTILITÁRIOS DE CONTEXTO E LOGGING
// ======================================================

/**
 * Constrói um resumo estruturado da conversa para injetar no system prompt.
 * Reduz tokens em históricos longos e torna a memória mais estável.
 *
 * @param {Array} previousMessages - Array {role, content} das mensagens anteriores
 * @returns {string} Resumo formatado ou string vazia se não há histórico
 */
function buildContextSummary(previousMessages) {
  if (!previousMessages || previousMessages.length === 0) return '';

  const userMsgs = previousMessages
    .filter(m => m.role === 'user')
    .map(m => m.content);

  const asstMsgs = previousMessages
    .filter(m => m.role === 'assistant')
    .map(m => m.content);

  return [
    '--- CONTEXTO DA CONVERSA ATUAL ---',
    `Turnos anteriores: ${previousMessages.length}`,
    `Última mensagem do paciente: "${userMsgs[userMsgs.length - 1] || 'N/A'}"`,
    `Última resposta da secretaria: "${asstMsgs[asstMsgs.length - 1] || 'N/A'}"`,
    '--- FIM DO CONTEXTO ---',
  ].join('\n');
}

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

// ======================================================
// SLOT EXTRACTION & DYNAMIC SYSTEM PROMPT
// ======================================================

/**
 * Extrai slots já informados do histórico de mensagens do usuário.
 * Usado para evitar que o agente repita perguntas já respondidas.
 */
const extractCollectedSlots = (previousMessages) => {
  const slots = { name: null, specialty: null, doctor: null, date: null, time: null };

  for (const msg of previousMessages) {
    if (msg.role !== 'user') continue;
    const text = (msg.content || '').toLowerCase();

    // Nome (mensagens curtas sem palavras-chave de agendamento)
    if (
      text.match(/^[a-záéíóúâêîôûãõç\s]{2,30}$/i) &&
      !['dermatologia', 'clínico', 'clinico', 'estética', 'estetica', 'sim', 'não', 'nao', 'ola', 'olá', 'oi', 'geral'].some(k => text.includes(k))
    ) {
      slots.name = msg.content;
    }

    // Especialidade
    if (text.includes('dermatolog')) slots.specialty = 'Dermatologia';
    if (text.includes('clínico') || text.includes('clinico') || text.includes('geral')) slots.specialty = 'Clínico Geral';
    if (text.includes('estética') || text.includes('estetica')) slots.specialty = 'Estética';

    // Médico (por nome)
    if (text.includes('ana')) slots.doctor = 'Dra. Ana Santos';
    if (text.includes('carlos')) slots.doctor = 'Dr. Carlos Silva';
    if (text.includes('julia') || text.includes('júlia')) slots.doctor = 'Dra. Julia Lima';

    // Data
    if (text.includes('segunda')) slots.date = 'segunda-feira';
    if (text.includes('terça') || text.includes('terca')) slots.date = 'terça-feira';
    if (text.includes('quarta')) slots.date = 'quarta-feira';
    if (text.includes('quinta')) slots.date = 'quinta-feira';
    if (text.includes('sexta')) slots.date = 'sexta-feira';
    if (text.includes('sábado') || text.includes('sabado')) slots.date = 'sábado';
    if (text.includes('amanhã') || text.includes('amanha')) slots.date = 'amanhã';
    if (text.includes('hoje')) slots.date = 'hoje';

    // Horário
    const timeMatch = text.match(/(\d{1,2})\s*h/);
    if (timeMatch) slots.time = `${timeMatch[1]}h`;
  }

  return slots;
};

/**
 * Constrói o system prompt dinâmico com dados reais da clínica.
 * Injeta médicos, serviços, KB e slots já coletados para evitar
 * respostas robóticas e perguntas repetidas.
 */
const buildSystemPrompt = (clinicSettings, doctors, services, kbContext, previousMessages) => {
  const doctorsList = doctors.map(d => `• ${d.name} — ${d.specialty}`).join('\n');
  const specialtiesList = [...new Set(doctors.map(d => d.specialty))].join(', ');
  const servicesList = services.map(s => `• ${s.name} (${s.duration_minutes}min)`).join('\n');

  const collectedSlots = extractCollectedSlots(previousMessages || []);

  return `
## IDENTIDADE
Você é Juca, a secretária virtual da clínica. Seja acolhedora, profissional e humana.

## TOM DE VOZ
- Fale naturalmente, como uma pessoa real
- Seja breve e direta
- Use no máximo 1-2 emojis por mensagem
- NUNCA use "Se precisar de mais informações, é só avisar!"
- NUNCA repita perguntas já respondidas

## DADOS REAIS DA CLÍNICA

### Médicos:
${doctorsList || 'Nenhum cadastrado'}

### Especialidades disponíveis:
${specialtiesList || 'Nenhuma'}

### Serviços:
${servicesList || 'Nenhum'}

### Funcionamento:
${clinicSettings?.policies_text || 'Segunda a sexta, 8h às 18h'}

### Base de Conhecimento:
${kbContext || 'Sem informações adicionais'}

## REGRAS

### Ao perguntar sobre MÉDICOS ou ESPECIALIDADES:
Liste TODOS os médicos cadastrados acima com suas especialidades.

### Para AGENDAR, colete nesta ordem:
1. Nome do paciente
2. Médico ou especialidade
3. Data preferida
4. Horário preferido

### SLOTS JÁ COLETADOS (não pergunte novamente!):
${collectedSlots.name ? `✅ Nome: ${collectedSlots.name}` : '❌ Nome: pendente'}
${collectedSlots.specialty || collectedSlots.doctor ? `✅ Médico/Especialidade: ${collectedSlots.specialty || collectedSlots.doctor}` : '❌ Médico/Especialidade: pendente'}
${collectedSlots.date ? `✅ Data: ${collectedSlots.date}` : '❌ Data: pendente'}
${collectedSlots.time ? `✅ Horário: ${collectedSlots.time}` : '❌ Horário: pendente'}

### CONFIRMAÇÃO (quando tiver todos os dados):
"Perfeito, [NOME]! Confirmo sua consulta:
📅 [DATA] às [HORÁRIO]
👨‍⚕️ [MÉDICO] — [ESPECIALIDADE]
Posso confirmar? 😊"

### VALIDAÇÕES:
- Se pedirem especialidade inexistente, sugira as disponíveis
- NUNCA invente informações
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
    // 3b) BUSCAR MÉDICOS E SERVIÇOS DA CLÍNICA
    // ======================================================
    const [doctorsResult, servicesResult] = await Promise.all([
      supabase
        .from('doctors')
        .select('name, specialty')
        .eq('clinic_id', envelope.clinic_id)
        .eq('active', true),
      supabase
        .from('services')
        .select('name, duration_minutes, price')
        .eq('clinic_id', envelope.clinic_id)
        .eq('active', true),
    ]);
    const doctors = doctorsResult.data || [];
    const services = servicesResult.data || [];

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
    // 8) STEP 1: decide_next_action
    // ======================================================
    if (step < MAX_STEPS) {
      const decision = await openai.chat.completions.create(
        {
          model: OPENAI_MODEL,
          messages: [
            {
              role: 'system',
              content: buildSystemPrompt(clinicRules, doctors, services, kbContext, previousMessages) +
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
      decided.decision_type === 'proceed' &&
      extracted.intent_group === 'scheduling'
    ) {
      const agentSystemPrompt = buildSystemPrompt(clinicRules, doctors, services, kbContext, previousMessages) +
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
