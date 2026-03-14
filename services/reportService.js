/**
 * Report Service — Relatório Inteligente CRM (Fase 4.5)
 * 
 * Agrega dados das views CRM, monta contexto estruturado e chama OpenAI
 * para gerar análise em português com insights acionáveis.
 * 
 * Relatórios são armazenados em crm_reports para cache e histórico.
 * 
 * REGRAS:
 * - NUNCA faz throw — retorna { success: false } em caso de erro
 * - Prefixo [REPORT] em todos os logs
 * - Funciona mesmo sem dados (gera relatório "inicial" informativo)
 */

import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || 'missing' });

/**
 * Gera um relatório inteligente para a clínica.
 * Agrega métricas, envia para OpenAI e salva em crm_reports.
 *
 * @param {object} supabase - Cliente Supabase
 * @param {string} clinicId - UUID da clínica
 * @returns {Promise<{success: boolean, report?: object, error?: string}>}
 */
export async function generateReport(supabase, clinicId) {
  try {
    console.log(`[REPORT] Gerando relatório para clinic_id: ${clinicId}`);

    // 1. Agregar métricas de todas as views CRM
    const metrics = await aggregateMetrics(supabase, clinicId);
    console.log(`[REPORT] Métricas agregadas:`, JSON.stringify(metrics, null, 2));

    // 2. Verificar se há dados mínimos
    const hasData = metrics.overview.total_patients_tracked > 0 || metrics.overview.total_events > 0;

    // 3. Gerar análise com OpenAI
    const analysis = await generateAnalysis(metrics, hasData);
    if (!analysis.success) {
      return { success: false, error: analysis.error };
    }

    // 4. Salvar relatório no banco
    const now = new Date();
    const periodEnd = now.toISOString().split('T')[0];
    const periodStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const { data: report, error: insertErr } = await supabase
      .from('crm_reports')
      .insert({
        clinic_id: clinicId,
        report_type: 'weekly',
        period_start: periodStart,
        period_end: periodEnd,
        metrics: metrics,
        analysis_text: analysis.text,
        generated_by: 'openai',
        model_used: analysis.model,
        tokens_used: analysis.tokensUsed,
        cost_estimated: analysis.costEstimated,
      })
      .select('*')
      .single();

    if (insertErr) {
      console.error(`[REPORT] Erro ao salvar relatório:`, insertErr.message);
      // Retornar o relatório mesmo sem salvar (melhor UX)
      return {
        success: true,
        report: {
          metrics,
          analysis_text: analysis.text,
          period_start: periodStart,
          period_end: periodEnd,
          created_at: now.toISOString(),
          saved: false,
        },
      };
    }

    console.log(`[REPORT] Relatório gerado e salvo (id: ${report.id})`);
    return { success: true, report };
  } catch (error) {
    console.error(`[REPORT] Erro em generateReport:`, error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Agrega métricas de todas as views e tabelas CRM.
 */
async function aggregateMetrics(supabase, clinicId) {
  const metrics = {
    overview: {},
    funnel: [],
    patientStats: {},
    taskStats: {},
    recentActivity: [],
  };

  try {
    // Overview (vw_crm_health)
    const { data: health } = await supabase
      .from('vw_crm_health')
      .select('*')
      .eq('clinic_id', clinicId)
      .single();
    metrics.overview = health || {
      total_events: 0,
      events_last_24h: 0,
      total_patients_tracked: 0,
      pending_tasks: 0,
      failed_tasks: 0,
    };
  } catch (e) {
    console.warn(`[REPORT] Erro ao buscar overview:`, e.message);
  }

  try {
    // Funil de jornada (vw_journey_funnel)
    const { data: funnel } = await supabase
      .from('vw_journey_funnel')
      .select('*')
      .eq('clinic_id', clinicId)
      .order('position', { ascending: true });
    metrics.funnel = funnel || [];
  } catch (e) {
    console.warn(`[REPORT] Erro ao buscar funil:`, e.message);
  }

  try {
    // Estatísticas de pacientes
    const { data: patients } = await supabase
      .from('patient_crm_projection')
      .select('lead_score, current_stage, total_appointments, total_no_shows, total_revenue')
      .eq('clinic_id', clinicId);

    if (patients && patients.length > 0) {
      const scores = patients.map(p => p.lead_score || 0);
      const appointments = patients.reduce((sum, p) => sum + (p.total_appointments || 0), 0);
      const noShows = patients.reduce((sum, p) => sum + (p.total_no_shows || 0), 0);
      const revenue = patients.reduce((sum, p) => sum + Number(p.total_revenue || 0), 0);

      metrics.patientStats = {
        total: patients.length,
        avgLeadScore: Math.round(scores.reduce((a, b) => a + b, 0) / scores.length),
        maxLeadScore: Math.max(...scores),
        minLeadScore: Math.min(...scores),
        totalAppointments: appointments,
        totalNoShows: noShows,
        noShowRate: appointments > 0 ? ((noShows / appointments) * 100).toFixed(1) + '%' : '0%',
        totalRevenue: revenue,
      };
    }
  } catch (e) {
    console.warn(`[REPORT] Erro ao buscar estatísticas de pacientes:`, e.message);
  }

  try {
    // Estatísticas de tarefas
    const { data: tasks } = await supabase
      .from('crm_tasks')
      .select('status, task_type')
      .eq('clinic_id', clinicId);

    if (tasks && tasks.length > 0) {
      const byStatus = {};
      const byType = {};
      for (const t of tasks) {
        byStatus[t.status] = (byStatus[t.status] || 0) + 1;
        byType[t.task_type] = (byType[t.task_type] || 0) + 1;
      }
      metrics.taskStats = { total: tasks.length, byStatus, byType };
    }
  } catch (e) {
    console.warn(`[REPORT] Erro ao buscar estatísticas de tarefas:`, e.message);
  }

  try {
    // Atividade recente (últimos 10 eventos)
    const { data: recent } = await supabase
      .from('crm_events')
      .select('event_type, occurred_at, source_system')
      .eq('clinic_id', clinicId)
      .order('occurred_at', { ascending: false })
      .limit(10);
    metrics.recentActivity = recent || [];
  } catch (e) {
    console.warn(`[REPORT] Erro ao buscar atividade recente:`, e.message);
  }

  return metrics;
}

/**
 * Gera análise textual com OpenAI baseada nas métricas agregadas.
 */
async function generateAnalysis(metrics, hasData) {
  try {
    const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

    let userPrompt;
    if (!hasData) {
      userPrompt = `O CRM da clínica acabou de ser ativado e ainda não possui dados de pacientes ou eventos registrados.

Gere um relatório inicial de boas-vindas que:
1. Explique que o sistema CRM está ativo e coletando dados automaticamente
2. Descreva o que será acompanhado (jornada do paciente, agendamentos, follow-ups, lead score)
3. Indique que nas próximas semanas, relatórios com insights reais serão gerados
4. Dê 2-3 dicas práticas para a clínica aproveitar o CRM desde o início

Formato: texto corrido em português BR, tom profissional mas acessível, com emojis moderados.
Máximo 300 palavras.`;
    } else {
      userPrompt = `Analise os seguintes dados do CRM de uma clínica médica e gere um relatório semanal inteligente.

## DADOS AGREGADOS:

### Visão Geral:
${JSON.stringify(metrics.overview, null, 2)}

### Funil de Jornada (pacientes por estágio):
${metrics.funnel.map(s => `- ${s.stage_name}: ${s.patient_count} pacientes`).join('\n')}

### Estatísticas de Pacientes:
${JSON.stringify(metrics.patientStats, null, 2)}

### Estatísticas de Tarefas:
${JSON.stringify(metrics.taskStats, null, 2)}

### Atividade Recente (últimos eventos):
${metrics.recentActivity.map(e => `- ${e.event_type} em ${e.occurred_at}`).join('\n')}

## INSTRUÇÕES:

Gere um relatório semanal que inclua:
1. **Resumo executivo** (2-3 frases sobre o estado geral da clínica)
2. **Métricas-chave** (pacientes ativos, taxa de conversão do funil, no-show rate, lead score médio)
3. **Insights** (3-5 observações acionáveis baseadas nos dados — ex: "X pacientes estão parados na fase de triagem há mais de 7 dias")
4. **Recomendações** (2-3 ações concretas que a clínica pode tomar)
5. **Alertas** (se houver tarefas com falha, no-shows altos, funil congestionado)

Formato: texto corrido em português BR, tom profissional mas acessível, use emojis com moderação (📊 📈 ⚠️ ✅ 💡).
Máximo 500 palavras. Seja direto e objetivo.`;
    }

    const response = await openai.chat.completions.create({
      model,
      messages: [
        {
          role: 'system',
          content: 'Você é um analista de dados de CRM para clínicas médicas. Gere relatórios claros, acionáveis e em português BR. Seja direto, objetivo e use dados concretos quando disponíveis.',
        },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 1000,
      temperature: 0.4,
    });

    const text = response.choices[0]?.message?.content || 'Não foi possível gerar o relatório.';
    const tokensUsed = (response.usage?.prompt_tokens || 0) + (response.usage?.completion_tokens || 0);

    // Calcular custo estimado
    const inputCost = ((response.usage?.prompt_tokens || 0) / 1_000_000) * 2.00;
    const outputCost = ((response.usage?.completion_tokens || 0) / 1_000_000) * 8.00;
    const costEstimated = parseFloat((inputCost + outputCost).toFixed(6));

    console.log(`[REPORT] Análise gerada: ${text.length} chars, ${tokensUsed} tokens, $${costEstimated}`);

    return {
      success: true,
      text,
      model,
      tokensUsed,
      costEstimated,
    };
  } catch (error) {
    console.error(`[REPORT] Erro ao gerar análise OpenAI:`, error.message);
    return { success: false, error: error.message };
  }
}
