// routes/adminRoutes.js
// ============================================================
// ROTAS DO PAINEL ADMINISTRATIVO - ES MODULES
// ============================================================

import express from 'express';
import { createClient } from '@supabase/supabase-js';

const router = express.Router();

const supabase = createClient(
    process.env.SUPABASE_URL || 'missing',
    process.env.SUPABASE_SERVICE_ROLE_KEY || 'missing'
);

// Senha do painel admin — sem fallback (JG-P0-004)
const AUTH_PASSWORD = process.env.ADMIN_PASSWORD;
if (!AUTH_PASSWORD) {
    console.warn('⚠️  ADMIN_PASSWORD não definido — painel admin desabilitado');
}

// Validação UUID simples
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Middleware de autenticação + isolamento multi-tenant (JG-P0-004 + JG-P1-007)
function checkAuth(req, res, next) {
    if (!AUTH_PASSWORD) {
        return res.status(503).json({
            error: 'admin_not_configured',
            message: 'Painel admin desabilitado. Defina ADMIN_PASSWORD no ambiente.',
        });
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${AUTH_PASSWORD}`) {
        return res.status(401).json({ error: 'Não autorizado' });
    }

    // Multi-tenant: exige x-clinic-id em todos os requests (JG-P1-007)
    const clinicId = req.headers['x-clinic-id'];
    if (!clinicId || !UUID_RE.test(clinicId)) {
        return res.status(400).json({
            error: 'missing_clinic_id',
            message: 'Header x-clinic-id ausente ou inválido (UUID v4 requerido).',
        });
    }

    req.clinicId = clinicId;
    next();
}

// ============================================================
// INFO PÚBLICA DA CLÍNICA (sem autenticação — JG-P1-007)
// Retorna o DEFAULT_CLINIC_ID para o painel admin auto-preencher
// ============================================================

router.get('/api/clinic-info', (req, res) => {
    const clinicId = process.env.DEFAULT_CLINIC_ID || '';
    res.json({ clinic_id: clinicId });
});

// ============================================================
// DASHBOARD
// ============================================================

router.get('/api/dashboard', checkAuth, async (req, res) => {
    try {
        const hoje = new Date().toISOString().split('T')[0];
        
        const { data: todayAppointments } = await supabase
            .from('appointments')
            .select(`
                *,
                patients (name, phone),
                doctors (name),
                services (name, price)
            `)
            .eq('clinic_id', req.clinicId)
            .eq('appointment_date', hoje)
            .not('status', 'in', '("cancelled","no_show")')
            .order('start_time');

        const { count: totalToday } = await supabase
            .from('appointments')
            .select('*', { count: 'exact', head: true })
            .eq('clinic_id', req.clinicId)
            .eq('appointment_date', hoje)
            .not('status', 'eq', 'cancelled');

        const { count: pendingConfirmation } = await supabase
            .from('appointments')
            .select('*', { count: 'exact', head: true })
            .eq('clinic_id', req.clinicId)
            .eq('status', 'scheduled')
            .gte('appointment_date', hoje);

        const nextWeek = new Date();
        nextWeek.setDate(nextWeek.getDate() + 7);

        const { count: totalWeek } = await supabase
            .from('appointments')
            .select('*', { count: 'exact', head: true })
            .eq('clinic_id', req.clinicId)
            .gte('appointment_date', hoje)
            .lte('appointment_date', nextWeek.toISOString().split('T')[0])
            .not('status', 'eq', 'cancelled');
        
        res.json({
            success: true,
            data: {
                today: {
                    date: hoje,
                    appointments: todayAppointments || [],
                    total: totalToday || 0
                },
                stats: {
                    pendingConfirmation: pendingConfirmation || 0,
                    weekTotal: totalWeek || 0
                }
            }
        });
        
    } catch (error) {
        console.error('Erro no dashboard:', error);
        res.status(500).json({ error: 'Erro interno' });
    }
});

// ============================================================
// AGENDAMENTOS
// ============================================================

router.get('/api/appointments', checkAuth, async (req, res) => {
    try {
        const { date, doctor_id, status, limit = 50 } = req.query;
        
        let query = supabase
            .from('appointments')
            .select(`
                *,
                patients (id, name, phone, email),
                doctors (id, name, specialty),
                services (id, name, price, duration_minutes)
            `)
            .eq('clinic_id', req.clinicId)
            .order('appointment_date', { ascending: true })
            .order('start_time', { ascending: true })
            .limit(limit);

        if (date) query = query.eq('appointment_date', date);
        if (doctor_id) query = query.eq('doctor_id', doctor_id);
        if (status) query = query.eq('status', status);
        
        const { data, error } = await query;
        
        if (error) throw error;
        
        res.json({ success: true, data: data });
        
    } catch (error) {
        console.error('Erro ao listar agendamentos:', error);
        res.status(500).json({ error: 'Erro interno' });
    }
});

router.post('/api/appointments', checkAuth, async (req, res) => {
    try {
        const {
            patient_id, patient_name, patient_phone,
            doctor_id, service_id, appointment_date, start_time, notes
        } = req.body;
        
        if (!doctor_id || !service_id || !appointment_date || !start_time) {
            return res.status(400).json({ 
                error: 'Campos obrigatórios: doctor_id, service_id, appointment_date, start_time' 
            });
        }
        
        let patientId = patient_id;
        
        if (!patientId && patient_phone) {
            const phoneNormalized = patient_phone.replace(/\D/g, '');
            
            const { data: existingPatient } = await supabase
                .from('patients')
                .select('id')
                .eq('clinic_id', req.clinicId)
                .eq('phone', phoneNormalized)
                .single();

            if (existingPatient) {
                patientId = existingPatient.id;
            } else if (patient_name) {
                const { data: newPatient, error: createError } = await supabase
                    .from('patients')
                    .insert({ name: patient_name, phone: phoneNormalized, clinic_id: req.clinicId })
                    .select()
                    .single();
                
                if (createError) throw createError;
                patientId = newPatient.id;
            }
        }
        
        if (!patientId) {
            return res.status(400).json({ error: 'Paciente não identificado' });
        }
        
        const { data: service } = await supabase
            .from('services')
            .select('duration_minutes, price')
            .eq('clinic_id', req.clinicId)
            .eq('id', service_id)
            .single();
        
        if (!service) {
            return res.status(400).json({ error: 'Serviço não encontrado' });
        }
        
        const [hours, minutes] = start_time.split(':').map(Number);
        const endDate = new Date(2000, 0, 1, hours, minutes);
        endDate.setMinutes(endDate.getMinutes() + service.duration_minutes);
        const end_time = `${endDate.getHours().toString().padStart(2, '0')}:${endDate.getMinutes().toString().padStart(2, '0')}`;
        
        const { data: appointment, error: createError } = await supabase
            .from('appointments')
            .insert({
                clinic_id: req.clinicId,
                patient_id: patientId,
                doctor_id,
                service_id,
                appointment_date,
                start_time,
                end_time,
                status: 'scheduled',
                price: service.price,
                notes,
                created_by: 'admin',
            })
            .select(`
                *,
                patients (name, phone),
                doctors (name),
                services (name)
            `)
            .single();
        
        if (createError) {
            if (createError.code === '23505') {
                return res.status(409).json({ error: 'Horário já ocupado' });
            }
            throw createError;
        }
        
        res.status(201).json({ success: true, data: appointment });
        
    } catch (error) {
        console.error('Erro ao criar agendamento:', error);
        res.status(500).json({ error: 'Erro interno' });
    }
});

router.patch('/api/appointments/:id', checkAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;
        
        const allowedFields = ['status', 'notes', 'appointment_date', 'start_time', 'end_time'];
        const filteredUpdates = {};
        
        for (const field of allowedFields) {
            if (updates[field] !== undefined) {
                filteredUpdates[field] = updates[field];
            }
        }
        
        if (updates.status === 'cancelled' && updates.cancellation_reason) {
            filteredUpdates.cancellation_reason = updates.cancellation_reason;
            filteredUpdates.cancelled_by = 'admin';
        }
        
        const { data, error } = await supabase
            .from('appointments')
            .update(filteredUpdates)
            .eq('clinic_id', req.clinicId)
            .eq('id', id)
            .select()
            .single();
        
        if (error) throw error;
        
        res.json({ success: true, data: data });
        
    } catch (error) {
        console.error('Erro ao atualizar:', error);
        res.status(500).json({ error: 'Erro interno' });
    }
});

router.delete('/api/appointments/:id', checkAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const { reason } = req.body || {};
        
        const { data, error } = await supabase
            .from('appointments')
            .update({
                status: 'cancelled',
                cancellation_reason: reason || 'Cancelado pela recepção',
                cancelled_by: 'admin',
            })
            .eq('clinic_id', req.clinicId)
            .eq('id', id)
            .select()
            .single();
        
        if (error) throw error;
        
        res.json({ success: true, message: 'Cancelado', data: data });
        
    } catch (error) {
        console.error('Erro ao cancelar:', error);
        res.status(500).json({ error: 'Erro interno' });
    }
});

// ============================================================
// MÉDICOS
// ============================================================

router.get('/api/doctors', checkAuth, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('doctors')
            .select('*')
            .eq('clinic_id', req.clinicId)
            .order('name');
        
        if (error) throw error;
        
        res.json({ success: true, data: data });
        
    } catch (error) {
        console.error('Erro ao listar médicos:', error);
        res.status(500).json({ error: 'Erro interno' });
    }
});

// ============================================================
// PACIENTES
// ============================================================

router.get('/api/patients', checkAuth, async (req, res) => {
    try {
        const { search, limit = 50 } = req.query;
        
        let query = supabase
            .from('patients')
            .select('*')
            .eq('clinic_id', req.clinicId)
            .order('name')
            .limit(limit);
        
        if (search) {
            query = query.or(`name.ilike.%${search}%,phone.ilike.%${search}%`);
        }
        
        const { data, error } = await query;
        
        if (error) throw error;
        
        res.json({ success: true, data: data });
        
    } catch (error) {
        console.error('Erro ao listar pacientes:', error);
        res.status(500).json({ error: 'Erro interno' });
    }
});

router.post('/api/patients', checkAuth, async (req, res) => {
    try {
        const { name, phone, email, birth_date, notes } = req.body;
        
        if (!name || !phone) {
            return res.status(400).json({ error: 'Nome e telefone são obrigatórios' });
        }
        
        const phoneNormalized = phone.replace(/\D/g, '');
        
        const { data, error } = await supabase
            .from('patients')
            .insert({ clinic_id: req.clinicId, name, phone: phoneNormalized, email, birth_date, notes })
            .select()
            .single();
        
        if (error) {
            if (error.code === '23505') {
                return res.status(409).json({ error: 'Paciente já existe' });
            }
            throw error;
        }
        
        res.status(201).json({ success: true, data: data });
        
    } catch (error) {
        console.error('Erro ao criar paciente:', error);
        res.status(500).json({ error: 'Erro interno' });
    }
});

// ============================================================
// SERVIÇOS
// ============================================================

router.get('/api/services', checkAuth, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('services')
            .select('*')
            .eq('clinic_id', req.clinicId)
            .eq('active', true)
            .order('name');
        
        if (error) throw error;
        
        res.json({ success: true, data: data });
        
    } catch (error) {
        console.error('Erro ao listar serviços:', error);
        res.status(500).json({ error: 'Erro interno' });
    }
});

export default router;
