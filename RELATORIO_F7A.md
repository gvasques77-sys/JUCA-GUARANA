# Relatório de Alterações — Fase 7A: UX Polish do Dashboard CRM

**Branch:** `claude/crm-ux-polish-phase-7a-Rr8Of`
**Commit:** `ac69b71`
**Arquivos alterados:** 2

---

## Arquivo 1: `routes/crmDashboardRoutes.js`

### Alteração 1 — `GET /tasks` refatorado

**Antes:**
- Filtrava por `status` via query param (default: `'pending'`)
- Ordenava apenas por `due_at ASC`
- Limit padrão: 50

**Depois:**
- Retorna todas as tarefas da clínica sem filtro de status
- Ordena em JS com prioridade: `pending (0) → failed (1) → resto (2)`, dentro de cada grupo por `due_at DESC`
- Limit padrão: 200
- Mantém fallback para `vw_pending_tasks` em caso de erro do Supabase

### Alteração 2 — `PATCH /tasks/:taskId/status` (novo endpoint)

```
PATCH /crm/api/tasks/:id/status
Body: { status: 'executed' | 'cancelled' }
```

- Valida que o status é `executed` ou `cancelled` (retorna 400 se inválido)
- Verifica ownership: `clinic_id = req.clinicId` (retorna 404 se não encontrada)
- Se `status = 'executed'`: seta `executed_at = NOW()`
- Retorna `{ success: true, task: <tarefa atualizada> }`

---

## Arquivo 2: `public/crm/index.html`

### Alteração 3 — `TASK_TYPE_LABELS` expandido

Novos tipos de tarefa adicionados ao mapa de tradução:

| Chave | Label PT-BR |
|-------|-------------|
| `follow_up_24h` | Lembrete 24h |
| `follow_up_48h` | Lembrete 48h |
| `follow_up_post_consultation` | Pós-consulta |
| `follow_up_no_show` | Não compareceu |
| `follow_up_reactivation` | Reativação |
| `booking_reminder` | Lembrete de consulta |

Os tipos anteriores (`reminder_24h`, `booking_confirmation`, etc.) foram mantidos para retrocompatibilidade.

### Alteração 4 — `taskStC` e `taskStL` atualizados

Novos status adicionados:
- `executed` → verde `#10B981` → "Executada"
- `skipped` → cinza `#94A3B8` → "Ignorada"

Ajustes:
- `pending` mudou de azul `#3B82F6` para âmbar `#F59E0B`
- `manual_completed` simplificado para "Concluída"

### Alteração 5 — Novas funções helper

```js
humanizeSrc(s)    // Mapeia source_system para texto amigável
fmtKey(k)         // Mapeia chaves de payload para PT-BR
fmtPayload(et, p) // Converte payload JSON em texto legível por tipo de evento
UUID_RE           // Regex para filtrar UUIDs do fallback genérico
```

**`humanizeSrc` — mapa:**

| Valor bruto | Exibição |
|-------------|----------|
| `backfill`, `backfill_f6`, `system`, `crm_service` | via sistema |
| `whatsapp` | via WhatsApp |
| `dashboard` | via painel |
| qualquer outro | via sistema |

**`fmtPayload` — por tipo de evento:**

| Evento | Texto gerado |
|--------|-------------|
| `first_contact` | Paciente: X \| Telefone: Y |
| `booking_created` | Consulta em DD/MM/YYYY \| Valor: R$ X |
| `booking_canceled` | Motivo: X \| Por: Y |
| `booking_confirmed` | Consulta confirmada |
| `appointment_completed` | Consulta realizada |
| `no_show` | Paciente não compareceu |
| `conversation_ended` | Conversa encerrada |
| outros | chave: valor \| chave: valor (UUIDs e campos internos filtrados) |

### Alteração 6 — T4 (Aba Tarefas) reescrita completa

**Antes:** Cards verticais com dropdown de filtro por status, botões usando `PUT /tasks/:id/complete` e `PUT /tasks/:id/cancel`.

**Depois:**
- Carrega todas as tarefas de uma vez (`/tasks?limit=200`)
- Tabs de filtro: Todas (N) / Pendentes (N) / Executadas (N) / Canceladas (N)
  - "Pendentes" inclui `pending + executing + failed`
  - "Executadas" inclui `executed + manual_completed + completed`
- Tabela com colunas: Paciente | Tipo | Motivo | Data Prevista | Status | Ações
- Paciente clicável (abre ficha completa)
- Ações por linha:
  - ✅ Concluir → `PATCH /tasks/:id/status { status: 'executed' }` (só pending/executing)
  - ❌ Cancelar → `PATCH /tasks/:id/status { status: 'cancelled' }` com confirm() (só pending/executing)
  - 📞 Ligar → link `tel:+{phone}` (sempre visível se houver telefone)
- Data atrasada destacada em vermelho com ⚠

### Alteração 7 — PatientModal: Tab Timeline CRM corrigida

**Antes:** Payload exibido como `JSON.stringify(e.payload)` em bloco monoespaçado. Source system exibido como `'via '+e.source_system`.

**Depois:**
- `fmtPayload(e.event_type, e.payload)` → texto legível
- `humanizeSrc(e.source_system)` → texto amigável
- Se payload não gerar texto (ex: só UUIDs), linha não é renderizada

### Alteração 8 — T3 (Timeline standalone) corrigida

Mesmas correções da Alteração 7: `fmtPayload` e `humanizeSrc` aplicados.

### Alteração 9 — T6 (Relatório): linha de custo removida

Linha removida completamente:
```
Modelo: gpt-4o-mini | Tokens: 1393 | Custo: $0.006212
```

### Alteração 10 — Limpeza de comentários internos

- Removido comentário que expunha nome da tabela `clinic_users` no HTML servido ao cliente
- Removido `console.error` que logava payload interno de `/me` no browser do usuário

### Alteração 11 — Versão

`v3.0 F5` → `v3.1`

---

## Estado atual dos endpoints de tarefas

| Método | Rota | Função |
|--------|------|--------|
| `GET` | `/crm/api/tasks` | Lista todas as tarefas (todas as clínicas, ordenadas) |
| `GET` | `/crm/api/tasks/summary` | Contagem por status (para badge do menu) |
| `PUT` | `/crm/api/tasks/:id/complete` | Marca como `manual_completed` (endpoint legado, mantido) |
| `PUT` | `/crm/api/tasks/:id/cancel` | Cancela tarefa (endpoint legado, mantido) |
| `PATCH` | `/crm/api/tasks/:id/status` | **NOVO** — Atualiza para `executed` ou `cancelled` |

---

## Arquivos NÃO alterados (conforme instrução)

- `server.js`
- `services/crmService.js`
- `services/taskProcessor.js`
- `middleware/authMiddleware.js`
- Qualquer arquivo de workflow ou migração de banco
