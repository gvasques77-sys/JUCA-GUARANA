/**
 * CRM Dashboard API Routes — Fase 4
 * 
 * Endpoints que alimentam o Dashboard CRM React SPA.
 * Servidos em /crm/api/* pelo Express.
 * 
 * Cada endpoint consulta views do Supabase e retorna JSON.
 * Autenticação será adicionada na Fase 5 (multi-tenant).
 */

import { Router } from 'express';

/**
 * Cria o router de API do CRM Dashboard.
 * Recebe o cliente Supabase como dependência (injeção).
 * 
 * @param {object} supabase - Cliente Supabase
 * @returns {Router} Express Router
 */
export function createCrmApiRouter(supabase) {
  const router = Router();

  // ======================================================
  // MIDDLEWARE: Extrair clinic_id do query param
  // Na Fase 5, isso virá do token de autenticação
  // ======================================================
  function requireClinicId(req, res, next) {
    const clinicId = req.query.clinic_id || req.headers['x-clinic-id'];
    if (!clinicId) {
      return res.status(400).json({ error: 'clinic_id obrigatório (query param ou header x-clinic-id)' });
    }
    req.clinicId = clinicId;
    next();
  }

  // ======================================================
  // 1. VISÃO GERAL — Métricas + Saúde do CRM
  // Alimenta: Tela 1 (cards de métricas)
  // ======================================================
  router.get('/overview', requireClinicId, async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('vw_crm_health')
        .select('*')
        .eq('clinic_id', req.clinicId)
        .single();

      if (error) {
        console.error('[CRM-API] Erro em /overview:', error.message);
        return res.json({
          total_events: 0,
          events_last_24h: 0,
          total_patients_tracked: 0,
          pending_tasks: 0,
          failed_tasks: 0,
          patients_without_stage: 0,
          last_event_at: null,
        });
      }

      return res.json(data);
    } catch (err) {
      console.error('[CRM-API] Erro em /overview:', err.message);
      return res.status(500).json({ error: 'Erro interno' });
    }
  });

  // ======================================================
  // 2. FUNIL DE JORNADA — Contagem por estágio
  // Alimenta: Tela 1 (gráfico de funil)
  // ======================================================
  router.get('/funnel', requireClinicId, async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('vw_journey_funnel')
        .select('*')
        .eq('clinic_id', req.clinicId)
        .order('position', { ascending: true });

      if (error) {
        console.error('[CRM-API] Erro em /funnel:', error.message);
        return res.json([]);
      }

      return res.json(data || []);
    } catch (err) {
      console.error('[CRM-API] Erro em /funnel:', err.message);
      return res.status(500).json({ error: 'Erro interno' });
    }
  });

  // ======================================================
  // 3. PACIENTES CRM — Lista com filtros
  // Alimenta: Tela 2 (tabela de pacientes)
  // ======================================================
  router.get('/patients', requireClinicId, async (req, res) => {
    try {
      const { stage, search, limit = '50', offset = '0' } = req.query;

      let query = supabase
        .from('vw_patient_crm_full')
        .select('*', { count: 'exact' })
        .eq('clinic_id', req.clinicId)
        .order('last_contact_at', { ascending: false, nullsFirst: false })
        .range(Number(offset), Number(offset) + Number(limit) - 1);

      // Filtro por estágio
      if (stage && stage !== 'all') {
        query = query.eq('current_stage', stage);
      }

      // Filtro por busca (nome ou telefone)
      if (search) {
        query = query.or(`patient_name.ilike.%${search}%,phone.ilike.%${search}%`);
      }

      const { data, error, count } = await query;

      if (error) {
        console.error('[CRM-API] Erro em /patients:', error.message);
        return res.json({ patients: [], total: 0 });
      }

      return res.json({ patients: data || [], total: count || 0 });
    } catch (err) {
      console.error('[CRM-API] Erro em /patients:', err.message);
      return res.status(500).json({ error: 'Erro interno' });
    }
  });

  // ======================================================
  // 4. TIMELINE DO PACIENTE — Eventos de um paciente
  // Alimenta: Tela 3 (timeline cronológica)
  // ======================================================
  router.get('/patients/:patientId/timeline', requireClinicId, async (req, res) => {
    try {
      const { patientId } = req.params;
      const { limit = '50' } = req.query;

      const { data, error } = await supabase
        .from('vw_patient_timeline')
        .select('*')
        .eq('clinic_id', req.clinicId)
        .eq('patient_id', patientId)
        .order('occurred_at', { ascending: false })
        .limit(Number(limit));

      if (error) {
        console.error('[CRM-API] Erro em /timeline:', error.message);
        return res.json([]);
      }

      return res.json(data || []);
    } catch (err) {
      console.error('[CRM-API] Erro em /timeline:', err.message);
      return res.status(500).json({ error: 'Erro interno' });
    }
  });

  // ======================================================
  // 5. TAREFAS PENDENTES — Follow-ups para a equipe
  // Alimenta: Tela 4 (lista de tarefas)
  // ======================================================
  router.get('/tasks', requireClinicId, async (req, res) => {
    try {
      const { status = 'pending', limit = '50' } = req.query;

      let query = supabase
        .from('crm_tasks')
        .select(`
          id, clinic_id, patient_id, task_type, reason, due_at, status,
          retry_count, last_error, message_template, created_at, executed_at,
          patients!inner(name, phone)
        `)
        .eq('clinic_id', req.clinicId)
        .order('due_at', { ascending: true })
        .limit(Number(limit));

      if (status !== 'all') {
        query = query.eq('status', status);
      }

      const { data, error } = await query;

      if (error) {
        console.error('[CRM-API] Erro em /tasks:', error.message);
        // Fallback: tentar a view se o join falhar
        const { data: fallbackData } = await supabase
          .from('vw_pending_tasks')
          .select('*')
          .eq('clinic_id', req.clinicId)
          .order('due_at', { ascending: true })
          .limit(Number(limit));
        return res.json(fallbackData || []);
      }

      // Normalizar formato (flatten patient data)
      const normalized = (data || []).map(t => ({
        ...t,
        patient_name: t.patients?.name || 'Desconhecido',
        patient_phone: t.patients?.phone || '',
        patients: undefined, // remover objeto aninhado
      }));

      return res.json(normalized);
    } catch (err) {
      console.error('[CRM-API] Erro em /tasks:', err.message);
      return res.status(500).json({ error: 'Erro interno' });
    }
  });

  // ======================================================
  // 6. AGENDA DO DIA — Consultas de hoje + próximas
  // Alimenta: Tela 5 (agenda)
  // ======================================================
  router.get('/agenda/today', requireClinicId, async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('vw_agenda_hoje')
        .select('*');

      if (error) {
        console.error('[CRM-API] Erro em /agenda/today:', error.message);
        return res.json({ today: [], upcoming: [] });
      }

      // Buscar próximos agendamentos também
      const { data: upcoming } = await supabase
        .from('vw_proximos_agendamentos')
        .select('*')
        .limit(20);

      return res.json({
        today: data || [],
        upcoming: upcoming || [],
      });
    } catch (err) {
      console.error('[CRM-API] Erro em /agenda/today:', err.message);
      return res.status(500).json({ error: 'Erro interno' });
    }
  });

  // ======================================================
  // 7. RELATÓRIO INTELIGENTE — Gerar ou buscar último
  // Alimenta: Tela 6 (relatório LLM)
  // ======================================================
  
  // GET /reports/latest — Buscar último relatório gerado
  router.get('/reports/latest', requireClinicId, async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('crm_reports')
        .select('*')
        .eq('clinic_id', req.clinicId)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (error || !data) {
        return res.json({ report: null, message: 'Nenhum relatório gerado ainda' });
      }

      return res.json({ report: data });
    } catch (err) {
      console.error('[CRM-API] Erro em /reports/latest:', err.message);
      return res.status(500).json({ error: 'Erro interno' });
    }
  });

  // GET /reports — Listar relatórios históricos
  router.get('/reports', requireClinicId, async (req, res) => {
    try {
      const { limit = '10' } = req.query;

      const { data, error } = await supabase
        .from('crm_reports')
        .select('id, clinic_id, report_type, period_start, period_end, created_at')
        .eq('clinic_id', req.clinicId)
        .order('created_at', { ascending: false })
        .limit(Number(limit));

      if (error) {
        console.error('[CRM-API] Erro em /reports:', error.message);
        return res.json([]);
      }

      return res.json(data || []);
    } catch (err) {
      console.error('[CRM-API] Erro em /reports:', err.message);
      return res.status(500).json({ error: 'Erro interno' });
    }
  });

  // POST /reports/generate — Gerar novo relatório sob demanda
  // O generateReport é importado e chamado via controller
  router.post('/reports/generate', requireClinicId, async (req, res) => {
    try {
      // Importar dinamicamente para evitar circular dependency
      const { generateReport } = await import('./reportService.js');
      const result = await generateReport(supabase, req.clinicId);

      if (!result.success) {
        return res.status(422).json({ error: result.error || 'Erro ao gerar relatório' });
      }

      return res.json({ report: result.report });
    } catch (err) {
      console.error('[CRM-API] Erro em /reports/generate:', err.message);
      return res.status(500).json({ error: 'Erro ao gerar relatório' });
    }
  });

  // ======================================================
  // 8. JOURNEY STAGES — Lista de estágios (para filtros)
  // ======================================================
  router.get('/stages', requireClinicId, async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('crm_journey_stages')
        .select('id, name, slug, position, color')
        .eq('clinic_id', req.clinicId)
        .eq('is_active', true)
        .order('position', { ascending: true });

      if (error) {
        console.error('[CRM-API] Erro em /stages:', error.message);
        return res.json([]);
      }

      return res.json(data || []);
    } catch (err) {
      console.error('[CRM-API] Erro em /stages:', err.message);
      return res.status(500).json({ error: 'Erro interno' });
    }
  });

  return router;
}
