// routes/googleCalendarRoutes.js
// Rotas administrativas para integração Google Calendar
// Montadas em /admin/gcal no server.js

import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import {
    generateAuthUrl,
    exchangeCodeForTokens,
    saveTokens,
    syncDoctorCalendar,
    syncAllDoctorsCalendar,
    isDoctorCalendarConnected,
} from '../services/googleCalendarService.js';

const router = Router();

const supabase = createClient(
    process.env.SUPABASE_URL || 'missing',
    process.env.SUPABASE_SERVICE_ROLE_KEY || 'missing'
);

// ============================================================
// GET /admin/gcal/auth/:doctorId?clinicId=xxx
// Redireciona o médico para o fluxo OAuth2 do Google
// ============================================================
router.get('/auth/:doctorId', (req, res) => {
    try {
        const { doctorId } = req.params;
        const clinicId = req.query.clinicId;

        if (!clinicId) {
            return res.status(400).json({ error: 'clinicId é obrigatório' });
        }

        const authUrl = generateAuthUrl(doctorId, clinicId);
        return res.redirect(authUrl);
    } catch (err) {
        console.error('[GCal Route] Erro ao gerar URL de auth:', err.message);
        return res.status(500).json({ error: err.message });
    }
});

// ============================================================
// GET /admin/gcal/callback
// Recebe o code do Google, troca por tokens e faz sync inicial
// ============================================================
router.get('/callback', async (req, res) => {
    try {
        const { code, state, error } = req.query;

        if (error) {
            return res.status(400).send(`<h2>Autorização negada pelo Google: ${error}</h2>`);
        }

        if (!code || !state) {
            return res.status(400).send('<h2>Parâmetros ausentes na callback</h2>');
        }

        let doctorId, clinicId;
        try {
            ({ doctorId, clinicId } = JSON.parse(Buffer.from(state, 'base64url').toString('utf8')));
        } catch {
            return res.status(400).send('<h2>State inválido</h2>');
        }

        const tokens = await exchangeCodeForTokens(code);
        await saveTokens(doctorId, clinicId, tokens);

        // Sync inicial
        try {
            await syncDoctorCalendar(clinicId, doctorId, 60);
        } catch (syncErr) {
            console.warn('[GCal Route] Sync inicial falhou (não crítico):', syncErr.message);
        }

        return res.send(`
            <html><body style="font-family:sans-serif;text-align:center;padding:40px">
            <h2>✅ Google Calendar conectado com sucesso!</h2>
            <p>O calendário do médico foi sincronizado.</p>
            <p>Você pode fechar esta janela.</p>
            </body></html>
        `);
    } catch (err) {
        console.error('[GCal Route] Erro na callback:', err.message);
        return res.status(500).send(`<h2>Erro interno: ${err.message}</h2>`);
    }
});

// ============================================================
// POST /admin/gcal/sync/:clinicId
// Sincroniza todos os médicos da clínica
// ============================================================
router.post('/sync/:clinicId', async (req, res) => {
    try {
        const { clinicId } = req.params;
        const daysAhead = Number(req.body?.daysAhead) || 60;

        const result = await syncAllDoctorsCalendar(clinicId, daysAhead);
        return res.json({ ok: true, ...result });
    } catch (err) {
        console.error('[GCal Route] Erro no sync geral:', err.message);
        return res.status(500).json({ ok: false, error: err.message });
    }
});

// ============================================================
// POST /admin/gcal/sync/:clinicId/:doctorId
// Sincroniza um médico específico
// ============================================================
router.post('/sync/:clinicId/:doctorId', async (req, res) => {
    try {
        const { clinicId, doctorId } = req.params;
        const daysAhead = Number(req.body?.daysAhead) || 60;

        const result = await syncDoctorCalendar(clinicId, doctorId, daysAhead);
        return res.json({ ok: true, doctor_id: doctorId, ...result });
    } catch (err) {
        console.error('[GCal Route] Erro no sync do médico:', err.message);
        return res.status(500).json({ ok: false, error: err.message });
    }
});

// ============================================================
// GET /admin/gcal/status/:clinicId
// Lista médicos com status de conexão e link de autorização
// ============================================================
router.get('/status/:clinicId', async (req, res) => {
    try {
        const { clinicId } = req.params;
        const baseUrl = process.env.BASE_URL || '';

        const { data: doctors, error } = await supabase
            .from('doctors')
            .select('id, name, specialty')
            .eq('clinic_id', clinicId)
            .eq('active', true)
            .order('name');

        if (error) throw error;

        const statuses = await Promise.all(
            (doctors || []).map(async (doc) => {
                const connected = await isDoctorCalendarConnected(doc.id);
                return {
                    doctor_id:   doc.id,
                    name:        doc.name,
                    specialty:   doc.specialty,
                    connected,
                    auth_url: connected
                        ? null
                        : `${baseUrl}/admin/gcal/auth/${doc.id}?clinicId=${clinicId}`,
                };
            })
        );

        return res.json({ ok: true, doctors: statuses });
    } catch (err) {
        console.error('[GCal Route] Erro ao buscar status:', err.message);
        return res.status(500).json({ ok: false, error: err.message });
    }
});

export default router;
