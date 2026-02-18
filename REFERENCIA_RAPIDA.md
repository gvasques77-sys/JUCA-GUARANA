# ⚡ REFERÊNCIA RÁPIDA - Comandos e Exemplos

## 🚀 COMANDOS ESSENCIAIS

### Instalar Dependências
```bash
npm install
```

### Iniciar Servidor (Desenvolvimento)
```bash
npm run dev
```

### Iniciar Servidor (Produção)
```bash
npm start
```

### Testar Health Check
```bash
curl http://localhost:3000/health
```

---

## 📁 ESTRUTURA DE ARQUIVOS

```
agent_service/
├── server.js              ← Código principal
├── package.json           ← Dependências
├── .env                   ← Variáveis secretas (NÃO COMPARTILHAR)
├── .env.example           ← Exemplo de .env
├── .gitignore             ← Arquivos ignorados pelo Git
├── test_process.ps1       ← Script de teste
├── README.md              ← Documentação completa
├── ANTES_vs_DEPOIS.md     ← Comparação das correções
└── CHECKLIST.md           ← Lista de verificação
```

---

## 🔑 VARIÁVEIS DE AMBIENTE (.env)

```env
# Porta do servidor
PORT=3000

# OpenAI (https://platform.openai.com/api-keys)
OPENAI_API_KEY=sk-proj-...
OPENAI_MODEL=gpt-4o-mini

# Supabase (https://app.supabase.com → Settings → API)
SUPABASE_URL=https://...supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbG...

# Configurações do agente
AGENT_MAX_STEPS=2
AGENT_TIMEOUT_MS=12000
DEBUG=true
```

---

## 📊 TABELAS DO SUPABASE

### clinic_settings
Configurações de cada clínica.
```sql
clinic_id            UUID (PK)
allow_prices         BOOLEAN
timezone             TEXT
business_hours       JSONB
policies_text        TEXT
created_at           TIMESTAMP
```

### clinic_kb
Base de conhecimento (RAG).
```sql
id                   UUID (PK)
clinic_id            UUID (FK)
title                TEXT
content              TEXT
created_at           TIMESTAMP
```

### agent_logs
Logs de cada interação.
```sql
id                   UUID (PK)
clinic_id            UUID
correlation_id       TEXT
intent_group         TEXT
intent               TEXT
confidence           NUMERIC
decision_type        TEXT
latency_ms           INTEGER
created_at           TIMESTAMP
```

---

## 🧪 EXEMPLOS DE TESTE

### Teste 1: Marcar Consulta
```bash
curl -X POST http://localhost:3000/process \
  -H "Content-Type: application/json" \
  -d '{
    "correlation_id": "test_001",
    "clinic_id": "09e5240f-9c26-47ee-a54d-02934a36ebfd",
    "from": "5566996194231",
    "message_text": "Quero marcar consulta amanhã de manhã"
  }'
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
      "confidence": 0.92
    }
  }
}
```

### Teste 2: Perguntar Preço (Bloqueado)
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

**Resposta esperada:**
```json
{
  "correlation_id": "test_002",
  "final_message": "Por aqui não informamos valores. Posso agendar uma avaliação — me diga seu nome e o melhor dia/horário 🙂",
  "actions": [{"type": "log"}]
}
```

### Teste 3: Mensagem Confusa
```bash
curl -X POST http://localhost:3000/process \
  -H "Content-Type: application/json" \
  -d '{
    "correlation_id": "test_003",
    "clinic_id": "09e5240f-9c26-47ee-a54d-02934a36ebfd",
    "from": "5566996194231",
    "message_text": "asdf qwerty xyz"
  }'
```

**Resposta esperada:**
```json
{
  "correlation_id": "test_003",
  "final_message": "Só para confirmar: você quer marcar, remarcar, cancelar ou tirar uma dúvida?",
  "actions": []
}
```

---

## 🔧 CORREÇÕES PRINCIPAIS

### ❌ ANTES (Errado)
```javascript
await openai.responses.create({
  model: 'gpt-5.2',
  instructions: '...',
  input: '...'
})
```

### ✅ DEPOIS (Correto)
```javascript
await openai.chat.completions.create({
  model: 'gpt-4o-mini',
  messages: [
    { role: 'system', content: '...' },
    { role: 'user', content: '...' }
  ]
})
```

---

## 📊 TIPOS DE INTENT_GROUP

```
scheduling    → Marcar, remarcar, cancelar consulta
procedures    → Perguntas sobre procedimentos
clinical      → Questões clínicas, sintomas
billing       → Preços, formas de pagamento
logistics     → Endereço, horários, contato
results       → Resultados de exames
other         → Outras perguntas
```

---

## 🎯 TIPOS DE DECISION_TYPE

```
ask_missing   → Falta informação, perguntar ao usuário
block_price   → Usuário pediu preço mas allow_prices=false
handoff       → Transferir para humano
proceed       → Continuar o fluxo
```

---

## 🔍 SLOTS PRINCIPAIS

### Comuns (scheduling)
```javascript
patient_name          // Nome do paciente
specialty_or_reason   // Especialidade ou motivo
preferred_date_text   // "amanhã", "sexta-feira"
preferred_time_text   // "10h", "tarde"
time_window           // morning, afternoon, evening
doctor_preference     // "Dr. João"
unit_preference       // "Clínica Centro"
```

### Procedimentos (procedures)
```javascript
procedure_name        // "botox", "preenchimento"
procedure_area        // "rosto", "lábios"
goal                  // "rejuvenescimento"
price_request         // true/false
```

### Clínica (clinical)
```javascript
symptom_summary       // "dor de cabeça forte"
duration              // "há 3 dias"
severity              // "moderada", "grave"
red_flags_present     // ["febre alta", "vômito"]
comorbidities         // "diabetes"
current_meds          // "losartana"
```

### Exames (results)
```javascript
test_type             // "hemograma", "glicose"
result_status         // "pronto", "pendente"
collection_date       // "ontem"
fasting_question      // true/false
abnormal_values       // "glicose 180"
```

---

## 🐛 ERROS COMUNS E SOLUÇÕES

### Erro: "OPENAI_API_KEY não definido"
**Solução:** Criar `.env` com a chave da OpenAI

### Erro: "clinic_settings_not_found"
**Solução:** Inserir dados de teste no Supabase

### Erro 400: "invalid_envelope"
**Causa:** Dados de entrada inválidos
**Solução:** Verificar se todos campos obrigatórios estão presentes

### Erro 500: "process_error"
**Causa:** Erro interno (OpenAI, Supabase, código)
**Solução:** Verificar logs no terminal

### Erro: "Insufficient funds"
**Causa:** Sem créditos na conta OpenAI
**Solução:** Adicionar créditos em https://platform.openai.com/account/billing

---

## 📝 SQL ÚTEIS

### Inserir Clínica de Teste
```sql
INSERT INTO clinic_settings (clinic_id, allow_prices, timezone)
VALUES (
  '09e5240f-9c26-47ee-a54d-02934a36ebfd',
  false,
  'America/Cuiaba'
);
```

### Inserir Base de Conhecimento
```sql
INSERT INTO clinic_kb (clinic_id, title, content)
VALUES (
  '09e5240f-9c26-47ee-a54d-02934a36ebfd',
  'Horário de Funcionamento',
  'Atendemos de segunda a sexta, das 8h às 18h.'
);
```

### Ver Logs Recentes
```sql
SELECT 
  created_at,
  correlation_id,
  intent_group,
  intent,
  confidence,
  decision_type,
  latency_ms
FROM agent_logs
ORDER BY created_at DESC
LIMIT 10;
```

### Limpar Logs
```sql
DELETE FROM agent_logs 
WHERE created_at < NOW() - INTERVAL '7 days';
```

---

## 🔐 SEGURANÇA

### ✅ FAZER:
- Usar `.gitignore` para proteger `.env`
- Usar `service_role_key` (não `anon_key`)
- Sempre validar dados de entrada (Zod)
- Usar HTTPS em produção
- Limitar rate limiting

### ❌ NÃO FAZER:
- Compartilhar arquivo `.env`
- Fazer commit do `.env` no Git
- Expor chaves de API no código
- Confiar 100% na IA (sempre validar no backend)
- Desabilitar validação de dados

---

## 📊 MÉTRICAS IMPORTANTES

### Latência
- **Ideal:** < 2000ms
- **Aceitável:** 2000-5000ms
- **Ruim:** > 5000ms

### Confidence
- **Alta:** > 0.8 (processar normalmente)
- **Média:** 0.6-0.8 (processar com cuidado)
- **Baixa:** < 0.6 (pedir clarificação)

### Taxa de Sucesso
- **Meta:** > 95%
- **Alerta:** < 90%

---

## 🎓 RECURSOS EXTERNOS

### Documentação
- OpenAI API: https://platform.openai.com/docs
- Supabase Docs: https://supabase.com/docs
- Express.js: https://expressjs.com
- Zod: https://zod.dev

### Ferramentas
- Postman: https://postman.com (testar APIs)
- Railway: https://railway.app (deploy fácil)
- Render: https://render.com (alternativa)

---

**📌 Salve este arquivo como referência rápida!**
