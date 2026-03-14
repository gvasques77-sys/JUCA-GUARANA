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
/**
 * Gera um relatório individual de um paciente específico.
 * Agrega dados do paciente e gera análise personalizada com OpenAI.
 *
 * @param {object} supabase - Cliente Supabase
 * @param {string} clinicId - UUID da clínica
 * @param {string} patientId - UUID do paciente
 * @returns {Promise<{success: boolean, report?: object, error?: string}>}
 */
export async function generatePatientReport(supabase, clinicId, patientId) {
  try {
    console.log(`[REPORT] Gerando relatório individual para paciente: ${patientId}`);

    // 1. Buscar dados do paciente
    const { data: patient } = await supabase
      .from('patients')
      .select('name, phone, created_at')
      .eq('id', patientId)
      .eq('clinic_id', clinicId)
      .single();

    if (!patient) {
      return { success: false, error: 'Paciente não encontrado' };
    }

    // 2. Buscar projeção CRM
    const { data: projection } = await supabase
      .from('patient_crm_projection')
      .select('*')
      .eq('patient_id', patientId)
      .eq('clinic_id', clinicId)
      .single();

    // 3. Buscar agendamentos
    const { data: appointments } = await supabase
      .from('appointments')
      .select('appointment_date, start_time, status, price, doctors(name, specialty)')
      .eq('patient_id', patientId)
      .eq('clinic_id', clinicId)
      .order('appointment_date', { ascending: false });

    // 4. Buscar eventos CRM
    const { data: events } = await supabase
      .from('crm_events')
      .select('event_type, occurred_at, source_system')
      .eq('patient_id', patientId)
      .eq('clinic_id', clinicId)
      .order('occurred_at', { ascending: false })
      .limit(30);

    // 5. Buscar perfil extra
    const { data: profileExtra } = await supabase
      .from('patient_profile_extra')
      .select('*')
      .eq('patient_id', patientId)
      .eq('clinic_id', clinicId)
      .single();

    // 6. Buscar tarefas
    const { data: tasks } = await supabase
      .from('crm_tasks')
      .select('task_type, status, due_at, reason')
      .eq('patient_id', patientId)
      .eq('clinic_id', clinicId);

    // 7. Montar contexto e chamar OpenAI
    const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    const appts = appointments || [];
    const completed = appts.filter(a => a.status === 'completed').length;
    const cancelled = appts.filter(a => a.status === 'cancelled').length;
    const noShows = appts.filter(a => a.status === 'no_show').length;
    const totalRevenue = appts
      .filter(a => !['cancelled', 'no_show'].includes(a.status))
      .reduce((sum, a) => sum + Number(a.price || 0), 0);

    const userPrompt = `Analise os seguintes dados de um paciente de uma clínica médica e gere um relatório individual.

## DADOS DO PACIENTE:

- **Nome:** ${patient.name}
- **Telefone:** ${patient.phone}
- **Cadastrado em:** ${patient.created_at}
- **Lead Score:** ${projection?.lead_score || 'N/A'}
- **Estágio Atual:** ${projection?.current_stage || 'N/A'}

### Agendamentos (${appts.length} total):
- Concluídos: ${completed}
- Cancelados: ${cancelled}
- No-shows: ${noShows}
- Receita gerada: R$ ${totalRevenue.toFixed(2)}
${appts.slice(0, 10).map(a => `- ${a.appointment_date} ${(a.start_time || '').substring(0, 5)} — ${a.status} — ${a.doctors?.name || '?'} (${a.doctors?.specialty || ''})`).join('\n')}

### Eventos CRM (últimos ${(events || []).length}):
${(events || []).slice(0, 15).map(e => `- ${e.event_type} em ${e.occurred_at} (via ${e.source_system})`).join('\n')}

### Tarefas (${(tasks || []).length} total):
${(tasks || []).map(t => `- ${t.task_type}: ${t.status} — ${t.reason || ''}`).join('\n')}

${profileExtra ? `### Perfil Extra:
- CPF: ${profileExtra.cpf || 'N/A'}
- Data Nasc.: ${profileExtra.birth_date || 'N/A'}
- Convênio: ${profileExtra.insurance_provider || 'N/A'}
- Origem: ${profileExtra.referral_source || 'N/A'}
- Preferência Horário: ${profileExtra.preferred_schedule || 'N/A'}
- Notas Internas: ${profileExtra.internal_notes || 'N/A'}
- Resumo Médico: ${profileExtra.medical_summary || 'N/A'}` : '### Perfil Extra: não preenchido'}

## INSTRUÇÕES:

Gere um relatório individual que inclua:
1. **Perfil resumido** (2-3 frases descrevendo o paciente)
2. **Histórico de atendimento** (frequência, tipos de consulta, padrões)
3. **Engajamento** (lead score, regularidade, no-shows)
4. **Alertas** (riscos de churn, no-shows recorrentes, tarefas pendentes)
5. **Recomendações** (2-3 ações específicas para este paciente)

Formato: texto corrido em português BR, tom profissional, use emojis com moderação.
Máximo 400 palavras.`;

    const response = await openai.chat.completions.create({
      model,
      messages: [
        {
          role: 'system',
          content: 'Você é um analista de CRM para clínicas médicas. Gere relatórios individuais de pacientes claros, acionáveis e em português BR.',
        },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 800,
      temperature: 0.4,
    });

    const text = response.choices[0]?.message?.content || 'Não foi possível gerar o relatório.';
    const tokensUsed = (response.usage?.prompt_tokens || 0) + (response.usage?.completion_tokens || 0);
    const inputCost = ((response.usage?.prompt_tokens || 0) / 1_000_000) * 2.00;
    const outputCost = ((response.usage?.completion_tokens || 0) / 1_000_000) * 8.00;
    const costEstimated = parseFloat((inputCost + outputCost).toFixed(6));

    // 8. Salvar em crm_reports
    const now = new Date();
    const { data: report, error: insertErr } = await supabase
      .from('crm_reports')
      .insert({
        clinic_id: clinicId,
        report_type: 'patient',
        period_start: patient.created_at ? patient.created_at.split('T')[0] : now.toISOString().split('T')[0],
        period_end: now.toISOString().split('T')[0],
        metrics: { patient_name: patient.name, lead_score: projection?.lead_score, total_appointments: appts.length },
        analysis_text: text,
        generated_by: 'openai',
        model_used: model,
        tokens_used: tokensUsed,
        cost_estimated: costEstimated,
        metadata: { scope: 'patient', patient_id: patientId },
      })
      .select('*')
      .single();

    if (insertErr) {
      console.error(`[REPORT] Erro ao salvar relatório do paciente:`, insertErr.message);
      return {
        success: true,
        report: { analysis_text: text, created_at: now.toISOString(), model_used: model, tokens_used: tokensUsed, saved: false },
      };
    }

    console.log(`[REPORT] Relatório individual gerado para ${patient.name} (id: ${report.id})`);
    return { success: true, report };
  } catch (error) {
    console.error(`[REPORT] Erro em generatePatientReport:`, error.message);
    return { success: false, error: error.message };
  }
}

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
