# PROMPT PARA CLAUDE CODE — JUCA GUARANA
# Refatoração: Anti-loop, disponibilidade real e estado persistente completo

---

## CONTEXTO DO PROJETO

Você está trabalhando no `agent-service` do sistema JUCA GUARANA, uma secretária inteligente
de clínica médica que atende via WhatsApp. O sistema usa:
- Node.js + Express (ES Modules) no Railway
- Supabase para persistência
- OpenAI para LLM (gpt-4o-mini por padrão)
- n8n como orquestrador de workflows (Router → Worker → Agent)

---

## DIAGNÓSTICO (leia antes de qualquer modificação)

Antes de alterar qualquer código, execute os passos de diagnóstico abaixo na ordem.
**Não pule etapas.**

### PASSO 1 — Verificar se a tabela `conversation_state` existe no Supabase

Execute no Supabase SQL Editor:

```sql
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'conversation_state'
ORDER BY ordinal_position;
```

**Se a tabela não existir:** execute a migração da SEÇÃO A antes de continuar.
**Se existir:** verifique se os campos `last_suggested_dates`, `last_suggested_slots` e `stuck_counter` estão presentes.
Se não estiverem: execute a migração da SEÇÃO B antes de continuar.
**Se todos os campos existirem:** vá direto para a SEÇÃO C.

---

## SEÇÃO A — Criar tabela `conversation_state` (apenas se não existir)

```sql
CREATE TABLE IF NOT EXISTS conversation_state (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  clinic_id       uuid NOT NULL,
  from_number     text NOT NULL,
  state_json      jsonb NOT NULL DEFAULT '{}',
  turn_count      integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  UNIQUE (clinic_id, from_number)
);

CREATE INDEX IF NOT EXISTS idx_conversation_state_lookup
  ON conversation_state (clinic_id, from_number);
```

Após criar, continue para a SEÇÃO B para adicionar os campos novos.

---

## SEÇÃO B — Adicionar campos de memória operacional (se ainda não existirem)

Estes campos são necessários para resolver o loop de disponibilidade e o anti-loop robusto.
Execute **cada bloco separadamente** no Supabase SQL Editor para evitar erro em caso de campo já existente:

```sql
-- Não há campos extras na tabela em si; os dados ficam dentro do state_json (jsonb).
-- O state_json precisa suportar os campos abaixo. Isso é garantido no código.
-- Confirme que a coluna state_json é do tipo jsonb:
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'conversation_state' AND column_name = 'state_json';
```

Se `state_json` for `jsonb`, está correto. O código vai persistir os novos campos dentro dele.

---

## SEÇÃO C — Modificações no `server.js`

Você está editando o arquivo `server.js` do agent-service.
**Leia o arquivo completo antes de editar.**
**Faça as modificações na ordem descrita.**
**Não remova nenhum código existente sem justificativa explícita aqui.**

---

### MODIFICAÇÃO C1 — Adicionar campos ao `resetConversationState`

**Localizar** a função `resetConversationState` (por volta da linha 317).
**Encontrar** o objeto `initialState`.
**Adicionar** os campos abaixo **dentro** do `initialState`, após `appointment_confirmed`:

```js
// Campos de memória operacional (anti-loop de disponibilidade)
last_suggested_dates: [],       // array de datas retornadas pela tool buscar_proximas_datas
last_suggested_slots: [],       // array de horários retornados pela tool verificar_disponibilidade
stuck_counter: {},              // { patient_name: 0, specialty_or_doctor: 0, preferred_date: 0, preferred_time: 0 }
```

**Resultado esperado do objeto completo:**
```js
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
  // Novos campos
  last_suggested_dates: [],
  last_suggested_slots: [],
  stuck_counter: {},
};
```

---

### MODIFICAÇÃO C2 — Adicionar lógica de `stuck_counter` na função `mergeExtractedSlots`

**Localizar** a função `mergeExtractedSlots` (por volta da linha 382).
**Após a linha** `updates.pending_fields = calculatePendingFields(updates);`
**Adicionar** o bloco abaixo:

```js
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
```

**Objetivo:** se `stuck_counter.preferred_date >= 2`, o agente deve chamar
`buscar_proximas_datas` em vez de perguntar a data novamente.

---

### MODIFICAÇÃO C3 — Criar função auxiliar `detectAvailabilityQuestion`

**Adicionar** esta função nova logo após a função `isRepetition` (por volta da linha 484):

```js
/**
 * Detecta se a mensagem do usuário é uma pergunta de disponibilidade.
 * Quando verdadeiro, o agente deve chamar buscar_proximas_datas em vez de
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
```

---

### MODIFICAÇÃO C4 — Modificar o system prompt (`buildSystemPrompt`)

**Localizar** a função `buildSystemPrompt` (por volta da linha 494).
**Substituir** a seção `## REGRAS DE COMPORTAMENTO` inteira pelo bloco abaixo.
**Atenção:** manter tudo que está antes e depois desta seção, apenas substituir as REGRAS.

```js
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
- Use last_suggested_dates ou last_suggested_slots (listados no estado) para resolver.
- Nunca peça para repetir uma escolha que já foi dada sobre opções que você apresentou.

### REGRA #5: ANTI-LOOP — STUCK COUNTER
${(cs.stuck_counter?.preferred_date || 0) >= 2
  ? '⚠️ ATENÇÃO: A data foi perguntada 2 ou mais vezes sem resposta. NÃO pergunte de novo. Use a ferramenta buscar_proximas_datas e ofereça as opções diretamente.'
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
```

**Importante:** Dentro da função `buildSystemPrompt`, a variável `cs` já existe (linha 498).
As template strings com `cs.stuck_counter` acima devem ser convertidas para interpolação JS normal.
Exemplo de como implementar a parte do stuck_counter dentro da template string:

```js
const stuckDateWarning = (cs.stuck_counter?.preferred_date || 0) >= 2
  ? '⚠️ ATENÇÃO: A data foi perguntada 2+ vezes. NÃO pergunte de novo. Chame buscar_proximas_datas.'
  : '';

const stuckTimeWarning = (cs.stuck_counter?.preferred_time || 0) >= 2
  ? '⚠️ ATENÇÃO: O horário foi perguntado 2+ vezes. Chame verificar_disponibilidade ou ofereça períodos.'
  : '';
```

E use `${stuckDateWarning}` e `${stuckTimeWarning}` dentro da template string do prompt.

---

### MODIFICAÇÃO C5 — Interceptar perguntas de disponibilidade antes do decide_next_action

**Localizar** o trecho da STEP 1 (`decide_next_action`), por volta da linha 955.
**Antes** do bloco `if (step < MAX_STEPS)`, adicionar:

```js
// ======================================================
// 8a) INTERCEPTOR DE DISPONIBILIDADE
// Quando usuário pergunta disponibilidade e temos médico no estado,
// forçar o agente a chamar a tool em vez de perguntar a data.
// ======================================================
const isAvailabilityQuery = detectAvailabilityQuestion(envelope.message_text);
const hasDoctorInState = !!(updatedState.doctor_id);

if (
  isAvailabilityQuery &&
  hasDoctorInState &&
  extracted?.intent_group === 'scheduling'
) {
  log.info({ doctorId: updatedState.doctor_id }, '🔍 Pergunta de disponibilidade detectada — forçando tool buscar_proximas_datas');

  // Chamar diretamente a tool de agenda
  const { executeSchedulingTool } = await import('./tools/schedulingTools.js');
  const availResult = await executeSchedulingTool(
    'buscar_proximas_datas',
    { doctor_id: updatedState.doctor_id, dias: 14 },
    { clinicId: envelope.clinic_id, userPhone: envelope.from }
  );

  if (availResult?.success && availResult?.dates?.length > 0) {
    // Salvar datas sugeridas no estado para referência futura ("a primeira")
    await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
      last_suggested_dates: availResult.dates,
    });

    const dateList = availResult.dates
      .slice(0, 5)
      .map((d, i) => `${i + 1}) ${d.display || d.date}`)
      .join('\n');

    decided = {
      decision_type: 'proceed',
      message: `Tenho os seguintes horários disponíveis com ${updatedState.doctor_name}:\n${dateList}\n\nQual dessas datas funciona melhor pra você?`,
      actions: [{ type: 'log' }],
      confidence: 1,
    };

    // Pular decide_next_action e ir direto para o agente
    step = MAX_STEPS; // encerra o loop de steps
  }
  // Se a tool falhar, segue o fluxo normal
}
```

**Atenção:** o import de `executeSchedulingTool` já está feito no topo do arquivo (linha 11).
Remova o `await import(...)` acima e use diretamente `executeSchedulingTool` que já está disponível no escopo.
O bloco correto fica assim:

```js
const availResult = await executeSchedulingTool(
  'buscar_proximas_datas',
  { doctor_id: updatedState.doctor_id, dias: 14 },
  { clinicId: envelope.clinic_id, userPhone: envelope.from }
);
```

---

### MODIFICAÇÃO C6 — Salvar `last_suggested_slots` após tool `verificar_disponibilidade`

**Localizar** o loop do agente (por volta da linha 1072), especificamente o trecho onde
`toolResult` é processado após o `for (const toolCall ...)`.
**Após** a linha que faz `agentMessages.push(...)` com o resultado da tool,
**adicionar:**

```js
// Persistir opções apresentadas no estado para suportar respostas como "o primeiro"
if (toolCall.function.name === 'buscar_proximas_datas' && toolResult?.success) {
  await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
    last_suggested_dates: toolResult.dates || [],
  });
}
if (toolCall.function.name === 'verificar_disponibilidade' && toolResult?.success) {
  await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
    last_suggested_slots: toolResult.slots || toolResult.available_times || [],
  });
}
```

---

### MODIFICAÇÃO C7 — Expor `last_suggested_dates` e `last_suggested_slots` no stateDisplay

**Localizar** a constante `stateDisplay` dentro de `buildSystemPrompt` (por volta da linha 499).
**Após** a linha que exibe `ÚLTIMA PERGUNTA FEITA`, **adicionar:**

```js
${(cs.last_suggested_dates || []).length > 0
  ? `DATAS JÁ APRESENTADAS AO PACIENTE: ${cs.last_suggested_dates.map((d, i) => `${i + 1}) ${d.display || d.date}`).join(', ')}`
  : ''}
${(cs.last_suggested_slots || []).length > 0
  ? `HORÁRIOS JÁ APRESENTADOS AO PACIENTE: ${cs.last_suggested_slots.map((s, i) => `${i + 1}) ${s}`).join(', ')}`
  : ''}
```

---

## SEÇÃO D — Checklist de validação pós-implementação

Após todas as modificações, realize os testes abaixo em sequência.
Use o tester HTML em `GET /process` para executar.

**Teste 1 — Pergunta de disponibilidade com médico conhecido:**
```json
{ "message_text": "Que dia o médico tem disponível?" }
```
Esperado: bot chama `buscar_proximas_datas` e retorna lista de datas reais (não pergunta "qual data prefere?").

**Teste 2 — Escolha de "a primeira opção":**
```json
{ "message_text": "A primeira" }
```
Esperado: bot usa `last_suggested_dates[0]` para resolver, não pede para repetir.

**Teste 3 — Interrupção por convênio:**
```json
{ "message_text": "Vocês aceitam Unimed?" }
```
Esperado: bot responde sobre convênio E retoma com a próxima pendência sem recomeçar tudo.

**Teste 4 — Anti-loop (stuck_counter):**
Envie 3 mensagens consecutivas sem informar data. Na terceira o bot deve oferecer datas diretamente.

**Teste 5 — Agendamento completo:**
Complete um agendamento do início ao fim (nome → especialidade → data → horário → confirmação).
Deve funcionar sem loops, sem reiniciar, sem inventar horários.

---

## SEÇÃO E — O que NÃO fazer (riscos identificados)

- **NÃO** usar regex sobre texto do histórico para inferir slots (o `extractCollectedSlots` por regex sugerido em documentos externos é frágil e já foi substituído pelo `mergeExtractedSlots` com validação real).
- **NÃO** remover o fluxo de `extract_intent` → `decide_next_action`. Ele é necessário e correto.
- **NÃO** criar uma segunda fonte de estado. O `conversation_state` no Supabase é a única fonte da verdade.
- **NÃO** alterar o schema do `EnvelopeSchema` sem atualizar os workflows do n8n.
- **NÃO** adicionar `stuck_counter` como coluna nova no Supabase — ele vive dentro do `state_json` (jsonb).

---

## REFERÊNCIA RÁPIDA DE ARQUIVOS

```
agent-service/
├── server.js                    ← arquivo principal (todas as modificações acima)
├── tools/
│   └── schedulingTools.js       ← tools de agenda (NÃO modificar)
├── services/
│   └── schedulingService.js     ← implementações das tools (NÃO modificar aqui)
└── routes/
    └── adminRoutes.js           ← painel admin (NÃO modificar)
```

As tools de agendamento (`buscar_proximas_datas`, `verificar_disponibilidade`, etc.)
**já estão implementadas** em `schedulingTools.js` e `schedulingService.js`.
O `server.js` já importa e executa essas tools no loop do agente (linha 11 e ~1077).
O trabalho aqui é conectar o fluxo correto **antes** de chegar nesse loop,
e garantir que o estado persistente seja atualizado com as opções apresentadas.
