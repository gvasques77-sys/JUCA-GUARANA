/**
 * CRM Dashboard API Routes — Fase 5 + F7A
 *
 * Endpoints protegidos por authMiddleware (Supabase JWT).
 * clinic_id vem do JWT, não mais de query param.
 *
 * Novos endpoints F5:
 * - GET    /patients/:id          — Ficha completa do paciente
 * - GET    /patients/:id/profile  — Dados de patient_profile_extra
 * - PUT    /patients/:id/profile  — Upsert patient_profile_extra
 * - POST   /patients/:id/report   — Relatório individual do paciente
 * - PUT    /tasks/:id/complete    — Marca tarefa como concluída manualmente
 * - PUT    /tasks/:id/cancel      — Cancela tarefa
 * - GET    /tasks/summary         — Contagem por status (para badge)
 *
 * Melhorias F7A:
 * - GET    /tasks                 — Retorna com prioridade (pending/failed primeiro), limit 200
 * - PATCH  /tasks/:id/status      — Atualiza status da tarefa (executed/cancelled)
 *
 * Melhorias F9A:
 * - GET    /analytics             — Inclui weekly_timeline (últimas 8 semanas)
 *
 * Melhorias F9C:
 * - GET    /analytics             — Inclui churn_alerts (até 10 pacientes em risco)
 *
 * Melhorias F9B:
 * - GET    /tags                  — Listar tags da clínica
 * - POST   /tags                  — Criar tag
 * - GET    /patients/:id/tags     — Tags do paciente
 * - POST   /patients/:id/tags     — Adicionar tag ao paciente
 * - DELETE /patients/:id/tags/:tagId — Remover tag
 */

import { Router } from 'express';
import { authMiddleware, requireOwner } from '../middleware/authMiddleware.js';

export function createCrmApiRouter(supabase) {
  const router = Router();

  // Aplicar autenticação em TODAS as rotas
  const auth = authMiddleware(supabase);
  router.use(auth);

  // Endpoint para obter info do usuário logado (role, nome, clinic)
  router.get('/me', (req, res) => {
    return res.json({
      userId: req.userId,
      clinicId: req.clinicId,
      role: req.userRole,
      name: req.userName,
    });
  });

  // ======================================================
  // 1. VISÃO GERAL — Métricas + Saúde do CRM
  // ======================================================
  router.get('/overview', async (req, res) => {
    try {
      const { data: health } = await supabase
        .from('vw_crm_health')
        .select('*')
        .eq('clinic_id', req.clinicId)
        .single();

      const { data: apptStats } = await supabase
        .rpc('fn_clinic_appointment_stats', { p_clinic_id: req.clinicId })
        .single();

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

      const { count: totalPatients } = await supabase
        .from('patients')
        .select('id', { count: 'exact', head: true })
        .eq('clinic_id', req.clinicId);

      const { count: totalDoctors } = await supabase
        .from('doctors')
        .select('id', { count: 'exact', head: true })
        .eq('clinic_id', req.clinicId)
        .eq('active', true);

      // Para staff, ocultar dados de receita
      const result = {
        ...(health || {}),
        ...(stats || {}),
        total_patients: totalPatients || 0,
        total_doctors: totalDoctors || 0,
      };

      if (req.userRole !== 'owner') {
        delete result.revenue_effective;
        delete result.revenue_lost;
      }

      return res.json(result);
    } catch (err) {
      console.error('[CRM-API] /overview:', err.message);
      return res.status(500).json({ error: 'Erro interno' });
    }
  });

  // ======================================================
  // 2. FUNIL DE JORNADA
  // ======================================================
  router.get('/funnel', async (req, res) => {
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
  // 3. PACIENTES — Lista enriquecida
  // ======================================================
  router.get('/patients', async (req, res) => {
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

      const patientIds = (patients || []).map(p => p.patient_id);
      let enriched = patients || [];

      if (patientIds.length > 0) {
        const { data: appointments } = await supabase
          .from('appointments')
          .select('patient_id, doctor_id, appointment_date, start_time, status, price, doctors(name, specialty)')
          .eq('clinic_id', req.clinicId)
          .in('patient_id', patientIds)
          .order('appointment_date', { ascending: false });

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

          const row = {
            ...p,
            last_doctor_name: lastAppt?.doctors?.name || null,
            last_doctor_specialty: lastAppt?.doctors?.specialty || null,
            next_appointment_date: nextAppt?.appointment_date || null,
            next_appointment_time: nextAppt?.start_time || null,
            patient_revenue: req.userRole === 'owner' ? revenue : undefined,
            doctor_ids: doctorIds,
            total_appointments_real: appts.length,
          };
          return row;
        });

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
  router.get('/patients/:patientId/timeline', async (req, res) => {
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
  // 4B. FICHA COMPLETA DO PACIENTE (F5)
  // ======================================================
  router.get('/patients/:patientId', async (req, res) => {
    try {
      const { patientId } = req.params;

      // Dados básicos do paciente
      const { data: patient, error: pErr } = await supabase
        .from('patients')
        .select('*')
        .eq('id', patientId)
        .eq('clinic_id', req.clinicId)
        .single();

      if (pErr || !patient) {
        return res.status(404).json({ error: 'Paciente não encontrado' });
      }

      // Projeção CRM
      const { data: projection } = await supabase
        .from('patient_crm_projection')
        .select('*')
        .eq('patient_id', patientId)
        .eq('clinic_id', req.clinicId)
        .single();

      // Agendamentos
      const { data: appointments } = await supabase
        .from('appointments')
        .select('id, appointment_date, start_time, status, price, cancellation_reason, doctors(name, specialty), doctor_services(name)')
        .eq('patient_id', patientId)
        .eq('clinic_id', req.clinicId)
        .order('appointment_date', { ascending: false });

      // Eventos CRM
      const { data: events } = await supabase
        .from('crm_events')
        .select('id, event_type, occurred_at, source_system, payload')
        .eq('patient_id', patientId)
        .eq('clinic_id', req.clinicId)
        .order('occurred_at', { ascending: false })
        .limit(50);

      // Tarefas vinculadas
      const { data: tasks } = await supabase
        .from('crm_tasks')
        .select('id, task_type, reason, due_at, status, retry_count, executed_at, created_at')
        .eq('patient_id', patientId)
        .eq('clinic_id', req.clinicId)
        .order('due_at', { ascending: false });

      // Perfil extra
      const { data: profileExtra } = await supabase
        .from('patient_profile_extra')
        .select('*')
        .eq('patient_id', patientId)
        .eq('clinic_id', req.clinicId)
        .single();

      // Último relatório do paciente
      const { data: lastReport } = await supabase
        .from('crm_reports')
        .select('id, analysis_text, created_at, model_used, tokens_used')
        .eq('clinic_id', req.clinicId)
        .eq('report_type', 'patient')
        .filter('metadata->>patient_id', 'eq', patientId)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      const result = {
        patient,
        projection: projection || null,
        appointments: appointments || [],
        events: events || [],
        tasks: tasks || [],
        profileExtra: profileExtra || null,
        lastReport: lastReport || null,
      };

      // Ocultar preço para staff
      if (req.userRole !== 'owner' && result.appointments) {
        result.appointments = result.appointments.map(a => ({ ...a, price: undefined }));
      }

      return res.json(result);
    } catch (err) {
      console.error('[CRM-API] /patients/:id:', err.message);
      return res.status(500).json({ error: 'Erro interno' });
    }
  });

  // ======================================================
  // 4C. PERFIL EXTRA DO PACIENTE — GET (F5)
  // ======================================================
  router.get('/patients/:patientId/profile', async (req, res) => {
    try {
      const { data } = await supabase
        .from('patient_profile_extra')
        .select('*')
        .eq('patient_id', req.params.patientId)
        .eq('clinic_id', req.clinicId)
        .single();
      return res.json(data || {});
    } catch (err) {
      return res.json({});
    }
  });

  // ======================================================
  // 4D. PERFIL EXTRA DO PACIENTE — UPSERT (F5)
  // ======================================================
  router.put('/patients/:patientId/profile', async (req, res) => {
    try {
      const { patientId } = req.params;
      const allowedFields = [
        'cpf', 'birth_date', 'gender', 'email',
        'emergency_contact_name', 'emergency_contact_phone',
        'insurance_provider', 'insurance_number',
        'referral_source', 'referral_detail',
        'preferred_schedule', 'preferred_doctor_id',
        'internal_notes', 'medical_summary',
      ];

      // Filtrar apenas campos permitidos
      const profileData = {};
      for (const key of allowedFields) {
        if (req.body[key] !== undefined) {
          profileData[key] = req.body[key];
        }
      }

      // Verificar se paciente pertence à clínica
      const { data: patient } = await supabase
        .from('patients')
        .select('id')
        .eq('id', patientId)
        .eq('clinic_id', req.clinicId)
        .single();

      if (!patient) {
        return res.status(404).json({ error: 'Paciente não encontrado' });
      }

      // Upsert
      const { data, error } = await supabase
        .from('patient_profile_extra')
        .upsert({
          clinic_id: req.clinicId,
          patient_id: patientId,
          ...profileData,
          updated_at: new Date().toISOString(),
        }, {
          onConflict: 'clinic_id,patient_id',
        })
        .select('*')
        .single();

      if (error) {
        console.error('[CRM-API] Erro ao salvar perfil:', error.message);
        return res.status(500).json({ error: 'Erro ao salvar perfil' });
      }

      return res.json({ success: true, profile: data });
    } catch (err) {
      console.error('[CRM-API] PUT /patients/:id/profile:', err.message);
      return res.status(500).json({ error: 'Erro interno' });
    }
  });

  // ======================================================
  // 4E. RELATÓRIO INDIVIDUAL DO PACIENTE (F5)
  // ======================================================
  router.post('/patients/:patientId/report', async (req, res) => {
    try {
      const { generatePatientReport } = await import('../services/reportService.js');
      const result = await generatePatientReport(supabase, req.clinicId, req.params.patientId);
      if (!result.success) return res.status(422).json({ error: result.error });
      return res.json({ report: result.report });
    } catch (err) {
      console.error('[CRM-API] /patients/:id/report:', err.message);
      return res.status(500).json({ error: 'Erro ao gerar relatório do paciente' });
    }
  });

  // ======================================================
  // 5. TAREFAS
  // ======================================================
  router.get('/tasks', async (req, res) => {
    try {
      const { status = 'pending', limit = '200' } = req.query;

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

      // Priorizar pendentes e falhas no topo
      var statusOrder = { pending: 0, failed: 1 };
      var sorted = (data || []).sort(function(a, b) {
        var ao = statusOrder[a.status] !== undefined ? statusOrder[a.status] : 2;
        var bo = statusOrder[b.status] !== undefined ? statusOrder[b.status] : 2;
        if (ao !== bo) return ao - bo;
        return new Date(b.due_at) - new Date(a.due_at);
      });

      const normalized = sorted.map(t => ({
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
  // 5B. RESUMO DE TAREFAS — Contagem por status (F5)
  // ======================================================
  router.get('/tasks/summary', async (req, res) => {
    try {
      const { data: tasks } = await supabase
        .from('crm_tasks')
        .select('status')
        .eq('clinic_id', req.clinicId);

      const summary = { pending: 0, executing: 0, completed: 0, failed: 0, cancelled: 0, manual_completed: 0 };
      (tasks || []).forEach(t => {
        if (summary[t.status] !== undefined) summary[t.status]++;
      });

      // Contar atrasadas (pending com due_at no passado)
      const { count: overdue } = await supabase
        .from('crm_tasks')
        .select('id', { count: 'exact', head: true })
        .eq('clinic_id', req.clinicId)
        .eq('status', 'pending')
        .lt('due_at', new Date().toISOString());

      return res.json({ ...summary, overdue: overdue || 0 });
    } catch (err) {
      console.error('[CRM-API] /tasks/summary:', err.message);
      return res.json({ pending: 0, executing: 0, completed: 0, failed: 0, cancelled: 0, manual_completed: 0, overdue: 0 });
    }
  });

  // ======================================================
  // 5C. CONCLUIR TAREFA MANUALMENTE (F5)
  // ======================================================
  router.put('/tasks/:taskId/complete', async (req, res) => {
    try {
      const { taskId } = req.params;

      const { data: task, error: findErr } = await supabase
        .from('crm_tasks')
        .select('id, status, patient_id')
        .eq('id', taskId)
        .eq('clinic_id', req.clinicId)
        .single();

      if (findErr || !task) {
        return res.status(404).json({ error: 'Tarefa não encontrada' });
      }

      if (['completed', 'manual_completed', 'cancelled'].includes(task.status)) {
        return res.json({ success: true, message: 'Tarefa já finalizada' });
      }

      const { error: updateErr } = await supabase
        .from('crm_tasks')
        .update({
          status: 'manual_completed',
          executed_at: new Date().toISOString(),
        })
        .eq('id', taskId);

      if (updateErr) {
        console.error('[CRM-API] Erro ao concluir tarefa:', updateErr.message);
        return res.status(500).json({ error: 'Erro ao concluir tarefa' });
      }

      console.log(`[CRM-API] Tarefa ${taskId} concluída manualmente por ${req.userName}`);
      return res.json({ success: true, message: 'Tarefa concluída' });
    } catch (err) {
      console.error('[CRM-API] PUT /tasks/:id/complete:', err.message);
      return res.status(500).json({ error: 'Erro interno' });
    }
  });

  // ======================================================
  // 5D. CANCELAR TAREFA (F5)
  // ======================================================
  router.put('/tasks/:taskId/cancel', async (req, res) => {
    try {
      const { taskId } = req.params;
      const { reason } = req.body || {};

      const { data: task, error: findErr } = await supabase
        .from('crm_tasks')
        .select('id, status')
        .eq('id', taskId)
        .eq('clinic_id', req.clinicId)
        .single();

      if (findErr || !task) {
        return res.status(404).json({ error: 'Tarefa não encontrada' });
      }

      if (['completed', 'manual_completed', 'cancelled'].includes(task.status)) {
        return res.json({ success: true, message: 'Tarefa já finalizada' });
      }

      const { error: updateErr } = await supabase
        .from('crm_tasks')
        .update({
          status: 'cancelled',
          last_error: reason || 'Cancelada via dashboard',
          executed_at: new Date().toISOString(),
        })
        .eq('id', taskId);

      if (updateErr) {
        return res.status(500).json({ error: 'Erro ao cancelar tarefa' });
      }

      console.log(`[CRM-API] Tarefa ${taskId} cancelada por ${req.userName}`);
      return res.json({ success: true, message: 'Tarefa cancelada' });
    } catch (err) {
      console.error('[CRM-API] PUT /tasks/:id/cancel:', err.message);
      return res.status(500).json({ error: 'Erro interno' });
    }
  });

  // ======================================================
  // 5E. ATUALIZAR STATUS DA TAREFA (F7A)
  // ======================================================
  router.patch('/tasks/:taskId/status', async (req, res) => {
    try {
      const { taskId } = req.params;
      const { status } = req.body || {};

      if (!['executed', 'cancelled'].includes(status)) {
        return res.status(400).json({ error: 'Status inválido. Use: executed ou cancelled' });
      }

      const { data: task, error: findErr } = await supabase
        .from('crm_tasks')
        .select('id, status')
        .eq('id', taskId)
        .eq('clinic_id', req.clinicId)
        .single();

      if (findErr || !task) {
        return res.status(404).json({ error: 'Tarefa não encontrada' });
      }

      if (['completed', 'manual_completed', 'cancelled', 'executed'].includes(task.status)) {
        return res.json({ success: true, message: 'Tarefa já finalizada', task });
      }

      const update = { status, updated_at: new Date().toISOString() };
      if (status === 'executed') update.executed_at = new Date().toISOString();

      const { data: updated, error: updateErr } = await supabase
        .from('crm_tasks')
        .update(update)
        .eq('id', taskId)
        .select('*')
        .single();

      if (updateErr) {
        console.error('[CRM-API] Erro ao atualizar status da tarefa:', updateErr.message);
        return res.status(500).json({ error: 'Erro ao atualizar tarefa' });
      }

      console.log(`[CRM-API] Tarefa ${taskId} → ${status} por ${req.userName}`);
      return res.json({ success: true, task: updated });
    } catch (err) {
      console.error('[CRM-API] PATCH /tasks/:id/status:', err.message);
      return res.status(500).json({ error: 'Erro interno' });
    }
  });

  // ======================================================
  // 6. AGENDA DO DIA + PRÓXIMOS
  // ======================================================
  router.get('/agenda/today', async (req, res) => {
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
  // 7. CANCELAR AGENDAMENTO
  // ======================================================
  router.post('/appointments/:appointmentId/cancel', async (req, res) => {
    try {
      const { appointmentId } = req.params;
      const { reason } = req.body || {};

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

      console.log(`[CRM-API] Agendamento ${appointmentId} cancelado via dashboard por ${req.userName}`);
      return res.json({ success: true, message: 'Agendamento cancelado com sucesso' });
    } catch (err) {
      console.error('[CRM-API] /cancel:', err.message);
      return res.status(500).json({ error: 'Erro interno' });
    }
  });

  // ======================================================
  // 8. ANALYTICS — Receita e métricas por médico (owner only)
  // ======================================================
  router.get('/analytics', async (req, res) => {
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

      var now = new Date();
      var d7 = new Date(now.getTime()-7*86400000).toISOString().split('T')[0];
      var d14 = new Date(now.getTime()-14*86400000).toISOString().split('T')[0];
      var ult7 = all.filter(function(a){return a.appointment_date>=d7}).length;
      var ant7 = all.filter(function(a){return a.appointment_date>=d14 && a.appointment_date<d7}).length;
      var tendencia = ant7 > 0 ? ((ult7-ant7)/ant7)*100 : 0;

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

      // F9A: Timeline semanal — últimas 8 semanas
      var weekly_timeline = [];
      for (var w = 7; w >= 0; w--) {
        var wStart = new Date(now.getTime() - (w + 1) * 7 * 86400000);
        var wEnd = new Date(now.getTime() - w * 7 * 86400000);
        var wStartStr = wStart.toISOString().split('T')[0];
        var wEndStr = wEnd.toISOString().split('T')[0];
        var wLabel = wStart.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
        var wAppts = all.filter(function(a) { return a.appointment_date >= wStartStr && a.appointment_date < wEndStr; });
        weekly_timeline.push({
          label: wLabel,
          total: wAppts.length,
          cancelled: wAppts.filter(function(a) { return a.status === 'cancelled'; }).length,
          completed: wAppts.filter(function(a) { return a.status === 'completed'; }).length,
          no_show: wAppts.filter(function(a) { return a.status === 'no_show'; }).length,
          revenue: wAppts.filter(function(a) { return ['cancelled', 'no_show'].indexOf(a.status) < 0; }).reduce(function(s, a) { return s + Number(a.price || 0); }, 0),
        });
      }

      // F9C: Churn risk detection
      var churn_alerts = [];
      try {
        var { data: crmPatients } = await supabase
          .from('vw_patient_crm_full')
          .select('patient_id, patient_name, phone, current_stage, lead_score, last_contact_at, total_appointments')
          .eq('clinic_id', req.clinicId);

        var { data: futureAppts } = await supabase
          .from('appointments')
          .select('patient_id')
          .eq('clinic_id', req.clinicId)
          .in('status', ['scheduled', 'confirmed'])
          .gte('appointment_date', new Date().toISOString().split('T')[0]);

        var futureSet = {};
        (futureAppts || []).forEach(function(a) { futureSet[a.patient_id] = true; });

        var noShowMap = {};
        all.forEach(function(a) {
          if (a.status === 'no_show') {
            noShowMap[a.patient_id] = (noShowMap[a.patient_id] || 0) + 1;
          }
        });

        (crmPatients || []).forEach(function(p) {
          if (futureSet[p.patient_id]) return;
          var daysSince = p.last_contact_at ? Math.floor((Date.now() - new Date(p.last_contact_at).getTime()) / 86400000) : 999;
          var score = p.lead_score || 0;
          var noShows = noShowMap[p.patient_id] || 0;
          var risk = null;
          var reason = '';

          if (daysSince > 30 || score < 20) {
            risk = 'high';
            reason = daysSince > 30 ? 'Sem contato ha ' + daysSince + ' dias' : 'Lead score muito baixo (' + score + ')';
          } else if (daysSince > 14 || (noShows > 0 && daysSince > 7)) {
            risk = 'medium';
            reason = noShows > 0 ? noShows + ' no-show(s), ' + daysSince + 'd sem contato' : 'Sem contato ha ' + daysSince + ' dias';
          }

          if (risk) {
            churn_alerts.push({
              patient_id: p.patient_id,
              patient_name: p.patient_name,
              phone: p.phone,
              risk: risk,
              reason: reason,
              days_since_contact: daysSince,
              lead_score: score,
              stage: p.current_stage,
              suggestion: risk === 'high' ? 'Reativacao urgente' : 'Acompanhamento recomendado',
            });
          }
        });

        churn_alerts.sort(function(a, b) {
          if (a.risk !== b.risk) return a.risk === 'high' ? -1 : 1;
          return b.days_since_contact - a.days_since_contact;
        });
      } catch (churnErr) {
        console.warn('[CRM-API] Erro ao calcular churn:', churnErr.message);
      }

      const result = {
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
        weekly_timeline: weekly_timeline,
        churn_alerts: churn_alerts,
      };

      // Staff não vê dados financeiros
      if (req.userRole !== 'owner') {
        result.resumo.receita_bruta = undefined;
        result.resumo.receita_efetiva = undefined;
        result.resumo.ticket_medio = undefined;
        result.ranking_medicos = result.ranking_medicos.map(m => ({ ...m, receita: undefined }));
      }

      return res.json(result);
    } catch(err) {
      console.error('[CRM-API] /analytics:', err.message);
      return res.status(500).json({error:err.message});
    }
  });

  // ======================================================
  // 9. LISTA DE MÉDICOS (para filtros)
  // ======================================================
  router.get('/doctors', async (req, res) => {
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
  router.get('/stages', async (req, res) => {
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
  // 10B. TAGS DA CLÍNICA — CRUD (F9B)
  // ======================================================

  // ======================================================
  // 10A. NOTIFICAÇÕES / ATIVIDADE RECENTE (F9F)
  // ======================================================
  router.get('/notifications', async (req, res) => {
    try {
      var since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      var { data: events, error } = await supabase
        .from('crm_events')
        .select('id, event_type, occurred_at, source_system, payload, patient_id, patients!inner(name)')
        .eq('clinic_id', req.clinicId)
        .gte('occurred_at', since)
        .order('occurred_at', { ascending: false })
        .limit(30);

      if (error) {
        // Fallback sem join se patients relation falhar
        var { data: evFb } = await supabase
          .from('crm_events')
          .select('id, event_type, occurred_at, source_system, payload, patient_id')
          .eq('clinic_id', req.clinicId)
          .gte('occurred_at', since)
          .order('occurred_at', { ascending: false })
          .limit(30);
        events = evFb || [];
      }

      var recentThreshold = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      var recentCount = (events || []).filter(function(e) { return e.occurred_at >= recentThreshold; }).length;

      var notifications = (events || []).map(function(e) {
        return {
          id: e.id,
          event_type: e.event_type,
          occurred_at: e.occurred_at,
          patient_id: e.patient_id,
          patient_name: e.patients ? e.patients.name : null,
          source_system: e.source_system,
          payload: e.payload,
        };
      });

      return res.json({ notifications: notifications, recent_count: recentCount, total: notifications.length });
    } catch (err) {
      console.error('[CRM-API] /notifications:', err.message);
      return res.json({ notifications: [], recent_count: 0, total: 0 });
    }
  });

  router.get('/tags', async (req, res) => {
    try {
      const { data } = await supabase
        .from('clinic_tags')
        .select('id, name, color, created_at')
        .eq('clinic_id', req.clinicId)
        .order('name');
      return res.json(data || []);
    } catch (err) {
      console.error('[CRM-API] /tags:', err.message);
      return res.json([]);
    }
  });

  router.post('/tags', async (req, res) => {
    try {
      const { name, color } = req.body || {};
      if (!name || !name.trim()) return res.status(400).json({ error: 'Nome da tag obrigatório' });

      const { data, error } = await supabase
        .from('clinic_tags')
        .insert({ clinic_id: req.clinicId, name: name.trim(), color: color || '#6E9FFF' })
        .select('*')
        .single();

      if (error) {
        if (error.code === '23505') return res.status(409).json({ error: 'Tag já existe' });
        return res.status(500).json({ error: error.message });
      }

      return res.json({ success: true, tag: data });
    } catch (err) {
      console.error('[CRM-API] POST /tags:', err.message);
      return res.status(500).json({ error: 'Erro interno' });
    }
  });

  // ======================================================
  // 10C. TAGS DO PACIENTE — Adicionar/Remover (F9B)
  // ======================================================
  router.get('/patients/:patientId/tags', async (req, res) => {
    try {
      const { data } = await supabase
        .from('patient_tags')
        .select('id, tag_id, clinic_tags(id, name, color)')
        .eq('patient_id', req.params.patientId)
        .eq('clinic_id', req.clinicId);

      var tags = (data || []).map(function(pt) {
        return { id: pt.id, tag_id: pt.tag_id, name: pt.clinic_tags ? pt.clinic_tags.name : '?', color: pt.clinic_tags ? pt.clinic_tags.color : '#6E9FFF' };
      });
      return res.json(tags);
    } catch (err) {
      console.error('[CRM-API] GET /patients/:id/tags:', err.message);
      return res.json([]);
    }
  });

  router.post('/patients/:patientId/tags', async (req, res) => {
    try {
      const { tag_id } = req.body || {};
      if (!tag_id) return res.status(400).json({ error: 'tag_id obrigatório' });

      const { data, error } = await supabase
        .from('patient_tags')
        .insert({ clinic_id: req.clinicId, patient_id: req.params.patientId, tag_id: tag_id })
        .select('id, tag_id')
        .single();

      if (error) {
        if (error.code === '23505') return res.json({ success: true, message: 'Tag já atribuída' });
        return res.status(500).json({ error: error.message });
      }

      return res.json({ success: true, patient_tag: data });
    } catch (err) {
      console.error('[CRM-API] POST /patients/:id/tags:', err.message);
      return res.status(500).json({ error: 'Erro interno' });
    }
  });

  router.delete('/patients/:patientId/tags/:tagId', async (req, res) => {
    try {
      const { error } = await supabase
        .from('patient_tags')
        .delete()
        .eq('patient_id', req.params.patientId)
        .eq('tag_id', req.params.tagId)
        .eq('clinic_id', req.clinicId);

      if (error) return res.status(500).json({ error: error.message });
      return res.json({ success: true });
    } catch (err) {
      console.error('[CRM-API] DELETE /patients/:id/tags:', err.message);
      return res.status(500).json({ error: 'Erro interno' });
    }
  });

  // ======================================================
  // 11. RELATÓRIOS
  // ======================================================
  router.get('/reports/latest', async (req, res) => {
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

  router.get('/reports', async (req, res) => {
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

  router.post('/reports/generate', requireOwner, async (req, res) => {
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
