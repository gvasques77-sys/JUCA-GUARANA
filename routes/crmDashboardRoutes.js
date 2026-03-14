/**
 * CRM Dashboard API Routes — Fase 4 V2
 * 
 * Novos endpoints:
 * - GET /performance — métricas detalhadas de receita e desempenho por médico
 * - GET /doctors — lista de médicos (para filtros)
 * - POST /appointments/:id/cancel — cancelar agendamento manualmente
 * - GET /patients enriquecido com dados de agendamento e médico
 */

import { Router } from 'express';

export function createCrmApiRouter(supabase) {
  const router = Router();

  // Middleware: clinic_id obrigatório
  function requireClinicId(req, res, next) {
    const clinicId = req.query.clinic_id || req.headers['x-clinic-id'];
    if (!clinicId) {
      return res.status(400).json({ error: 'clinic_id obrigatório' });
    }
    req.clinicId = clinicId;
    next();
  }

  // ======================================================
  // 1. VISÃO GERAL — Métricas + Saúde do CRM
  // ======================================================
  router.get('/overview', requireClinicId, async (req, res) => {
    try {
      // Buscar health do CRM
      const { data: health } = await supabase
        .from('vw_crm_health')
        .select('*')
        .eq('clinic_id', req.clinicId)
        .single();

      // Buscar métricas de agendamentos (receita, cancelamentos, etc.)
      const { data: apptStats } = await supabase
        .rpc('fn_clinic_appointment_stats', { p_clinic_id: req.clinicId })
        .single();

      // Fallback se a RPC não existir
      let stats = apptStats;
      if (!stats) {
        const { data: rawStats } = await supabase
          .from('appointments')
          .select('status, price')
          .eq('clinic_id', req.clinicId);

        if (rawStats) {
          const total = rawStats.length;
          const cancelled = rawStats.filter(a => a.status === 'cancelled').length;
          const noShows = rawStats.filter(a => a.status === 'no_show').length;
          const completed = rawStats.filter(a => a.status === 'completed').length;
          const active = rawStats.filter(a => ['scheduled', 'confirmed', 'waiting'].includes(a.status)).length;
          const revenue = rawStats
            .filter(a => !['cancelled', 'no_show'].includes(a.status))
            .reduce((sum, a) => sum + Number(a.price || 0), 0);
          const revenueLost = rawStats
            .filter(a => ['cancelled', 'no_show'].includes(a.status))
            .reduce((sum, a) => sum + Number(a.price || 0), 0);

          stats = {
            total_appointments: total,
            active_appointments: active,
            completed_appointments: completed,
            cancelled_appointments: cancelled,
            no_show_appointments: noShows,
            revenue_effective: revenue,
            revenue_lost: revenueLost,
            cancellation_rate: total > 0 ? ((cancelled / total) * 100).toFixed(1) : '0',
            no_show_rate: total > 0 ? ((noShows / total) * 100).toFixed(1) : '0',
          };
        }
      }

      // Buscar total de pacientes
      const { count: totalPatients } = await supabase
        .from('patients')
        .select('id', { count: 'exact', head: true })
        .eq('clinic_id', req.clinicId);

      // Buscar total de médicos ativos
      const { count: totalDoctors } = await supabase
        .from('doctors')
        .select('id', { count: 'exact', head: true })
        .eq('clinic_id', req.clinicId)
        .eq('active', true);

      return res.json({
        ...(health || {}),
        ...(stats || {}),
        total_patients: totalPatients || 0,
        total_doctors: totalDoctors || 0,
      });
    } catch (err) {
      console.error('[CRM-API] /overview:', err.message);
      return res.status(500).json({ error: 'Erro interno' });
    }
  });

  // ======================================================
  // 2. FUNIL DE JORNADA
  // ======================================================
  router.get('/funnel', requireClinicId, async (req, res) => {
    try {
      const { data } = await supabase
        .from('vw_journey_funnel')
        .select('*')
        .eq('clinic_id', req.clinicId)
        .order('position', { ascending: true });
      return res.json(data || []);
    } catch (err) {
      console.error('[CRM-API] /funnel:', err.message);
      return res.json([]);
    }
  });

  // ======================================================
  // 3. PACIENTES — Enriquecido com dados de agendamento
  // ======================================================
  router.get('/patients', requireClinicId, async (req, res) => {
    try {
      const { stage, search, doctor_id, limit = '50', offset = '0' } = req.query;

      let query = supabase
        .from('vw_patient_crm_full')
        .select('*', { count: 'exact' })
        .eq('clinic_id', req.clinicId)
        .order('last_contact_at', { ascending: false, nullsFirst: false })
        .range(Number(offset), Number(offset) + Number(limit) - 1);

      if (stage && stage !== 'all') query = query.eq('current_stage', stage);
      if (search) query = query.or(`patient_name.ilike.%${search}%,phone.ilike.%${search}%`);

      const { data: patients, error, count } = await query;
      if (error) return res.json({ patients: [], total: 0 });

      // Enriquecer com dados de agendamentos (último médico, próximo agendamento, receita)
      const patientIds = (patients || []).map(p => p.patient_id);
      let enriched = patients || [];

      if (patientIds.length > 0) {
        // Buscar agendamentos por paciente
        const { data: appointments } = await supabase
          .from('appointments')
          .select('patient_id, doctor_id, appointment_date, start_time, status, price, doctors(name, specialty)')
          .eq('clinic_id', req.clinicId)
          .in('patient_id', patientIds)
          .order('appointment_date', { ascending: false });

        // Agrupar por paciente
        const apptByPatient = {};
        (appointments || []).forEach(a => {
          if (!apptByPatient[a.patient_id]) apptByPatient[a.patient_id] = [];
          apptByPatient[a.patient_id].push(a);
        });

        enriched = (patients || []).map(p => {
          const appts = apptByPatient[p.patient_id] || [];
          const lastAppt = appts[0] || null;
          const nextAppt = appts.find(a => ['scheduled', 'confirmed'].includes(a.status) && a.appointment_date >= new Date().toISOString().split('T')[0]);
          const revenue = appts
            .filter(a => !['cancelled', 'no_show'].includes(a.status))
            .reduce((sum, a) => sum + Number(a.price || 0), 0);
          const doctorIds = [...new Set(appts.map(a => a.doctor_id))];

          return {
            ...p,
            last_doctor_name: lastAppt?.doctors?.name || null,
            last_doctor_specialty: lastAppt?.doctors?.specialty || null,
            next_appointment_date: nextAppt?.appointment_date || null,
            next_appointment_time: nextAppt?.start_time || null,
            patient_revenue: revenue,
            doctor_ids: doctorIds,
            total_appointments_real: appts.length,
          };
        });

        // Filtro por médico (client-side após enriquecer)
        if (doctor_id && doctor_id !== 'all') {
          enriched = enriched.filter(p => p.doctor_ids.includes(doctor_id));
        }
      }

      return res.json({ patients: enriched, total: count || 0 });
    } catch (err) {
      console.error('[CRM-API] /patients:', err.message);
      return res.status(500).json({ error: 'Erro interno' });
    }
  });

  // ======================================================
  // 4. TIMELINE DO PACIENTE
  // ======================================================
  router.get('/patients/:patientId/timeline', requireClinicId, async (req, res) => {
    try {
      const { data } = await supabase
        .from('vw_patient_timeline')
        .select('*')
        .eq('clinic_id', req.clinicId)
        .eq('patient_id', req.params.patientId)
        .order('occurred_at', { ascending: false })
        .limit(50);
      return res.json(data || []);
    } catch (err) {
      console.error('[CRM-API] /timeline:', err.message);
      return res.json([]);
    }
  });

  // ======================================================
  // 5. TAREFAS
  // ======================================================
  router.get('/tasks', requireClinicId, async (req, res) => {
    try {
      const { status = 'pending', limit = '50' } = req.query;
      let query = supabase
        .from('crm_tasks')
        .select('id, clinic_id, patient_id, task_type, reason, due_at, status, retry_count, last_error, message_template, created_at, executed_at, patients!inner(name, phone)')
        .eq('clinic_id', req.clinicId)
        .order('due_at', { ascending: true })
        .limit(Number(limit));

      if (status !== 'all') query = query.eq('status', status);

      const { data, error } = await query;
      if (error) {
        const { data: fb } = await supabase.from('vw_pending_tasks').select('*').eq('clinic_id', req.clinicId).limit(Number(limit));
        return res.json(fb || []);
      }

      const normalized = (data || []).map(t => ({
        ...t,
        patient_name: t.patients?.name || 'Desconhecido',
        patient_phone: t.patients?.phone || '',
        patients: undefined,
      }));
      return res.json(normalized);
    } catch (err) {
      console.error('[CRM-API] /tasks:', err.message);
      return res.json([]);
    }
  });

  // ======================================================
  // 6. AGENDA DO DIA + PRÓXIMOS
  // ======================================================
  router.get('/agenda/today', requireClinicId, async (req, res) => {
    try {
      const { data: today } = await supabase.from('vw_agenda_hoje').select('*');
      const { data: upcoming } = await supabase.from('vw_proximos_agendamentos').select('*').limit(20);
      return res.json({ today: today || [], upcoming: upcoming || [] });
    } catch (err) {
      console.error('[CRM-API] /agenda:', err.message);
      return res.json({ today: [], upcoming: [] });
    }
  });

  // ======================================================
  // 7. CANCELAR AGENDAMENTO — POST /appointments/:id/cancel
  // ======================================================
  router.post('/appointments/:appointmentId/cancel', requireClinicId, async (req, res) => {
    try {
      const { appointmentId } = req.params;
      const { reason } = req.body || {};

      // Verificar se o agendamento existe e pertence à clínica
      const { data: appt, error: findErr } = await supabase
        .from('appointments')
        .select('id, status, patient_id')
        .eq('id', appointmentId)
        .eq('clinic_id', req.clinicId)
        .single();

      if (findErr || !appt) {
        return res.status(404).json({ error: 'Agendamento não encontrado' });
      }

      if (appt.status === 'cancelled') {
        return res.json({ success: true, message: 'Agendamento já estava cancelado' });
      }

      if (['completed', 'no_show'].includes(appt.status)) {
        return res.status(400).json({ error: 'Não é possível cancelar agendamento já finalizado' });
      }

      // Cancelar
      const { error: updateErr } = await supabase
        .from('appointments')
        .update({
          status: 'cancelled',
          cancellation_reason: reason || 'Cancelado via dashboard',
          cancelled_by: 'dashboard',
          updated_at: new Date().toISOString(),
        })
        .eq('id', appointmentId);

      if (updateErr) {
        console.error('[CRM-API] Erro ao cancelar:', updateErr.message);
        return res.status(500).json({ error: 'Erro ao cancelar agendamento' });
      }

      // Emitir evento CRM (fire-and-forget)
      try {
        const { emitEvent } = await import('../services/crmService.js');
        await emitEvent(supabase, req.clinicId, appt.patient_id, 'booking_canceled', {
          appointmentId,
          sourceSystem: 'dashboard',
          idempotencyQualifier: appointmentId,
          payload: { reason: reason || 'Cancelado via dashboard', cancelled_by: 'dashboard' },
        });
      } catch (crmErr) {
        console.warn('[CRM-API] Erro ao emitir evento CRM:', crmErr.message);
      }

      console.log(`[CRM-API] Agendamento ${appointmentId} cancelado via dashboard`);
      return res.json({ success: true, message: 'Agendamento cancelado com sucesso' });
    } catch (err) {
      console.error('[CRM-API] /cancel:', err.message);
      return res.status(500).json({ error: 'Erro interno' });
    }
  });

  // ======================================================
  // 8. PERFORMANCE — Receita e métricas por médico
  // ======================================================
  router.get('/analytics', requireClinicId, async (req, res) => {
    try {
      const { data: allAppts } = await supabase.from('appointments')
        .select('id, status, price, doctor_id, appointment_date, created_by')
        .eq('clinic_id', req.clinicId);
      const { data: doctors } = await supabase.from('doctors')
        .select('id, name, specialty').eq('clinic_id', req.clinicId).eq('active', true);
      const { count: totalPacientes } = await supabase.from('patients')
        .select('id', { count: 'exact', head: true }).eq('clinic_id', req.clinicId);

      var all = allAppts || [];
      var total = all.length;
      var ativos = all.filter(function(a){return ['scheduled','confirmed','waiting'].indexOf(a.status)>=0}).length;
      var concluidos = all.filter(function(a){return a.status==='completed'}).length;
      var cancelados = all.filter(function(a){return a.status==='cancelled'}).length;
      var noShows = all.filter(function(a){return a.status==='no_show'}).length;
      var receitaBruta = all.reduce(function(s,a){return s+Number(a.price||0)},0);
      var receitaEfetiva = all.filter(function(a){return ['cancelled','no_show'].indexOf(a.status)<0}).reduce(function(s,a){return s+Number(a.price||0)},0);
      var ticketMedio = total > 0 ? receitaBruta / total : 0;
      var taxaCancel = total > 0 ? (cancelados/total)*100 : 0;
      var taxaNoShow = total > 0 ? (noShows/total)*100 : 0;
      var taxaConversao = total > 0 ? ((total-cancelados-noShows)/total)*100 : 0;

      // Tendência semanal
      var now = new Date();
      var d7 = new Date(now.getTime()-7*86400000).toISOString().split('T')[0];
      var d14 = new Date(now.getTime()-14*86400000).toISOString().split('T')[0];
      var ult7 = all.filter(function(a){return a.appointment_date>=d7}).length;
      var ant7 = all.filter(function(a){return a.appointment_date>=d14 && a.appointment_date<d7}).length;
      var tendencia = ant7 > 0 ? ((ult7-ant7)/ant7)*100 : 0;

      // Ranking por médico
      var docMap = {};
      (doctors||[]).forEach(function(d){docMap[d.id]=d});
      var recMed = {}; var agMed = {};
      all.forEach(function(a){
        var did = a.doctor_id;
        if(!recMed[did]){recMed[did]=0;agMed[did]={t:0,c:0,n:0}}
        recMed[did] += Number(a.price||0);
        agMed[did].t++;
        if(a.status==='cancelled') agMed[did].c++;
        if(a.status==='no_show') agMed[did].n++;
      });
      var ranking_medicos = Object.keys(recMed).map(function(did){
        return {doctor_id:did, name:(docMap[did]||{}).name||'?', specialty:(docMap[did]||{}).specialty||'',
          receita:recMed[did], agendamentos:agMed[did].t, cancelamentos:agMed[did].c, no_shows:agMed[did].n};
      }).sort(function(a,b){return b.receita-a.receita});

      // Insights automáticos
      var insights = [];
      if(taxaCancel>20) insights.push({type:'weakness',text:'Taxa de cancelamento alta ('+taxaCancel.toFixed(0)+'%). Considere lembretes mais frequentes.'});
      else if(taxaCancel<10 && total>3) insights.push({type:'strength',text:'Taxa de cancelamento baixa ('+taxaCancel.toFixed(0)+'%). Bom engajamento.'});
      if(taxaNoShow>15) insights.push({type:'weakness',text:'Taxa de no-show preocupante ('+taxaNoShow.toFixed(0)+'%). Reforce confirma\u00e7\u00f5es 24h.'});
      else if(noShows===0 && total>3) insights.push({type:'strength',text:'Zero no-shows. Excelente!'});
      if(ticketMedio>300) insights.push({type:'strength',text:'Ticket m\u00e9dio alto (R$ '+ticketMedio.toFixed(0)+'). Boa rentabilidade.'});
      if(tendencia>20) insights.push({type:'strength',text:'Agendamentos crescendo '+tendencia.toFixed(0)+'% vs semana anterior.'});
      else if(tendencia<-20 && ant7>0) insights.push({type:'weakness',text:'Agendamentos ca\u00edram '+Math.abs(tendencia).toFixed(0)+'% vs semana anterior.'});
      if(total>0 && concluidos===0) insights.push({type:'neutral',text:'Nenhuma consulta marcada como conclu\u00edda. Atualize o status ap\u00f3s atendimento.'});
      if(ativos>5) insights.push({type:'strength',text:ativos+' agendamentos ativos na fila.'});
      if(receitaEfetiva>1000) insights.push({type:'strength',text:'Receita efetiva de R$ '+receitaEfetiva.toFixed(2)+' gerada pelo sistema.'});

      return res.json({
        resumo: {
          total_agendamentos:total, agendamentos_ativos:ativos, concluidos:concluidos,
          cancelados:cancelados, no_shows:noShows,
          receita_bruta:receitaBruta, receita_efetiva:receitaEfetiva,
          ticket_medio:Math.round(ticketMedio*100)/100,
          taxa_cancelamento:Math.round(taxaCancel*10)/10,
          taxa_no_show:Math.round(taxaNoShow*10)/10,
          taxa_conversao:Math.round(taxaConversao*10)/10,
          total_pacientes:totalPacientes||0,
          tendencia_semanal:Math.round(tendencia*10)/10,
        },
        ranking_medicos: ranking_medicos,
        insights: insights,
      });
    } catch(err) {
      console.error('[CRM-API] /analytics:', err.message);
      return res.status(500).json({error:err.message});
    }
  });

  // ======================================================
  // 9. LISTA DE MÉDICOS (para filtros)
  // ======================================================
  router.get('/doctors', requireClinicId, async (req, res) => {
    try {
      const { data } = await supabase
        .from('doctors')
        .select('id, name, specialty')
        .eq('clinic_id', req.clinicId)
        .eq('active', true)
        .order('name');
      return res.json(data || []);
    } catch (err) {
      console.error('[CRM-API] /doctors:', err.message);
      return res.json([]);
    }
  });

  // ======================================================
  // 10. STAGES (para filtros)
  // ======================================================
  router.get('/stages', requireClinicId, async (req, res) => {
    try {
      const { data } = await supabase
        .from('crm_journey_stages')
        .select('id, name, slug, position, color')
        .eq('clinic_id', req.clinicId)
        .eq('is_active', true)
        .order('position', { ascending: true });
      return res.json(data || []);
    } catch (err) {
      console.error('[CRM-API] /stages:', err.message);
      return res.json([]);
    }
  });

  // ======================================================
  // 11. RELATÓRIOS
  // ======================================================
  router.get('/reports/latest', requireClinicId, async (req, res) => {
    try {
      const { data } = await supabase
        .from('crm_reports')
        .select('*')
        .eq('clinic_id', req.clinicId)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();
      return res.json({ report: data || null });
    } catch (err) {
      return res.json({ report: null });
    }
  });

  router.get('/reports', requireClinicId, async (req, res) => {
    try {
      const { data } = await supabase
        .from('crm_reports')
        .select('id, clinic_id, report_type, period_start, period_end, created_at')
        .eq('clinic_id', req.clinicId)
        .order('created_at', { ascending: false })
        .limit(10);
      return res.json(data || []);
    } catch (err) {
      return res.json([]);
    }
  });

  router.post('/reports/generate', requireClinicId, async (req, res) => {
    try {
      const { generateReport } = await import('../services/reportService.js');
      const result = await generateReport(supabase, req.clinicId);
      if (!result.success) return res.status(422).json({ error: result.error });
      return res.json({ report: result.report });
    } catch (err) {
      console.error('[CRM-API] /reports/generate:', err.message);
      return res.status(500).json({ error: 'Erro ao gerar relatório' });
    }
  });

  return router;
}
