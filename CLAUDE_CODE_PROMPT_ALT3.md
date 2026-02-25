# CLAUDE_CODE_PROMPT — Alternativa 3: Reestruturação com Memória Robusta
# Projeto: JUCA GUARANA — Secretaria Inteligente para Clínicas

---

## 1. CONTEXTO DO PROJETO

Você está atuando como engenheiro sênior num sistema de secretaria virtual para clínicas médicas/estéticas.
O sistema opera via WhatsApp (Meta API) e é composto por três camadas principais:

| Camada | Tecnologia | Responsabilidade |
|--------|-----------|-----------------|
| Router | n8n workflow | Recebe webhooks WhatsApp, deduplica, identifica clínica, enfileira |
| Worker | n8n workflow (queue mode) | Processa mensagens, monta contexto, chama agent-service, salva histórico, envia resposta |
| Agent Service | Node.js/Express no Railway | Lógica de IA — extração de intenção via OpenAI, tool-use, geração de resposta |

**Banco de dados:** Supabase (PostgreSQL)
**Infraestrutura:** Railway (deploy via GitHub push)
**Memória de contexto:** tabela `conversation_history` no Supabase
**Base de conhecimento da clínica:** tabela `clinic_kb`
**Configurações da clínica:** tabela `clinic_settings`

---

## 2. PROBLEMAS QUE ESTE PLANO RESOLVE

Os três problemas observados em testes são:

**A) Perda de memória entre turnos** — O agente esquece dados já fornecidos pelo usuário (nome, intenção, data preferida) e repete perguntas. Root cause: o histórico ou não está sendo recuperado, ou a janela de contexto é pequena demais, ou o model não recebe as mensagens anteriores formatadas corretamente.

**B) Não mostra horários disponíveis** — O agente não consulta dados reais de agenda. Não existem tabelas de médicos, horários e agendamentos estruturadas. O agente não possui tools para consultar disponibilidade.

**C) Não responde sobre planos de saúde** — A `clinic_kb` não contém entradas sobre convênios aceitos pela clínica.

---

## 3. OBJETIVO DESTA SESSÃO

Implementar a **Alternativa 3 — Reestruturação com Memória Robusta**, que inclui:

1. Camada de sumarização de contexto (context summary) para memória estável
2. Tabelas de agenda real no Supabase (doctors, schedules, appointments)
3. Tools no agent-service: `check_availability` e `book_appointment`
4. Popular `clinic_kb` com dados de convênios e especialidades
5. Sistema de logs de gaps de conhecimento (quando o agente não acha info na KB)
6. Refatoração do `system prompt` para ser explícito sobre manutenção de contexto

---

## 4. REGRAS DE TRABALHO (OBRIGATÓRIAS)

Siga estas regras em todas as etapas:

- **Leia antes de escrever.** Antes de qualquer modificação num arquivo existente, leia-o completo.
- **Uma etapa por vez.** Complete e valide cada etapa antes de avançar.
- **Sem suposições.** Se um campo, variável ou estrutura não está visível no código lido, pergunte antes de assumir.
- **Commits atômicos.** Cada etapa gera um commit próprio com mensagem descritiva em inglês.
- **Nunca quebre o que funciona.** Toda modificação deve preservar o comportamento atual até que o novo esteja testado.
- **Código em inglês, comentários e logs em português-BR.**
- **Valide o contrato de dados** entre o Worker (n8n) e o Agent Service antes de modificar qualquer payload.

---

## 5. PLANO DE IMPLEMENTAÇÃO — SEQUÊNCIA OBRIGATÓRIA

### ETAPA 1 — Auditoria e leitura do estado atual

**Objetivo:** Entender exatamente o que existe antes de modificar qualquer coisa.

Ações:
1. Ler o arquivo `server.js` completo do agent-service
2. Identificar: como o histórico é recebido (`envelope.context.previous_messages`), como é montado o array `messages` para o OpenAI, quais tools já existem, qual é o `system prompt` atual
3. Consultar no Supabase as tabelas existentes: `conversation_history`, `clinic_kb`, `clinic_settings`, `appointments` (se existir)
4. Mapear o payload que o Worker envia ao agent-service (campo `context`, campo `previous_messages`, campos de clínica e paciente)
5. **Não modifique nada nesta etapa.** Apenas leia e documente o que encontrou num comentário de análise antes de prosseguir.

**Critério de conclusão:** Você consegue descrever com precisão o fluxo atual de dados de ponta a ponta, incluindo os campos que chegam ao `server.js` e como são usados.

---

### ETAPA 2 — Banco de dados: novas tabelas e dados iniciais

**Objetivo:** Criar estrutura de dados para agenda real e popular clinic_kb.

Ações no Supabase (via SQL):

**2.1 — Tabela `doctors`**
```sql
CREATE TABLE IF NOT EXISTS doctors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id UUID NOT NULL,
  name VARCHAR(200) NOT NULL,
  specialty VARCHAR(100) NOT NULL,
  crm VARCHAR(30),
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_doctors_clinic ON doctors(clinic_id);
```

**2.2 — Tabela `schedules`** (grade de disponibilidade por médico)
```sql
CREATE TABLE IF NOT EXISTS schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id UUID NOT NULL REFERENCES doctors(id),
  clinic_id UUID NOT NULL,
  weekday SMALLINT NOT NULL CHECK (weekday BETWEEN 0 AND 6), -- 0=Dom, 1=Seg...
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  slot_duration_minutes SMALLINT NOT NULL DEFAULT 30,
  active BOOLEAN DEFAULT TRUE
);
CREATE INDEX IF NOT EXISTS idx_schedules_doctor ON schedules(doctor_id);
CREATE INDEX IF NOT EXISTS idx_schedules_clinic ON schedules(clinic_id, weekday);
```

**2.3 — Tabela `appointments`**
```sql
CREATE TABLE IF NOT EXISTS appointments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id UUID NOT NULL,
  doctor_id UUID NOT NULL REFERENCES doctors(id),
  patient_name VARCHAR(200) NOT NULL,
  patient_phone VARCHAR(50) NOT NULL,
  appointment_date DATE NOT NULL,
  appointment_time TIME NOT NULL,
  specialty VARCHAR(100),
  status VARCHAR(30) DEFAULT 'scheduled' CHECK (status IN ('scheduled','cancelled','completed','rescheduled')),
  notes TEXT,
  booked_via VARCHAR(30) DEFAULT 'whatsapp',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_appointments_clinic_date ON appointments(clinic_id, appointment_date);
CREATE INDEX IF NOT EXISTS idx_appointments_doctor_date ON appointments(doctor_id, appointment_date);
CREATE INDEX IF NOT EXISTS idx_appointments_patient ON appointments(patient_phone, clinic_id);
```

**2.4 — Inserir dados de exemplo** (substituir `clinic_id` real após criar tabelas):
Insira pelo menos 1 médico com 2-3 slots de horário semanal para que os testes funcionem.

**2.5 — Popular `clinic_kb` com convênios:**
```sql
INSERT INTO clinic_kb (clinic_id, title, content, category)
VALUES 
  ('<CLINIC_ID>', 'Convênios Aceitos', 'Aceitamos os seguintes planos de saúde: Unimed, Bradesco Saúde, SulAmérica, Amil e Porto Seguro. Não aceitamos planos municipais ou estaduais. Consultas particulares também são bem-vindas.', 'financeiro'),
  ('<CLINIC_ID>', 'Política de Cancelamento', 'Cancelamentos devem ser feitos com pelo menos 24 horas de antecedência. Faltas sem aviso podem acarretar cobrança de taxa.', 'politicas'),
  ('<CLINIC_ID>', 'Documentos Necessários', 'Traga documento de identidade, cartão do convênio (se houver) e pedido médico quando necessário.', 'orientacoes');
```

> Substitua `<CLINIC_ID>` pelo UUID real da clínica antes de executar.

**Critério de conclusão:** Todas as tabelas criadas com sucesso, ao menos 1 médico e 2 horários cadastrados, clinic_kb com entradas de convênios.

---

### ETAPA 3 — Camada de sumarização de contexto (Context Summary)

**Objetivo:** Criar uma função que sumariza conversas longas em texto estruturado, reduzindo tokens e tornando a memória mais estável.

Implemente no `server.js` a função `buildContextSummary`:

```javascript
/**
 * Constrói um resumo estruturado da conversa para injetar no system prompt.
 * Evita passar mensagens brutas quando o histórico é longo.
 *
 * @param {Array} previousMessages - Array de mensagens anteriores {role, content, timestamp}
 * @returns {string} Resumo formatado ou string vazia se não há histórico
 */
function buildContextSummary(previousMessages) {
  if (!previousMessages || previousMessages.length === 0) return '';

  // Extrair dados coletados (slots) das mensagens
  const userMessages = previousMessages
    .filter(m => m.role === 'user')
    .map(m => m.content);

  const assistantMessages = previousMessages
    .filter(m => m.role === 'assistant')
    .map(m => m.content);

  const summary = [
    '--- CONTEXTO DA CONVERSA ATUAL ---',
    `Turnos anteriores: ${previousMessages.length}`,
    `Última mensagem do paciente: "${userMessages[userMessages.length - 1] || 'N/A'}"`,
    `Última resposta da secretaria: "${assistantMessages[assistantMessages.length - 1] || 'N/A'}"`,
    '--- FIM DO CONTEXTO ---',
  ].join('\n');

  return summary;
}
```

> Esta função será chamada dentro do `system prompt` para conversas com mais de 4 turnos. Para conversas curtas, continuar passando as mensagens brutas no array `messages`.

**Critério de conclusão:** Função implementada e testada localmente com um array de mensagens fake.

---

### ETAPA 4 — Tools no agent-service: `check_availability` e `book_appointment`

**Objetivo:** Dar ao agente capacidade real de consultar horários e registrar agendamentos.

**4.1 — Implementar função `checkAvailability`** no `server.js`:

```javascript
/**
 * Consulta horários disponíveis para um médico/especialidade em uma data.
 * Busca na tabela schedules e subtrai appointments já confirmados.
 *
 * @param {string} clinicId
 * @param {string} specialty - especialidade desejada pelo paciente
 * @param {string} dateStr - data no formato YYYY-MM-DD
 * @returns {Object} { available: boolean, slots: Array, doctorName: string }
 */
async function checkAvailability(clinicId, specialty, dateStr) {
  // 1. Buscar médico da especialidade ativo na clínica
  // 2. Calcular weekday da data fornecida
  // 3. Buscar schedules do médico para esse weekday
  // 4. Gerar todos os slots no intervalo start_time → end_time com slot_duration_minutes
  // 5. Buscar appointments já existentes na data para o médico
  // 6. Subtrair slots ocupados
  // 7. Retornar slots livres formatados como ["09:00", "09:30", ...]
}
```

Implemente a lógica completa usando o client Supabase já inicializado no `server.js`.

**4.2 — Implementar função `bookAppointment`**:

```javascript
/**
 * Registra um agendamento na tabela appointments.
 * Valida se o slot ainda está disponível antes de inserir (prevenção de race condition).
 *
 * @param {Object} params - { clinicId, doctorId, patientName, patientPhone, date, time, specialty }
 * @returns {Object} { success: boolean, appointmentId: string, message: string }
 */
async function bookAppointment(params) {
  // 1. Verificar novamente se o slot ainda está livre (double-check)
  // 2. Inserir na tabela appointments com status='scheduled'
  // 3. Retornar confirmação com id e horário formatado
}
```

**4.3 — Registrar as tools no OpenAI tool_use:**

Adicione as duas tools ao array de tools da chamada OpenAI, com definição JSON Schema clara de parâmetros (`specialty`, `date` no formato YYYY-MM-DD, `patientName`, `patientPhone`, `time`).

**4.4 — Implementar handler de tool calls** no loop de processamento do agente:
Quando o modelo retornar `tool_use`, executar a função correspondente, montar a mensagem `tool_result` e reenviar para o modelo gerar a resposta final ao paciente.

**Critério de conclusão:** Enviar uma mensagem de teste pedindo horários e verificar no log que `checkAvailability` foi chamado com os parâmetros corretos e retornou slots reais do banco.

---

### ETAPA 5 — Refatoração do system prompt

**Objetivo:** Tornar o agente explicitamente ciente do contexto da conversa e incapaz de repetir perguntas já respondidas.

O novo `system prompt` deve incluir as seguintes seções obrigatórias:

```
Seção 1 — Identidade:
Você é a secretária virtual da [nome da clínica]. Seu nome é [nome do agente].
Seja sempre educada, prestativa e objetiva. Use linguagem informal mas respeitosa.

Seção 2 — Regras de comportamento:
- NUNCA repita uma pergunta que já foi respondida no histórico da conversa.
- Se o paciente já forneceu o nome, use-o nas respostas seguintes.
- Se já foi informada a intenção (marcar/cancelar/remarcar), não pergunte novamente.
- Seja breve. Máximo 2-3 frases por resposta.
- Use apenas informações da base de conhecimento (KB) fornecida.
- Nunca invente horários, nomes de médicos ou convênios.

Seção 3 — Contexto atual da conversa:
[INJETAR output da função buildContextSummary aqui]

Seção 4 — Base de conhecimento da clínica:
[INJETAR kbContext aqui]
```

**Critério de conclusão:** Após o deploy, testar a conversa do print (nome + data + confirmação) e verificar que o agente não repete a pergunta de intenção.

---

### ETAPA 6 — Logs de gaps de conhecimento

**Objetivo:** Registrar quando o agente não encontra informação na KB, para popular proativamente.

Implemente uma função simples:

```javascript
/**
 * Registra na tabela agent_logs situações onde o agente não achou informação.
 * Permite identificar quais dados estão faltando na clinic_kb.
 */
async function logKnowledgeGap(clinicId, question, context) {
  await supabase.from('agent_logs').insert({
    clinic_id: clinicId,
    log_type: 'knowledge_gap',
    message: `Pergunta sem resposta na KB: "${question}"`,
    context: context,
    created_at: new Date().toISOString()
  });
}
```

Crie a tabela `agent_logs` no Supabase se não existir:

```sql
CREATE TABLE IF NOT EXISTS agent_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id UUID,
  log_type VARCHAR(50) NOT NULL,
  message TEXT NOT NULL,
  context JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_agent_logs_clinic ON agent_logs(clinic_id, log_type, created_at DESC);
```

Chame `logKnowledgeGap` quando o agente retornar uma resposta com confidence baixa ou quando a KB não tiver dados sobre a pergunta do usuário.

**Critério de conclusão:** Tabela criada, função implementada e ao menos um log gerado num teste.

---

### ETAPA 7 — Deploy e validação end-to-end

**Objetivo:** Garantir que todas as mudanças funcionam integradas.

Sequência obrigatória:

1. Commit com mensagem: `feat: robust memory, scheduling tools, knowledge gap logging`
2. Push para a branch main (Railway faz deploy automático)
3. Aguardar deploy ficar ativo nos logs do Railway (procure por `🚀 agent-service listening on port`)
4. Teste 1 — Convênios: enviar "vocês aceitam Unimed?" e verificar que a resposta cita convênios da KB
5. Teste 2 — Memória: replicar exatamente o fluxo do print (nome + data) e verificar que o agente não pergunta a intenção novamente
6. Teste 3 — Agendamento: solicitar consulta com ginecologista para sexta-feira e verificar se `check_availability` é chamado e retorna horários reais
7. Verificar no Supabase: `agent_logs` e `appointments` após os testes

---

## 6. VARIÁVEIS DE AMBIENTE NECESSÁRIAS (Railway)

Confirme que estas variáveis existem antes de iniciar:

| Variável | Descrição |
|----------|-----------|
| `OPENAI_API_KEY` | Chave da API OpenAI |
| `OPENAI_MODEL` | Modelo a usar (ex: `gpt-4o-mini`) |
| `SUPABASE_URL` | URL do projeto Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Chave de serviço (não a anon key) |
| `PORT` | Porta do servidor (Railway define automaticamente) |
| `DEBUG` | `true` em desenvolvimento, `false` em produção |

---

## 7. PONTOS DE ATENÇÃO E RISCOS

- **Race condition no agendamento:** A função `bookAppointment` deve fazer double-check do slot antes de inserir. Use uma transação ou verificação atômica.
- **Formato de data:** Sempre trabalhe com datas no formato `YYYY-MM-DD` internamente. Converta para o formato legível (ex: "sexta-feira, 28/02") apenas na resposta ao usuário.
- **Limite de tokens:** Se o histórico ultrapassar 20 turnos, use apenas `buildContextSummary` sem passar as mensagens brutas, para não estourar a janela de contexto.
- **Clinic_id:** Toda query no Supabase deve filtrar por `clinic_id`. Nunca busque dados sem esse filtro.
- **Não quebre o fluxo atual:** As funções `checkAvailability` e `bookAppointment` são chamadas apenas quando o modelo decide usar as tools. O fluxo de perguntas simples (saudação, convênios, horários de funcionamento) continua sendo respondido pela KB sem tools.

---

## 8. CRITÉRIO FINAL DE SUCESSO

O plano está concluído quando:

- [ ] Agente responde corretamente sobre convênios aceitos pela clínica
- [ ] Agente não repete perguntas já respondidas no mesmo turno de conversa
- [ ] Agente consulta horários reais do banco e apresenta opções ao paciente
- [ ] Agendamento confirmado pelo agente é visível na tabela `appointments` no Supabase
- [ ] Logs de gaps de conhecimento sendo gerados na tabela `agent_logs`
- [ ] Deploy ativo no Railway sem crashes

---

*Prompt criado para o projeto JUCA GUARANA — Versão Alternativa 3*
*Stack: Node.js/Express · Supabase · n8n · Railway · OpenAI*
