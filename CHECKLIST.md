# ✅ CHECKLIST - Passo a Passo para Funcionar

Use este checklist para garantir que tudo está configurado corretamente.

---

## 📦 1. ARQUIVOS DO PROJETO

- [ ] Tenho o arquivo `server.js` (CORRIGIDO)
- [ ] Tenho o arquivo `package.json`
- [ ] Tenho o arquivo `.env.example`
- [ ] Tenho o arquivo `.gitignore`
- [ ] Tenho o arquivo `test_process.ps1`
- [ ] Tenho o arquivo `README.md`

---

## 🔧 2. INSTALAÇÃO

- [ ] Node.js instalado (versão 18+)
  ```bash
  node --version  # Deve mostrar v18.x.x ou superior
  ```

- [ ] Dependências instaladas
  ```bash
  npm install
  ```

- [ ] Sem erros na instalação

---

## 🔑 3. CREDENCIAIS (OPENAI)

- [ ] Criei conta na OpenAI (https://platform.openai.com)
- [ ] Adicionei créditos na conta (mínimo $5)
- [ ] Criei uma API Key (https://platform.openai.com/api-keys)
- [ ] A chave começa com `sk-proj-` ou `sk-`
- [ ] Copiei a chave (só aparece uma vez!)

---

## 🗄️ 4. CREDENCIAIS (SUPABASE)

- [ ] Criei projeto no Supabase (https://app.supabase.com)
- [ ] Projeto está ativo (não pausado)
- [ ] Copiei a **Project URL** (Settings → API)
- [ ] Copiei a **service_role key** (⚠️ NÃO a anon key)

---

## 📝 5. ARQUIVO .ENV

- [ ] Copiei `.env.example` para `.env`
  ```bash
  cp .env.example .env
  ```

- [ ] Preenchi **OPENAI_API_KEY** no `.env`
- [ ] Preenchi **SUPABASE_URL** no `.env`
- [ ] Preenchi **SUPABASE_SERVICE_ROLE_KEY** no `.env`
- [ ] Salvei o arquivo `.env`

**Exemplo de .env preenchido:**
```env
PORT=3000
OPENAI_API_KEY=sk-proj-abc123xyz789...
OPENAI_MODEL=gpt-4o-mini
SUPABASE_URL=https://xyzabc123.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
AGENT_MAX_STEPS=2
AGENT_TIMEOUT_MS=12000
DEBUG=true
```

---

## 🗃️ 6. BANCO DE DADOS (SUPABASE)

- [ ] Abri o SQL Editor no Supabase
- [ ] Executei o SQL de criação de tabelas:
  ```sql
  CREATE TABLE clinic_settings ( ... );
  CREATE TABLE clinic_kb ( ... );
  CREATE TABLE agent_logs ( ... );
  ```
  (SQL completo está no README.md)

- [ ] Tabelas criadas com sucesso (3 tabelas)
- [ ] Inseri dados de teste (clinic_settings + clinic_kb)

**Verificar se deu certo:**
- [ ] Vai em: Table Editor → clinic_settings
- [ ] Deve aparecer 1 linha com o clinic_id de teste

---

## 🚀 7. INICIAR SERVIDOR

- [ ] Abri terminal no diretório do projeto
- [ ] Executei:
  ```bash
  npm run dev
  ```

- [ ] Apareceu mensagem:
  ```
  {"level":30,"time":...,"port":3000,"msg":"🚀 agent-service listening"}
  ```

- [ ] **NÃO** apareceu erros de API Key
- [ ] Servidor está rodando (não fechou)

---

## 🧪 8. TESTE 1: HEALTH CHECK

- [ ] Abri navegador
- [ ] Acessei: http://localhost:3000/health
- [ ] Apareceu:
  ```json
  {"ok":true,"service":"agent-service"}
  ```

---

## 🧪 9. TESTE 2: PROCESSAR MENSAGEM

### Opção A: PowerShell Script
- [ ] Abri PowerShell no diretório do projeto
- [ ] Executei:
  ```powershell
  .\test_process.ps1
  ```

- [ ] Apareceu "✅ SUCESSO!"
- [ ] Recebi uma resposta JSON válida
- [ ] Campo `final_message` contém uma resposta em português

### Opção B: Curl Manual
- [ ] Executei:
  ```bash
  curl -X POST http://localhost:3000/process \
    -H "Content-Type: application/json" \
    -d '{"correlation_id":"test_001","clinic_id":"09e5240f-9c26-47ee-a54d-02934a36ebfd","from":"5566996194231","message_text":"Oi, quero marcar consulta"}'
  ```

- [ ] Recebi resposta JSON (não erro 400/500)

---

## 🧪 10. TESTE 3: VERIFICAR LOGS

- [ ] Fui no Supabase → Table Editor → agent_logs
- [ ] Apareceu pelo menos 1 registro novo
- [ ] Registro contém:
  - `clinic_id` correto
  - `correlation_id` correto
  - `intent_group` (ex: "scheduling")
  - `confidence` (número entre 0 e 1)
  - `latency_ms` (tempo de resposta)

---

## 🎯 11. TESTE 4: CENÁRIOS DIFERENTES

### Teste 1: Marcar Consulta
- [ ] Mensagem: "Quero marcar consulta amanhã de manhã"
- [ ] Resposta pede nome ou mais informações
- [ ] `intent_group`: "scheduling"

### Teste 2: Perguntar Preço (deve bloquear)
- [ ] Mensagem: "Quanto custa botox?"
- [ ] Resposta: "Por aqui não informamos valores..."
- [ ] `decision_type`: "block_price"

### Teste 3: Mensagem Confusa (baixa confiança)
- [ ] Mensagem: "asdf qwerty"
- [ ] Resposta: "Só para confirmar: você quer marcar, remarcar ou cancelar?"
- [ ] Sistema pediu clarificação

---

## 🐛 12. TROUBLESHOOTING

Se algo não funcionar, verifique:

### Erro: "OPENAI_API_KEY não definido"
- [ ] Arquivo `.env` existe na raiz do projeto?
- [ ] `.env` contém `OPENAI_API_KEY=sk-proj-...`?
- [ ] Reiniciei o servidor depois de criar o `.env`?

### Erro: "clinic_settings_not_found"
- [ ] Executei o SQL de criação de tabelas?
- [ ] Inseri os dados de teste?
- [ ] O `clinic_id` no teste é o mesmo do banco?

### Erro 400: "invalid_envelope"
- [ ] O JSON está correto (sem vírgulas faltando)?
- [ ] Todos campos obrigatórios presentes?
  - `correlation_id` (mín 6 caracteres)
  - `clinic_id` (mín 1 caractere)
  - `from` (mín 5 caracteres)
  - `message_text` (mín 1 caractere)

### Erro 500: "process_error"
- [ ] Olhei os logs no terminal?
- [ ] A chave da OpenAI está correta?
- [ ] Tenho créditos na conta OpenAI?
- [ ] O Supabase está online?

---

## ✅ 13. SUCESSO!

Se todos os testes passaram:

- [x] ✅ Servidor funcionando
- [x] ✅ Health check OK
- [x] ✅ Processar mensagens OK
- [x] ✅ Logs salvando no Supabase
- [x] ✅ Bloqueio de preços funcionando
- [x] ✅ Confidence guard funcionando

**🎉 PARABÉNS! Tudo está funcionando!**

---

## 📊 14. PRÓXIMOS PASSOS

Agora que está funcionando localmente:

- [ ] Testar com mais cenários diferentes
- [ ] Adicionar mais itens na base de conhecimento (clinic_kb)
- [ ] Configurar deploy (Railway, Render, Heroku, etc)
- [ ] Integrar com N8n (configurar webhook)
- [ ] Testar com WhatsApp real

---

## 🆘 15. PRECISO DE AJUDA

Se algo não funcionar:

1. **Leia o README.md** (tem explicações detalhadas)
2. **Leia o ANTES_vs_DEPOIS.md** (mostra as correções)
3. **Verifique os logs** no terminal (mostram erros)
4. **Teste com DEBUG=true** no `.env` (mostra mais detalhes)
5. **Verifique este checklist** novamente (pode ter pulado algo)

---

## 📝 NOTAS IMPORTANTES

- ⚠️ **NUNCA** compartilhe seu arquivo `.env` (contém senhas)
- ⚠️ **NUNCA** faça commit do `.env` no Git
- ⚠️ Sempre use `.gitignore` para proteger arquivos secretos
- ✅ Faça backup do código com `git commit` frequentemente
- ✅ Teste localmente antes de fazer deploy
- ✅ Use `DEBUG=true` em desenvolvimento, `DEBUG=false` em produção

---

**✅ Use este checklist toda vez que configurar o projeto em um novo ambiente!**
