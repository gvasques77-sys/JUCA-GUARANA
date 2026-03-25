# RELATÓRIO DE AUDITORIA — JUCA GUARANÁ
**Data:** 2026-03-25 | **Repositório:** `gvasques77-sys/JUCA-GUARANA` | **Branch:** `main`

---

## FASE 1 — INVENTÁRIO DE COMMITS (últimos 7 dias)

| # | SHA (7) | Data | Autor | Mensagem | Arquivos |
|---|---------|------|-------|----------|---------|
| 1 | `96ced3c` | 22/03 | gvasques77 | Merge PR #7 — WhatsApp campaign multi-tenant | 5 arquivos |
| 2 | `d3f7662` | 22/03 | Claude | feat(F9D): multi-tenant WhatsApp + campaign system | 5 arquivos |
| 3 | `29f8bd7` | 19/03 | gvasques77 | Add notification system to CRM interface | `index.html` |
| 4 | `1279924` | 19/03 | gvasques77 | Implement notifications route | `crmDashboardRoutes.js` |
| 5 | `433b09e` | 19/03 | gvasques77 | **Delete mcp.js** | `mcp.js` deletado |
| 6 | `b596651` | 19/03 | gvasques77 | **Delete Procfile** | `Procfile` deletado |
| 7 | `19530c4` | 19/03 | gvasques77 | **Delete Dockerfile** | `Dockerfile` deletado |
| 8 | `c68790c` | 19/03 | gvasques77 | feat: implement remote MCP server | `mcp.js`, `Dockerfile`, `Procfile`, `package.json`, `server.js` |
| 9 | `994dfc9` | 19/03 | gvasques77 | Add tag management in index.html | `index.html` |
| 10 | `b84f819` | 19/03 | gvasques77 | Add CRUD ops for clinic/patient tags | `crmDashboardRoutes.js` |
| 11 | `99a77a4` | 19/03 | gvasques77 | Add churn alerts to patient overview | `index.html` |
| 12 | `d96f895` | 19/03 | gvasques77 | Add churn risk detection to analytics | `crmDashboardRoutes.js` |
| 13 | `7565355` | 18/03 | gvasques77 | DASHBOARD ATUALIZAÇAO | `index.html` (1385 linhas alteradas) |

---

## FASE 2 — VALIDAÇÃO DE INTEGRIDADE

### 2.1 — `package.json`

```json
"type": "module"            ← ESM habilitado em todo o projeto
"mcp-start": "node mcp.js"  ← SCRIPT ÓRFÃO — mcp.js foi deletado!
"@modelcontextprotocol/sdk" ← DEPENDÊNCIA ÓRFÃ — arquivo deletado
```

> **O projeto usa ESM (`import`/`export`) em TODOS os arquivos.** A informação de que o projeto usaria CommonJS está desatualizada — o `"type": "module"` já existia antes das alterações do técnico. Todos os arquivos novos estão consistentes com ESM. ✅

### 2.2 — `services/whatsappConfigHelper.js` (NOVO)

- Sintaxe: ✅ Válida
- Imports: ✅ Apenas `@supabase/supabase-js`
- Padrão multi-tenant: ✅ Filtra por `clinic_id` em todas as queries
- Cache com TTL de 5 min: ✅ Implementado
- Fallback para env vars: ✅ Implementado
- Cria seu próprio cliente Supabase com `SUPABASE_SERVICE_ROLE_KEY` — bypassa RLS ⚠️ (aceitável para serviço interno)

### 2.3 — `services/taskProcessor.js` (MODIFICADO)

- Sintaxe: ✅ Válida
- Refatoração correta: trocou credenciais hardcoded por `getClinicWhatsAppConfig(options.clinicId)` ✅
- Multi-tenant: ✅ Credenciais WhatsApp resolvidas por clínica
- Constante de status: `TASK_STATUS.CANCELED = 'canceled'` (uma L — verificar banco)

### 2.4 — `services/campaignService.js` (NOVO)

- Sintaxe: ✅ Válida
- Multi-tenant: ✅ Todas as queries filtradas por `clinic_id`
- Cria próprio cliente Supabase com service_role_key (bypassa RLS) ⚠️ — consistente com padrão do projeto
- 🚨 Referencia `vw_campaign_conversions` — **view cuja existência não foi confirmada no banco**
- 🚨 Referencia `crm_segments` — **tabela cuja existência não foi confirmada**
- 🚨 Chama `sb.rpc('fn_update_campaign_metrics', ...)` — **função cuja existência não foi confirmada**
- 🚨 `resolveSegmentPatients` consulta `patient_tags` filtrando por `tag_name`, mas a API de tags usa `tag_id` — **incompatibilidade de schema**

### 2.5 — `routes/campaignRoutes.js` (NOVO)

- Sintaxe: ✅ Válida
- Usa `req.clinicId` e `req.userId` — consistente com `authMiddleware` ✅
- Multi-tenant: ✅ `clinic_id` sempre vem do JWT, nunca do body do request
- Tratamento de erro: ✅ try/catch em todos os endpoints
- Não aceita `clinic_id` do body: ✅

### 2.6 — `routes/crmDashboardRoutes.js` (MODIFICADO: tags, churn, notificações, PATCH tasks)

- Sintaxe: ✅ Válida
- Usa `req.clinicId` consistentemente ✅

🚨 **INCONSISTÊNCIA DE STATUS DE TASK:**
- `PATCH /tasks/:id/status` aceita status `'executed'` ou `'cancelled'` (double-L)
- `PUT /tasks/:id/cancel` usa `status: 'cancelled'` (double-L)
- Mas `TASK_STATUS.CANCELED = 'canceled'` (single-L) em `taskProcessor.js`
- Se a coluna `crm_tasks.status` tem CHECK constraint com `'canceled'` (single-L), o endpoint de cancel do dashboard vai falhar com violação de constraint

### 2.7 — `server.js` (MODIFICADO)

🚨 **BUG DE POSICIONAMENTO DE IMPORT (linha 232):**

```js
// ← linhas 1-19: todos os outros imports estão aqui (correto)
// ...
const supabase = createClient(...)  // linha 225 — declaração de runtime

// F9D adicionou este import APÓS declarações de const:
import { authMiddleware } from './middleware/authMiddleware.js';  // linha 232 ← PROBLEMÁTICO
app.use('/crm/api/campaigns', authMiddleware(supabase), campaignRoutes);
```

Em Node.js/ESM, `import` estático é hoisted pelo parser, portanto o servidor provavelmente inicia sem erro de sintaxe. Porém, é código **sintaticamente anômalo** — alguns ambientes ou versões específicas do Node.js podem rejeitar, e é uma bomba-relógio para manutenção.

**Estrutura de roteamento (correta):**
```
/crm/api/campaigns  → authMiddleware(supabase) + campaignRoutes  (linha 233)
/crm/api            → createCrmApiRouter(supabase)               (linha 236)
```
A ordem está correta: campaigns montado antes do router genérico de CRM.

---

## FASE 3 — VALIDAÇÃO DO BANCO DE DADOS

### 3.1 — Tabelas/Views/Funções novas referenciadas no código

| Objeto | Origem | Migração no repo? | Status |
|--------|--------|-------------------|--------|
| `clinic_whatsapp_config` | F9D | ❌ Sem pasta `migrations/` | **DESCONHECIDA** |
| `crm_campaigns` | F9D | ❌ | **DESCONHECIDA** |
| `crm_campaign_messages` | F9D | ❌ | **DESCONHECIDA** |
| `clinic_tags` | F9B (tags) | ❌ | **DESCONHECIDA** |
| `patient_tags` | F9B (tags) | ❌ | **DESCONHECIDA** |
| `vw_campaign_conversions` | F9D | ❌ | **DESCONHECIDA** |
| `crm_segments` | F9D | ❌ | **DESCONHECIDA** |
| `fn_update_campaign_metrics` | F9D | ❌ | **DESCONHECIDA** |
| `fn_claim_pending_tasks` | existente | ❌ | Fallback existe se ausente |

> O commit F9D menciona "Supabase migrations" na mensagem, mas **não há nenhuma pasta `migrations/` no repositório**. As migrations podem ter sido aplicadas manualmente via Supabase Studio. Sem acesso direto ao Supabase, **não é possível confirmar se as tabelas foram criadas**.

### 3.2 — Inconsistências código ↔ banco identificadas

| Arquivo | Coluna usada no código | Coluna esperada no banco | Risco |
|---------|----------------------|--------------------------|-------|
| `campaignService.js:resolveSegmentPatients` | `patient_tags.tag_name` | `patient_tags.tag_id` (FK) | 🚨 Segmentação por tags retorna 0 ou erro |
| `crmDashboardRoutes.js` (cancel task) | `crm_tasks.status = 'cancelled'` | Provavelmente `'canceled'` | ⚠️ Violação de CHECK constraint |
| `crmDashboardRoutes.js` (PATCH status) | `crm_tasks.status = 'executed'` | Status não definido no processor | ⚠️ Violação de CHECK constraint |

---

## FASE 4 — VALIDAÇÃO DO DEPLOY (RAILWAY)

Acesso direto ao Railway não disponível. Análise estática indica:

**Variáveis de ambiente — sem novas obrigações após F9D:**
As credenciais WhatsApp por clínica são armazenadas no banco (`clinic_whatsapp_config`) com fallback para as variáveis existentes:
- `META_WA_TOKEN` / `META_PHONE_NUMBER_ID` — fallback já existente ✅
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY` — não alteradas ✅

**Risco de falha no startup:**
- O `import` anômalo na linha 232 do `server.js` pode ou não causar erro dependendo da versão exata do Node.js no Railway. **Se o deploy atual está em pé, este risco foi superado.**
- Se as tabelas F9D não foram criadas no Supabase, o `startCampaignScheduler()` falha em silêncio (tem try/catch). O servidor não cai, mas campanhas não funcionam.

---

## FASE 5 — WORKFLOWS N8N

Acesso direto ao n8n não disponível. Com base na análise de código:

| Alteração | Impacto nos Workflows |
|-----------|----------------------|
| Refactor de `taskProcessor.js` para usar `whatsappConfigHelper` | Nenhum — processo interno |
| Novo endpoint `POST /crm/api/campaigns/:id/send` | Nenhum — é novo, não usado pelos workflows ainda |
| Estrutura do payload webhook principal (`/api/v1/webhook/*`) | Não foi alterada ✅ |
| `PATCH /tasks/:id/status` (novo F7A) | Compatível — endpoints PUT anteriores continuam existindo |

Não foram identificadas alterações em endpoints consumidos pelo agente WhatsApp (webhook principal, agendamento, confirmação).

---

## FASE 6 — TESTE FUNCIONAL (análise estática)

| Endpoint | Status | Observação |
|----------|--------|------------|
| `POST /api/auth/login` | ✅ Não alterado | Deve funcionar |
| `GET /crm/api/overview` | ✅ Não alterado | Dashboard principal OK |
| `GET /crm/api/analytics` | ⚠️ Alterado | Agora inclui `weekly_timeline` e `churn_alerts`; `phone` exposto para staff |
| `GET /crm/api/campaigns` | 🚨 Depende do banco | Falha se `crm_campaigns` não existir |
| `GET /crm/api/tags` | 🚨 Depende do banco | Falha se `clinic_tags` não existir |
| `GET /crm/api/notifications` | ✅ Provavelmente OK | Usa `crm_events` (tabela existente) com fallback |

---

## FASE 7 — RELATÓRIO FINAL

---

### 1. RESUMO EXECUTIVO

O técnico realizou um conjunto grande de alterações manuais no período de 18 a 22 de março de 2026. A principal mudança foi a implementação de um sistema completo de campanhas WhatsApp multi-tenant (F9D), incluindo três arquivos novos e modificações no `server.js`. Adicionalmente, foram adicionadas funcionalidades de tags de pacientes, detecção de churn, notificações e refinamentos no painel de tarefas. O código dos novos módulos é tecnicamente coerente, mas existem problemas concretos: um `import` mal posicionado no `server.js`, um mismatch de schema entre o código de segmentação e a tabela de tags, inconsistências nos status de tasks, e ausência de migrations SQL no repositório. A maior incerteza é se as tabelas F9D foram de fato aplicadas no Supabase.

---

### 2. INVENTÁRIO DE ALTERAÇÕES

| Arquivo | Tipo | Resumo | Risco |
|---------|------|--------|-------|
| `services/whatsappConfigHelper.js` | CRIADO | Resolve credenciais WhatsApp por clínica (DB → env fallback) | Baixo |
| `services/campaignService.js` | CRIADO | Ciclo de vida completo de campanhas WhatsApp | Médio |
| `routes/campaignRoutes.js` | CRIADO | REST API para campanhas em `/crm/api/campaigns` | Médio |
| `services/taskProcessor.js` | MODIFICADO | Trocou credenciais hardcoded por `whatsappConfigHelper` | Baixo |
| `server.js` | MODIFICADO | Monta campaign routes + inicia scheduler | **Alto** |
| `routes/crmDashboardRoutes.js` | MODIFICADO | +tags CRUD, +churn_alerts, +notificações, +PATCH tasks | Médio |
| `public/crm/index.html` | MODIFICADO | UI: tags, churn alerts, notificações, dashboard refactor | Baixo |
| `package.json` | MODIFICADO | +mcp-start script (órfão), +@mcp/sdk (órfão) | Baixo |
| `mcp.js` | CRIADO e DELETADO | Tentativa de MCP server, descartada | Baixo |
| `Dockerfile` | CRIADO e DELETADO | Tentativa de containerização, descartada | Baixo |
| `Procfile` | CRIADO e DELETADO | Para Railway/Heroku, descartado | Baixo |

---

### 3. PROBLEMAS ENCONTRADOS

| # | Severidade | Arquivo | Problema |
|---|------------|---------|----------|
| P1 | 🚨 **ALTO** | `server.js:232` | `import` fora do topo do arquivo — sintaticamente anômalo em ESM |
| P2 | 🚨 **ALTO** | `campaignService.js` | `patient_tags.tag_name` não existe — segmentação por tags vai falhar |
| P3 | 🚨 **ALTO** | Geral | Tabelas F9D (`crm_campaigns`, `clinic_whatsapp_config`, etc.) sem migration no repo — existência no banco não confirmada |
| P4 | ⚠️ **MÉDIO** | `crmDashboardRoutes.js` | `status: 'cancelled'` (double-L) ≠ `'canceled'` (single-L) no processor |
| P5 | ⚠️ **MÉDIO** | `crmDashboardRoutes.js` | `status: 'executed'` não consta no TASK_STATUS — pode violar CHECK constraint |
| P6 | ⚠️ **MÉDIO** | `campaignService.js` | `vw_campaign_conversions` e `fn_update_campaign_metrics` podem não existir no banco |
| P7 | ⚠️ **MÉDIO** | `crmDashboardRoutes.js` | `churn_alerts` expõe campo `phone` sem filtrar por role (staff vê telefones) |
| P8 | ⚠️ **MÉDIO** | `package.json` | Script `mcp-start` aponta para `mcp.js` deletado |
| P9 | ℹ️ **BAIXO** | `package.json` | `@modelcontextprotocol/sdk` instalado mas sem uso (arquivo deletado) |
| P10 | ℹ️ **BAIXO** | `server.js` | `app.use(cors())` sem configuração de origins — permite todas as origens |

---

### 4. INCOMPATIBILIDADES BANCO ↔ CÓDIGO

| Código | Supõe | Risco |
|--------|-------|-------|
| `campaignService.js:resolveSegmentPatients` | `patient_tags` tem coluna `tag_name` | 🚨 API insere `tag_id`, não `tag_name` — campanha por segmento com tags retorna 0 pacientes ou erro |
| `crmDashboardRoutes.js` (cancel task) | `crm_tasks.status` aceita `'cancelled'` | ⚠️ taskProcessor usa `'canceled'` — se CHECK constraint usa single-L, a operação vai falhar |
| `crmDashboardRoutes.js` (PATCH status) | `crm_tasks.status` aceita `'executed'` | ⚠️ Não consta em nenhum lugar do schema existente |
| `campaignService.js` | `crm_campaigns`, `crm_campaign_messages`, `clinic_whatsapp_config` existem | 🚨 Sem migration no repo — estado do banco desconhecido |
| `campaignService.js:calculateConversionRate` | `vw_campaign_conversions` view existe | ⚠️ Se ausente, retorna `{rate:0}` silenciosamente (catch absorve o erro) |

---

### 5. STATUS DO SISTEMA

| Componente | Status | Observação |
|------------|--------|------------|
| **Servidor Node.js** | ⚠️ INCERTO | `import` anômalo na linha 232 pode causar erro em algumas versões do Node.js |
| **Auth / JWT** | ✅ OK | `authMiddleware` correto, `req.clinicId` consistente em todo o código |
| **Multi-tenancy** | ✅ OK | Todas as queries filtradas por `clinic_id` |
| **Agente WhatsApp (chatbot)** | ✅ Provavelmente OK | Código principal não foi alterado; taskProcessor tem fallback |
| **Sistema de Campanhas** | 🚨 INCERTO | Depende de tabelas não confirmadas no banco |
| **Tags de Pacientes** | 🚨 INCERTO | Tabelas `clinic_tags`/`patient_tags` não confirmadas |
| **Churn Alerts** | ⚠️ Parcial | Funciona se `vw_patient_crm_full` existe; expõe phones para staff |
| **Notificações** | ✅ Provavelmente OK | Usa `crm_events` (tabela existente) com fallback |
| **Migrations F9D no banco** | 🚨 NÃO RASTREÁVEL | Sem pasta `migrations/` no repositório |

---

### 6. RECOMENDAÇÕES (ordem de prioridade)

#### URGENTE

**1. Corrigir o `import` anômalo no `server.js`**
Mover `import { authMiddleware } from './middleware/authMiddleware.js'` para o bloco de imports no topo do arquivo (linhas 1-19). Não altera comportamento mas elimina risco de incompatibilidade futura com o runtime.

**2. Verificar migrations no Supabase**
Acessar o Supabase Studio e confirmar se as seguintes tabelas/objetos existem:
- `clinic_whatsapp_config`
- `crm_campaigns`
- `crm_campaign_messages`
- `clinic_tags`
- `patient_tags`
- `fn_update_campaign_metrics` (RPC/function)
- `vw_campaign_conversions` (view)

Se não existirem, o sistema de campanhas e tags está quebrado silenciosamente.

**3. Corrigir mismatch `tag_name` vs `tag_id` em `campaignService.js`**
Em `resolveSegmentPatients`, a query:
```js
await sb.from('patient_tags').select('patient_id').eq('clinic_id', clinicId).in('tag_name', filters.tags)
```
Deve usar `tag_id` como FK ou fazer join com `clinic_tags` para resolver nome → id.

#### ALTO

**4. Padronizar status de tasks**
Definir se o correto é `'canceled'` (single-L, taskProcessor) ou `'cancelled'` (double-L, dashboard) e alinhar os três lugares: `taskProcessor.js`, `crmDashboardRoutes.js`, e o CHECK constraint da tabela `crm_tasks`.
O mesmo vale para o status `'executed'` — ou adicioná-lo ao CHECK constraint do banco, ou substituir por `'manual_completed'` que já existe.

**5. Adicionar SQL de migrations ao repositório**
Criar pasta `migrations/` com os scripts SQL das tabelas F9D e F9B criadas manualmente. Garante rastreabilidade, reprodutibilidade e facilita onboarding futuro.

#### MÉDIO

**6. Remover dependência e script órfãos do `package.json`**
```json
// REMOVER:
"mcp-start": "node mcp.js"
"@modelcontextprotocol/sdk": "^1.27.1"
```

**7. Filtrar `phone` em `churn_alerts` para usuários não-owner**
Em `crmDashboardRoutes.js`, após construir `churn_alerts`, adicionar:
```js
if (req.userRole !== 'owner') {
  churn_alerts = churn_alerts.map(a => ({ ...a, phone: undefined }));
}
```

**8. Restringir CORS em produção**
Substituir `app.use(cors())` por `app.use(cors({ origin: process.env.ALLOWED_ORIGINS || '*' }))`.

#### BAIXO

**9. Confirmar e documentar RPCs e views no banco**
Verificar se `fn_update_campaign_metrics`, `fn_claim_pending_tasks` e `vw_campaign_conversions` existem e adicionar os scripts de criação ao repositório.

**10. Verificar logs de startup no Railway**
Confirmar no painel do Railway que o deploy atual está com exit code 0 e que o `import` anômalo não causou erro de parse na versão específica do Node.js instalada.

---

*Auditoria concluída — somente leitura, nenhum arquivo do projeto foi alterado.*
*Gerado por Claude Code em 2026-03-25.*
