# Migrations — JUCA GUARANÁ

## Como usar
Estas migrations documentam o schema do banco Supabase (projeto `edamtnxcwuuydwwbimvz`).
Para aplicar em um novo ambiente, execute na ordem numérica via Supabase SQL Editor.

## Histórico

| Arquivo | Descrição | Aplicada em produção? |
|---------|-----------|----------------------|
| `001_f9b_tags.sql` | Tags de clínica e pacientes (F9B) | Sim |
| `002_f9d_campaigns.sql` | Campanhas WhatsApp multi-tenant (F9D) | Sim |
| `003_crm_segments_pending.sql` | Segmentos de audiência | **NÃO** — pendente |
| `004_codex_review_fixes.sql` | CASCADE FK + unique index WhatsApp config | **NÃO** — aplicar manualmente |

## Views existentes (não documentadas aqui)

As seguintes views existem no banco e são usadas pelo código:
- `vw_campaign_conversions` — conversões de campanhas
- `vw_patient_crm_full` — visão completa do paciente com dados CRM
- `vw_crm_health` — saúde geral do CRM
- `vw_journey_funnel` — funil de jornada do paciente
- `vw_pending_tasks` — tarefas pendentes (fallback)
- `vw_patient_timeline` — timeline do paciente
- `vw_agenda_hoje` — agenda do dia
- `vw_proximos_agendamentos` — próximos agendamentos

## RPCs existentes

- `fn_update_campaign_metrics(p_campaign_id UUID)` — atualiza contadores de campanha
- `fn_claim_pending_tasks(p_batch_size INT)` — lock atômico de tarefas pendentes

## Notas

- `fn_clinic_appointment_stats` **NÃO existe** — o código tem fallback manual
- `crm_segments` **NÃO existe** — o código tem try/catch graceful
