# 🚀 JUCA GUARANA — Implementação de Estado Persistente

## Contexto do Projeto

Sistema de secretária virtual via WhatsApp para clínica médica.
- **Backend**: Node.js/Express (server.js) no Railway
- **Banco**: Supabase (PostgreSQL)
- **LLM**: OpenAI GPT-4.1
- **Automação**: n8n

## Problemas Atuais (a resolver)

1. **Perguntas repetidas** — Agente pergunta o que já foi respondido
2. **Estado inconsistente** — Slot-filling via regex é frágil e "1 turno atrasado"
3. **Linguagem robótica** — Falta humanização
4. **Não valida dados reais** — Aceita especialidades inexistentes

## Solução: Estado Persistente (Single Source of Truth)

### Nova Tabela Criada: `conversation_state`

```sql
-- JÁ EXISTE NO BANCO (não precisa criar)
CREATE TABLE conversation_state (
  id UUID PRIMARY KEY,
  clinic_id UUID NOT NULL,
  from_number VARCHAR(50) NOT NULL,
  state_json JSONB NOT NULL DEFAULT '{...}',
  turn_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '24 hours'),
  UNIQUE(clinic_id, from_number)
);
```

### Estrutura do `state_json`

```json
{
  "patient_name": null,
  "patient_phone": null,
  "intent": null,
  "doctor_id": null,
  "doctor_name": null,
  "specialty": null,
  "service_id": null,
  "service_name": null,
  "preferred_date": null,
  "preferred_date_iso": null,
  "preferred_time": null,
  "pending_fields": [],
  "last_question_asked": null,
  "conversation_stage": "greeting",
  "appointment_confirmed": false
}
```

---

## TAREFA 1: Criar Funções de Estado

Adicione estas funções no `server.js` (no início, após imports):

```javascript
// ============================================
// GERENCIAMENTO DE ESTADO PERSISTENTE
// ============================================

/**
 * Carrega ou cria estado da conversa
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
    // Verificar se expirou (24h)
    if (new Date(data.expires_at) < new Date()) {
      // Resetar estado expirado
      return await resetConversationState(supabase, clinicId, fromNumber);
    }
    return data.state_json;
  }

  // Criar novo estado
  return await resetConversationState(supabase, clinicId, fromNumber);
}

/**
 * Cria/reseta estado da conversa
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
    appointment_confirmed: false
  };

  const { error } = await supabase
    .from('conversation_state')
    .upsert({
      clinic_id: clinicId,
      from_number: fromNumber,
      state_json: initialState,
      turn_count: 0,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    }, {
      onConflict: 'clinic_id,from_number'
    });

  if (error) console.error('Erro ao resetar estado:', error);
  return initialState;
}

/**
 * Atualiza estado da conversa
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
    ...updates
  };

  const { error } = await supabase
    .from('conversation_state')
    .update({
      state_json: newState,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    })
    .eq('clinic_id', clinicId)
    .eq('from_number', fromNumber);

  if (error) console.error('Erro ao atualizar estado:', error);
  return newState;
}

/**
 * Merge slots extraídos no estado atual
 * IMPORTANTE: Slots do turno atual têm prioridade
 */
function mergeExtractedSlots(currentState, extractedSlots, doctors, services) {
  const updates = { ...currentState };

  // Nome do paciente
  if (extractedSlots.patient_name) {
    updates.patient_name = extractedSlots.patient_name;
  }

  // Especialidade
  if (extractedSlots.specialty) {
    const normalizedSpec = extractedSlots.specialty.toLowerCase();
    // Validar contra dados reais
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

  // Médico específico
  if (extractedSlots.doctor_name) {
    const normalizedDoc = extractedSlots.doctor_name.toLowerCase();
    const matchingDoctor = doctors.find(d => 
      d.name.toLowerCase().includes(normalizedDoc) ||
      normalizedDoc.includes(d.name.toLowerCase().split(' ')[1] || '')
    );
    if (matchingDoctor) {
      updates.doctor_name = matchingDoctor.name;
      updates.doctor_id = matchingDoctor.id;
      updates.specialty = matchingDoctor.specialty;
    }
  }

  // Data
  if (extractedSlots.preferred_date || extractedSlots.preferred_date_text) {
    updates.preferred_date = extractedSlots.preferred_date_text || extractedSlots.preferred_date;
    if (extractedSlots.preferred_date_iso) {
      updates.preferred_date_iso = extractedSlots.preferred_date_iso;
    }
  }

  // Horário
  if (extractedSlots.preferred_time) {
    updates.preferred_time = extractedSlots.preferred_time;
  }

  // Calcular campos pendentes
  updates.pending_fields = calculatePendingFields(updates);

  // Atualizar estágio da conversa
  updates.conversation_stage = determineConversationStage(updates);

  return updates;
}

/**
 * Calcula quais campos ainda faltam
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
 * Determina estágio da conversa
 */
function determineConversationStage(state) {
  if (state.appointment_confirmed) return 'confirmed';
  if (state.pending_fields.length === 0) return 'ready_to_confirm';
  if (state.pending_fields.length === 1) return 'almost_complete';
  if (state.patient_name || state.specialty) return 'collecting_info';
  return 'greeting';
}
```

---

## TAREFA 2: Modificar o Fluxo Principal `/process`

No início da rota `/process`, após validar o envelope:

```javascript
app.post('/process', async (req, res) => {
  // ... validação existente ...
  const envelope = parsed.data;
  const clinicId = envelope.clinic_id;
  const fromNumber = envelope.from || envelope.wa?.from;

  // ========== NOVO: CARREGAR ESTADO ==========
  const conversationState = await loadConversationState(supabase, clinicId, fromNumber);
  console.log('📊 Estado atual:', JSON.stringify(conversationState, null, 2));

  // ========== NOVO: BUSCAR DADOS DA CLÍNICA ==========
  const [doctorsResult, servicesResult] = await Promise.all([
    supabase.from('doctors').select('id, name, specialty').eq('clinic_id', clinicId).eq('active', true),
    supabase.from('services').select('id, name, duration_minutes, price').eq('clinic_id', clinicId).eq('active', true)
  ]);
  const doctors = doctorsResult.data || [];
  const services = servicesResult.data || [];

  // ... depois de extract_intent ...
  
  // ========== NOVO: MERGEAR SLOTS NO ESTADO ==========
  const updatedState = mergeExtractedSlots(
    conversationState,
    extracted.slots || {},
    doctors,
    services
  );

  // Salvar estado atualizado
  await updateConversationState(supabase, clinicId, fromNumber, {
    ...updatedState,
    intent: extracted.intent,
    last_question_asked: null // Será preenchido após gerar resposta
  });

  console.log('📊 Estado atualizado:', JSON.stringify(updatedState, null, 2));
```

---

## TAREFA 3: Refatorar System Prompt

O prompt agora recebe o **ESTADO** como fonte da verdade (não mais regex):

```javascript
const buildSystemPrompt = (clinicSettings, doctors, services, kbContext, conversationState) => {
  const doctorsList = doctors.map(d => `• ${d.name} — ${d.specialty}`).join('\n');
  const specialtiesList = [...new Set(doctors.map(d => d.specialty))].join(', ');

  // Estado como fonte da verdade (não mais regex!)
  const stateDisplay = `
ESTADO ATUAL DA CONVERSA (FONTE DA VERDADE - NÃO PERGUNTE O QUE JÁ TEM):
${conversationState.patient_name ? `✅ Nome: ${conversationState.patient_name}` : '❌ Nome: PENDENTE'}
${conversationState.doctor_name ? `✅ Médico: ${conversationState.doctor_name} (${conversationState.specialty})` : conversationState.specialty ? `✅ Especialidade: ${conversationState.specialty}` : '❌ Médico/Especialidade: PENDENTE'}
${conversationState.preferred_date ? `✅ Data: ${conversationState.preferred_date}` : '❌ Data: PENDENTE'}
${conversationState.preferred_time ? `✅ Horário: ${conversationState.preferred_time}` : '❌ Horário: PENDENTE'}

ESTÁGIO: ${conversationState.conversation_stage}
PRÓXIMO CAMPO A COLETAR: ${conversationState.pending_fields[0] || 'NENHUM - PRONTO PARA CONFIRMAR'}
${conversationState.last_question_asked ? `ÚLTIMA PERGUNTA (NÃO REPITA): "${conversationState.last_question_asked}"` : ''}
`.trim();

  return `
## IDENTIDADE
Você é Juca, secretária virtual da clínica. Seja acolhedora, profissional e humana.

## TOM DE VOZ
- Natural, como pessoa real
- Breve e direta
- Máximo 1-2 emojis (😊 📅 ✅)
- PROIBIDO: "Se precisar de mais informações, é só avisar!"
- PROIBIDO: Repetir perguntas já respondidas
- PROIBIDO: Fazer múltiplas perguntas de uma vez

## MÉDICOS DISPONÍVEIS
${doctorsList}

## ESPECIALIDADES
${specialtiesList}

## HORÁRIO
${clinicSettings?.policies_text || 'Segunda a sexta, 8h às 18h'}

## BASE DE CONHECIMENTO
${kbContext || 'Sem informações adicionais'}

---

${stateDisplay}

---

## REGRAS DE COMPORTAMENTO

### REGRA #1: NUNCA PERGUNTE O QUE JÁ TEM ✅
Se o estado mostra ✅, o dado já foi coletado. USE-O, não pergunte novamente.

### REGRA #2: UMA PERGUNTA POR VEZ
Pergunte apenas UM campo pendente (❌) por mensagem.
Prioridade: 1) Especialidade/Médico → 2) Data → 3) Horário → 4) Nome

### REGRA #3: QUANDO PERGUNTAREM SOBRE MÉDICOS/ESPECIALIDADES
Liste TODOS: "Temos: Dra. Ana Santos (Dermatologia), Dr. Carlos (Clínico Geral), Dra. Fernanda (Cardiologia)... Com qual você quer agendar?"

### REGRA #4: VALIDAÇÃO
Se pedirem especialidade que NÃO existe na lista, diga educadamente e sugira as disponíveis.

### REGRA #5: CONFIRMAÇÃO (quando tudo preenchido)
"${conversationState.patient_name || '[NOME]'}, confirmo sua consulta:
📅 ${conversationState.preferred_date || '[DATA]'} às ${conversationState.preferred_time || '[HORÁRIO]'}
👩‍⚕️ ${conversationState.doctor_name || '[MÉDICO]'}
Posso confirmar? 😊"

### REGRA #6: SAUDAÇÃO INICIAL
Se é início de conversa (ESTÁGIO: greeting), responda algo como:
"Olá! Sou a Juca, secretária virtual da clínica. Posso ajudar com agendamentos, informações ou tirar dúvidas. Como posso te ajudar hoje?"
`.trim();
};
```

---

## TAREFA 4: Salvar Última Pergunta (Anti-Repetição)

Após gerar a resposta, extraia a pergunta feita e salve no estado:

```javascript
// Após gerar a resposta final
const finalMessage = decided.message;

// Detectar se a resposta contém uma pergunta
const questionMatch = finalMessage.match(/[^.!]*\?/);
const lastQuestion = questionMatch ? questionMatch[0].trim() : null;

// Atualizar estado com última pergunta
if (lastQuestion) {
  await updateConversationState(supabase, clinicId, fromNumber, {
    last_question_asked: lastQuestion
  });
}
```

---

## TAREFA 5: Detector de Repetição (Opcional, mas Recomendado)

```javascript
/**
 * Verifica se a resposta é muito similar à última pergunta
 * Retorna true se for repetição
 */
function isRepetition(newMessage, lastQuestion) {
  if (!lastQuestion) return false;
  
  const normalize = (text) => text.toLowerCase()
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 3)
    .sort()
    .join(' ');

  const similarity = calculateJaccardSimilarity(
    normalize(newMessage),
    normalize(lastQuestion)
  );

  return similarity > 0.7; // 70% similar = repetição
}

function calculateJaccardSimilarity(a, b) {
  const setA = new Set(a.split(' '));
  const setB = new Set(b.split(' '));
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return intersection.size / union.size;
}

// Uso após gerar resposta:
if (isRepetition(finalMessage, conversationState.last_question_asked)) {
  console.warn('⚠️ Repetição detectada! Reescrevendo...');
  // Chamar rewriter ou usar fallback
}
```

---

## TAREFA 6: Testar

Após implementar, teste estas conversas:

### Teste 1: Fluxo Completo
```
User: Olá
Bot: [Saudação + oferecer ajuda]
User: Quero marcar consulta
Bot: [Perguntar especialidade]
User: Cardiologia
Bot: [Confirmar Dra. Fernanda + perguntar data]
User: Sexta
Bot: [Perguntar horário]
User: 15h
Bot: [Perguntar nome]
User: Gabriel
Bot: [Confirmar agendamento completo]
```

### Teste 2: Anti-Repetição
```
User: Quero marcar
Bot: Qual especialidade você prefere?
User: Pediatria
Bot: [NÃO deve perguntar especialidade novamente]
```

### Teste 3: Validação
```
User: Quero neurologista
Bot: [Deve informar que não tem e listar as disponíveis]
```

---

## Dados Populados (Para Referência)

A clínica agora tem:
- **10 médicos** (Dermatologia, Clínico Geral, Estética, Cardiologia, Ortopedia, Ginecologia, Pediatria, Nutrição, Psicologia)
- **21 serviços** (consultas, exames, procedimentos)
- **47 horários** configurados
- **18 itens na KB** (informações da clínica)

---

## Checklist de Implementação

- [ ] Adicionar funções de estado (loadConversationState, updateConversationState, etc.)
- [ ] Modificar início de `/process` para carregar estado
- [ ] Buscar doctors e services no início
- [ ] Mergear slots extraídos no estado
- [ ] Refatorar buildSystemPrompt para usar estado
- [ ] Salvar última pergunta após gerar resposta
- [ ] (Opcional) Implementar detector de repetição
- [ ] Testar fluxo completo
- [ ] Deploy no Railway
