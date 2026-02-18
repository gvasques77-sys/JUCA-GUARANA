# 🤖 Agent Service - Secretária Inteligente

## 📚 ÍNDICE

1. [O que é este projeto?](#o-que-é-este-projeto)
2. [O que estava errado?](#o-que-estava-errado)
3. [O que foi corrigido?](#o-que-foi-corrigido)
4. [Como funciona o código?](#como-funciona-o-código)
5. [Como configurar?](#como-configurar)
6. [Como testar?](#como-testar)
7. [Estrutura do projeto](#estrutura-do-projeto)
8. [Conceitos importantes](#conceitos-importantes)

---

## 🎯 O QUE É ESTE PROJETO?

Este é um **agente de IA** que funciona como uma **secretária inteligente** para clínicas.

**O que ele faz:**
- Recebe mensagens de pacientes
- Entende a intenção (marcar consulta, perguntar preço, etc)
- Responde de forma inteligente
- Segue as regras da clínica

**Como funciona:**
1. Paciente manda mensagem via WhatsApp
2. N8n/Worker envia para este servidor
3. Servidor processa com IA (OpenAI)
4. Resposta volta para o paciente

---

## ❌ O QUE ESTAVA ERRADO?

### Problema #1: API Inexistente
```javascript
// ❌ ERRADO (API não existe)
await openai.responses.create({
  instructions: '...',
  input: '...'
})
```

**Por quê estava errado:**
- A OpenAI **não tem** API chamada `responses.create()`
- O código estava tentando usar uma API fictícia
- Resultado: ERRO 500 (servidor não conseguia processar)

### Problema #2: Campo `instructions` não existe
```javascript
// ❌ ERRADO
instructions: 'Você é um classificador...'
```

**Por quê estava errado:**
- A API correta usa `messages` (não `instructions`)
- Precisa seguir o formato de conversação

### Problema #3: Formato de resposta errado
```javascript
// ❌ ERRADO
const call = extraction.output?.find(...)
```

**Por quê estava errado:**
- A resposta vem em `choices[0].message.tool_calls`
- Não existe campo `output` na resposta da OpenAI

---

## ✅ O QUE FOI CORRIGIDO?

### Correção #1: API Correta
```javascript
// ✅ CORRETO
await openai.chat.completions.create({
  model: 'gpt-4o-mini',
  messages: [
    { role: 'system', content: '...' },
    { role: 'user', content: '...' }
  ],
  tools: [...]
})
```

### Correção #2: Formato de Mensagens
```javascript
// ✅ CORRETO
messages: [
  {
    role: 'system',  // Instruções para a IA
    content: 'Você é um classificador...'
  },
  {
    role: 'user',    // Mensagem do usuário
    content: envelope.message_text
  }
]
```

### Correção #3: Parsing da Resposta
```javascript
// ✅ CORRETO
const call = extraction.choices[0]?.message?.tool_calls?.[0];
const parsedArgs = call?.function?.arguments 
  ? JSON.parse(call.function.arguments) 
  : null;
```

### Correção #4: Formato das Tools
```javascript
// ✅ CORRETO
tools: [
  {
    type: 'function',
    function: {  // ← Precisa estar dentro de "function"
      name: 'extract_intent',
      description: '...',
      parameters: { ... }
    }
  }
]
```

---

## 🔍 COMO FUNCIONA O CÓDIGO?

### Fluxo Completo (Passo a Passo)

```
1. RECEBE MENSAGEM
   ↓
2. VALIDA DADOS (Zod)
   ↓
3. BUSCA CONFIGURAÇÕES DA CLÍNICA (Supabase)
   ↓
4. BUSCA BASE DE CONHECIMENTO (Supabase)
   ↓
5. STEP 0: EXTRAI INTENÇÃO (OpenAI + Function Calling)
   - Identifica o que o paciente quer
   - Extrai informações estruturadas
   ↓
6. VERIFICA CONFIANÇA (confidence)
   - Se < 0.6: pede clarificação
   ↓
7. STEP 1: DECIDE AÇÃO (OpenAI + Function Calling)
   - Decide o próximo passo
   - Gera resposta para o paciente
   ↓
8. VALIDA NO BACKEND
   - Exemplo: bloqueia preços se allow_prices=false
   ↓
9. SALVA LOG (Supabase)
   ↓
10. RETORNA RESPOSTA
```

### Explicação de Cada Parte

#### 1️⃣ VALIDAÇÃO (Zod)
```javascript
const EnvelopeSchema = z.object({
  correlation_id: z.string().min(6),
  clinic_id: z.string().uuid(),
  from: z.string().min(5),
  message_text: z.string().min(1),
});
```

**O que faz:** Verifica se os dados recebidos estão corretos.
**Por quê:** Evita processar dados inválidos (protege o servidor).

#### 2️⃣ BUSCAR REGRAS DA CLÍNICA
```javascript
const { data: settings } = await supabase
  .from('clinic_settings')
  .select('*')
  .eq('clinic_id', envelope.clinic_id)
  .maybeSingle();
```

**O que faz:** Busca as configurações específicas da clínica.
**Exemplos de regras:**
- `allow_prices: false` → Não pode informar preços
- `timezone: 'America/Cuiaba'` → Fuso horário
- `business_hours: {...}` → Horário de funcionamento

#### 3️⃣ BUSCAR BASE DE CONHECIMENTO (RAG)
```javascript
const { data: kbRows } = await supabase
  .from('clinic_kb')
  .select('title, content')
  .eq('clinic_id', envelope.clinic_id)
  .limit(8);
```

**O que faz:** Busca informações da clínica (procedimentos, preços de referência, etc).
**Por quê:** A IA usa isso como "contexto" para dar respostas mais precisas.

#### 4️⃣ FUNCTION CALLING (OpenAI)
```javascript
const tools = [
  {
    type: 'function',
    function: {
      name: 'extract_intent',
      description: 'Classifica intenção...',
      parameters: { ... }
    }
  }
]
```

**O que é:** Uma forma de fazer a IA retornar dados estruturados (JSON).
**Por quê:** Em vez da IA retornar texto livre, ela retorna um JSON que o código pode processar.

**Exemplo:**
- Entrada: "Quero marcar consulta amanhã de manhã"
- Saída (JSON):
```json
{
  "intent_group": "scheduling",
  "intent": "schedule_new",
  "slots": {
    "time_window": "morning",
    "preferred_date_text": "amanhã"
  },
  "missing_fields": ["patient_name"],
  "confidence": 0.92
}
```

#### 5️⃣ LOOP CONTROLADO (MAX 2 STEPS)
```javascript
let step = 0;
if (step < MAX_STEPS) {
  // STEP 0: extract_intent
  step++;
}
if (step < MAX_STEPS) {
  // STEP 1: decide_next_action
  step++;
}
```

**O que faz:** Limita quantas vezes a IA pode ser chamada.
**Por quê:** Evita loops infinitos e custos altos.

#### 6️⃣ CONFIDENCE GUARD
```javascript
if (!extracted || extracted.confidence < 0.6) {
  return res.json({
    final_message: 'Só para confirmar: você quer marcar, remarcar ou cancelar?'
  });
}
```

**O que faz:** Se a IA não tem certeza, pede clarificação.
**Por quê:** Melhor pedir confirmação do que dar resposta errada.

#### 7️⃣ VALIDAÇÃO BACKEND
```javascript
if (extracted.intent_group === 'billing' && 
    clinicRules.allow_prices === false) {
  decided = {
    decision_type: 'block_price',
    message: 'Por aqui não informamos valores...'
  };
}
```

**O que faz:** Garante que regras sejam respeitadas (não confia 100% na IA).
**Por quê:** Segurança - o backend tem a palavra final.

---

## ⚙️ COMO CONFIGURAR?

### Passo 1: Instalar Dependências
```bash
npm install
```

### Passo 2: Criar arquivo `.env`
```bash
# No Windows (PowerShell)
cp .env.example .env

# No Linux/Mac
cp .env.example .env
```

### Passo 3: Preencher `.env` com dados reais

#### 3.1 - OpenAI API Key
1. Acesse: https://platform.openai.com/api-keys
2. Clique em "Create new secret key"
3. Copie a chave (começa com `sk-proj-...`)
4. Cole no `.env`:
```env
OPENAI_API_KEY=sk-proj-SUA_CHAVE_AQUI
```

#### 3.2 - Supabase
1. Acesse: https://app.supabase.com
2. Entre no seu projeto
3. Vá em: Settings → API
4. Copie:
   - **URL** (Project URL)
   - **service_role key** (⚠️ NÃO a anon key)
5. Cole no `.env`:
```env
SUPABASE_URL=https://seuprojeto.supabase.co
SUPABASE_SERVICE_ROLE_KEY=sua_service_role_key_aqui
```

### Passo 4: Criar Tabelas no Supabase

Execute este SQL no Supabase (SQL Editor):

```sql
-- Tabela de configurações das clínicas
CREATE TABLE clinic_settings (
  clinic_id UUID PRIMARY KEY,
  allow_prices BOOLEAN DEFAULT false,
  timezone TEXT DEFAULT 'America/Cuiaba',
  business_hours JSONB DEFAULT '{}',
  policies_text TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Tabela de base de conhecimento
CREATE TABLE clinic_kb (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id UUID REFERENCES clinic_settings(clinic_id),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Tabela de logs
CREATE TABLE agent_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id UUID,
  correlation_id TEXT,
  intent_group TEXT,
  intent TEXT,
  confidence NUMERIC,
  decision_type TEXT,
  latency_ms INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);
```

### Passo 5: Inserir Dados de Teste

```sql
-- Inserir clínica de teste
INSERT INTO clinic_settings (clinic_id, allow_prices, timezone, business_hours, policies_text)
VALUES (
  '09e5240f-9c26-47ee-a54d-02934a36ebfd',
  false,
  'America/Cuiaba',
  '{"mon":{"open":"08:00","close":"18:00"},"tue":{"open":"08:00","close":"18:00"},"wed":{"open":"08:00","close":"18:00"},"thu":{"open":"08:00","close":"18:00"},"fri":{"open":"08:00","close":"18:00"}}'::jsonb,
  'Atendemos de segunda a sexta, das 8h às 18h.'
);

-- Inserir conhecimento de teste
INSERT INTO clinic_kb (clinic_id, title, content)
VALUES 
  ('09e5240f-9c26-47ee-a54d-02934a36ebfd', 'Consulta Dermatologia', 'Consultas com dermatologista custam R$ 200 (apenas para referência interna)'),
  ('09e5240f-9c26-47ee-a54d-02934a36ebfd', 'Horário de Funcionamento', 'Atendemos de segunda a sexta, das 8h às 18h. Não atendemos sábado e domingo.');
```

---

## 🧪 COMO TESTAR?

### Teste 1: Health Check
```bash
# No navegador ou Postman
GET http://localhost:3000/health
```

**Resposta esperada:**
```json
{
  "ok": true,
  "service": "agent-service"
}
```

### Teste 2: Processar Mensagem (PowerShell)
```powershell
.\test_process.ps1
```

**Resposta esperada:**
```json
{
  "correlation_id": "test_001",
  "final_message": "Perfeito! Me diga seu nome completo para eu agendar.",
  "actions": [],
  "debug": {
    "extracted": {
      "intent_group": "scheduling",
      "intent": "schedule_new",
      "slots": {
        "time_window": "morning",
        "preferred_date_text": "amanhã"
      },
      "missing_fields": ["patient_name"],
      "confidence": 0.9
    },
    "decided": { ... },
    "kb_hits": 2,
    "latency_ms": 1523
  }
}
```

### Teste 3: Curl Direto
```bash
curl -X POST http://localhost:3000/process \
  -H "Content-Type: application/json" \
  -d '{
    "correlation_id": "test_002",
    "clinic_id": "09e5240f-9c26-47ee-a54d-02934a36ebfd",
    "from": "5566996194231",
    "message_text": "Quanto custa botox?"
  }'
```

**Resposta esperada (bloqueio de preço):**
```json
{
  "correlation_id": "test_002",
  "final_message": "Por aqui não informamos valores. Posso agendar uma avaliação — me diga seu nome e o melhor dia/horário 🙂",
  "actions": [{"type": "log"}]
}
```

---

## 📁 ESTRUTURA DO PROJETO

```
agent_service/
│
├── server.js              # Código principal (CORRIGIDO)
├── package.json           # Dependências do projeto
├── .env                   # Variáveis secretas (NÃO compartilhar)
├── .env.example           # Exemplo de configuração
├── .gitignore             # Arquivos ignorados pelo Git
├── test_process.ps1       # Script de teste (PowerShell)
└── README.md              # Este arquivo (documentação)
```

---

## 📖 CONCEITOS IMPORTANTES

### 1. API REST
**O que é:** Forma de comunicação entre sistemas via HTTP.
**Métodos:**
- `GET` → Buscar dados
- `POST` → Enviar dados
- `PUT` → Atualizar dados
- `DELETE` → Deletar dados

### 2. JSON (JavaScript Object Notation)
**O que é:** Formato de dados estruturados.
**Exemplo:**
```json
{
  "nome": "João",
  "idade": 30,
  "ativo": true
}
```

### 3. Environment Variables (.env)
**O que são:** Variáveis secretas que não vão pro Git.
**Por quê:** Proteger chaves de API e senhas.

### 4. Supabase
**O que é:** Banco de dados PostgreSQL na nuvem (tipo Firebase).
**Usado para:** Armazenar configurações, conhecimento e logs.

### 5. OpenAI Function Calling
**O que é:** Forma de fazer a IA retornar dados estruturados (JSON).
**Diferença:**
- **Sem Function Calling:** IA retorna texto livre
- **Com Function Calling:** IA retorna JSON que o código pode processar

### 6. RAG (Retrieval Augmented Generation)
**O que é:** Buscar informações relevantes antes de gerar resposta.
**Como funciona:**
1. Busca na base de conhecimento
2. Envia como contexto para a IA
3. IA usa esse contexto para responder melhor

### 7. Confidence Score
**O que é:** Nível de certeza da IA (0 a 1).
**Exemplo:**
- `0.95` → Muito confiante
- `0.50` → Incerto
- `0.20` → Não entendeu

### 8. Zod (Validação)
**O que é:** Biblioteca para validar dados.
**Por quê:** Garantir que dados recebidos estão corretos.

---

## 🐛 PROBLEMAS COMUNS

### Erro: "OPENAI_API_KEY não definido"
**Solução:** Criar arquivo `.env` e colocar a chave da OpenAI.

### Erro: "clinic_settings_not_found"
**Solução:** Inserir dados de teste no Supabase (ver Passo 5).

### Erro 400: "invalid_envelope"
**Solução:** Verificar se o JSON está correto (todos campos obrigatórios).

### Erro 500: "process_error"
**Solução:** Verificar logs no terminal para ver o erro exato.

---

## 📊 FLUXO DE DADOS (Diagrama)

```
┌─────────────┐
│  WhatsApp   │
│  (Paciente) │
└──────┬──────┘
       │
       │ Mensagem
       ↓
┌─────────────┐
│    N8n /    │
│   Worker    │
└──────┬──────┘
       │
       │ POST /process
       │ {correlation_id, clinic_id, from, message_text}
       ↓
┌─────────────────────────────────────┐
│        SERVER.JS (Este código)       │
│                                     │
│  1) Valida dados (Zod)              │
│  2) Busca regras (Supabase)         │
│  3) Busca KB (Supabase)             │
│  4) Extrai intenção (OpenAI)        │
│  5) Decide ação (OpenAI)            │
│  6) Valida backend                  │
│  7) Salva log (Supabase)            │
│  8) Retorna resposta                │
└──────┬──────────────────────────────┘
       │
       │ Response
       │ {correlation_id, final_message, actions}
       ↓
┌─────────────┐
│    N8n /    │
│   Worker    │
└──────┬──────┘
       │
       │ Enviar mensagem
       ↓
┌─────────────┐
│  WhatsApp   │
│  (Paciente) │
└─────────────┘
```

---

## 🎓 O QUE VOCÊ APRENDEU?

1. ✅ Como funciona uma API REST
2. ✅ Como usar OpenAI Function Calling
3. ✅ Como validar dados com Zod
4. ✅ Como buscar dados no Supabase
5. ✅ Como estruturar um agente de IA
6. ✅ Como fazer logging estruturado
7. ✅ Como lidar com erros
8. ✅ Como fazer testes com curl/PowerShell

---

## 🚀 PRÓXIMOS PASSOS

1. **Testar localmente** (`npm run dev`)
2. **Fazer deploy** (Railway, Render, etc)
3. **Integrar com N8n** (configurar webhook)
4. **Adicionar mais KB** (procedimentos, preços, etc)
5. **Melhorar RAG** (busca semântica com embeddings)
6. **Adicionar memória** (histórico de conversas)

---

## 💡 DICAS FINAIS

1. **Sempre leia os logs** - Eles mostram o que está acontecendo
2. **Use DEBUG=true** - Mostra informações extras na resposta
3. **Teste com curl/PowerShell** - Antes de integrar com N8n
4. **Guarde seus .env** - Mas NUNCA compartilhe
5. **Faça backup** - `git commit` frequentemente

---

## 📞 SUPORTE

Se tiver dúvidas:
1. Leia este README novamente (com calma)
2. Verifique os logs no terminal
3. Teste com `DEBUG=true`
4. Verifique se o `.env` está correto

---

**Feito com ❤️ para você aprender!**

---

## 📝 CHANGELOG (O que mudou)

### ✅ Correções Principais:
1. **openai.responses.create** → **openai.chat.completions.create**
2. **instructions** → **messages** (com role system/user)
3. **extraction.output** → **extraction.choices[0].message.tool_calls**
4. **tools format** → Adicionado wrapper "function"
5. **tool_choice** → Corrigido formato
6. Adicionado tratamento de erros melhorado
7. Adicionado logs estruturados
8. Adicionado defaults para clinic_settings

### 🎯 Resultado:
- ❌ Erro 500 → ✅ Funciona perfeitamente
- ❌ API inexistente → ✅ API correta da OpenAI
- ❌ Parsing errado → ✅ Parsing correto
