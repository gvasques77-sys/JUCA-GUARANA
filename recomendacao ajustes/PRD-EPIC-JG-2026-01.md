# PRD — EPIC-JG-2026-01 (JUCA GUARANA)
## Estabilização, Segurança e Multi-tenant para Produção

### Objetivo
Corrigir erros de compilação, corrigir fluxo LLM do /process, remover segredos versionados, hardening de endpoints internos e admin, habilitar RLS no Supabase e garantir isolamento por clinic_id. Preparar CI mínimo (syntax + smoke tests + contrato).

### Ordem obrigatória
JG-P0-001 → JG-P0-002 → JG-P0-003 → JG-P0-004 → JG-P0-006 → JG-P1-005 → JG-P1-007 → JG-P2-008

---

## Tickets

### JG-P0-001 — Compilação server.js
**Evidência:** `node --check server.js` falha com `Unexpected identifier 'html'`.
**Ações:** remover markdown inválido no JS; corrigir template string do HTML do GET /process; corrigir string/aspas inválidas no bloco `block_price`.
**Aceite:** `node --check` OK; `npm run dev` OK; `GET /health` 200.

### JG-P0-002 — Fluxo LLM /process
**Problema:** tool variável indefinida e parse incompleto.
**Ações:** substituir `extractionTool`; parse seguro `choices[0].message.tool_calls[0].function.arguments`; preencher `extracted`; fallback sem tool_call; `decided` sempre definido.
**Aceite:** `POST /process` 200 com `final_message`; sem TypeError/ReferenceError; logs gravam `intent_group/intent/decision_type`.

### JG-P0-003 — Rotação de segredos
**Problema:** `_env` versionado; chaves vazaram.
**Ações:** remover `_env` do repo e histórico; migrar para `.env` local; manter `.env.example`; atualizar Railway/n8n.
**Aceite:** zero segredos no repo e no histórico.

### JG-P0-004 — Hardening /process + admin
**Problema:** /process sem auth; admin com senha fallback insegura.
**Ações:** auth interna (token ou HMAC) no /process; remover senha default; melhorar sessão admin; 401/403 corretos.
**Aceite:** /process rejeita sem credencial; admin exige ADMIN_PASSWORD.

### JG-P0-006 — Supabase RLS
**Problema:** tabelas públicas sem RLS; risco de dados clínicos.
**Escopo:** appointments, patients, doctors, services, clinic_settings, clinic_kb, agent_logs, conversation_history e correlatas.
**Ações:** habilitar RLS; policies por clinic_id; revisar/remover SECURITY DEFINER indevido; validar Advisors.
**Aceite:** sem “RLS Disabled in Public”; sem “Sensitive Columns Exposed”; sem acesso cruzado.

### JG-P1-005 — Contrato n8n → backend
**Ações:** aceitar `context.previous_messages`; validar roles; alinhar `received_at(_iso)`; garantir histórico usado no prompt.
**Aceite:** payload valida sem perder contexto; logs mostram tamanho do histórico.

### JG-P1-007 — Multi-tenant no domínio de agendamento
**Ações:** clinic_id obrigatório; queries filtram por clinic_id; constraints/índices; admin sempre exige escopo.
**Aceite:** isolamento entre clínicas garantido.

### JG-P2-008 — Timeout real + CI
**Ações:** AbortController nas chamadas OpenAI; smoke tests /health e /process; teste contrato payload; pipeline CI (`node --check`, testes, lint).
**Aceite:** timeout retorna fallback controlado; CI bloqueia regressão.