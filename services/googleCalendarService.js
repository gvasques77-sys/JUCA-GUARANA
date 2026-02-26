// services/googleCalendarService.js
// Integração OAuth2 com Google Calendar — usa fetch nativo (Node 18+)

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    process.env.SUPABASE_URL || 'missing',
    process.env.SUPABASE_SERVICE_ROLE_KEY || 'missing'
);

// ============================================================
// CONSTANTES
// ============================================================

const GOOGLE_TOKEN_URL    = 'https://oauth2.googleapis.com/token';
const GOOGLE_CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
const GOOGLE_AUTH_URL     = 'https://accounts.google.com/o/oauth2/v2/auth';

const SCOPES = [
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/calendar.events.readonly',
].join(' ');

// Palavras-chave que tornam um evento num bloqueio de agenda
const BLOCK_KEYWORDS = [
    'férias', 'ferias', 'folga', 'bloqueado', 'bloqueio',
    'indisponível', 'indisponivel', 'licença', 'licenca',
    'recesso', 'feriado', 'congresso', 'viagem', 'ausente'
];

function getClientId()     { return process.env.GOOGLE_CLIENT_ID || ''; }
function getClientSecret() { return process.env.GOOGLE_CLIENT_SECRET || ''; }
function getRedirectUri()  { return process.env.GOOGLE_REDIRECT_URI || ''; }

// ============================================================
// OAUTH2 — Geração de URL e troca de código
// ============================================================

/**
 * Gera a URL de autorização OAuth2 para o médico conectar o Google Calendar
 * @param {string} doctorId - UUID do médico
 * @param {string} clinicId - UUID da clínica
 * @returns {string} URL para redirecionar o médico
 */
export function generateAuthUrl(doctorId, clinicId) {
    const clientId = getClientId();
    if (!clientId) throw new Error('GOOGLE_CLIENT_ID não configurado');

    const state = Buffer.from(JSON.stringify({ doctorId, clinicId })).toString('base64url');

    const params = new URLSearchParams({
        client_id:     clientId,
        redirect_uri:  getRedirectUri(),
        response_type: 'code',
        scope:         SCOPES,
        access_type:   'offline',
        prompt:        'consent',
        state,
    });

    return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

/**
 * Troca o authorization code pelos tokens de acesso
 * @param {string} code - código retornado pelo Google
 * @returns {{ access_token, refresh_token, expires_in, token_type }}
 */
export async function exchangeCodeForTokens(code) {
    const response = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            code,
            client_id:     getClientId(),
            client_secret: getClientSecret(),
            redirect_uri:  getRedirectUri(),
            grant_type:    'authorization_code',
        }).toString(),
    });

    const data = await response.json();

    if (!response.ok || data.error) {
        throw new Error(`Erro ao trocar código Google: ${data.error_description || data.error || response.status}`);
    }

    return data;
}

/**
 * Renova o access_token usando o refresh_token
 * @param {string} refreshToken
 * @returns {{ access_token, expires_in }}
 */
async function refreshAccessToken(refreshToken) {
    const response = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            refresh_token: refreshToken,
            client_id:     getClientId(),
            client_secret: getClientSecret(),
            grant_type:    'refresh_token',
        }).toString(),
    });

    const data = await response.json();

    if (!response.ok || data.error) {
        throw new Error(`Erro ao renovar token Google: ${data.error_description || data.error || response.status}`);
    }

    return data;
}

// ============================================================
// PERSISTÊNCIA DE TOKENS NO SUPABASE
// ============================================================

/**
 * Salva ou atualiza tokens OAuth2 na tabela doctor_gcal_tokens
 * @param {string} doctorId
 * @param {string} clinicId
 * @param {{ access_token, refresh_token, expires_in }} tokens
 */
export async function saveTokens(doctorId, clinicId, tokens) {
    const expiresAt = new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString();

    const { error } = await supabase
        .from('doctor_gcal_tokens')
        .upsert({
            doctor_id:     doctorId,
            clinic_id:     clinicId,
            access_token:  tokens.access_token,
            refresh_token: tokens.refresh_token || null,
            expires_at:    expiresAt,
            updated_at:    new Date().toISOString(),
        }, { onConflict: 'doctor_id' });

    if (error) throw new Error(`Erro ao salvar tokens Google: ${error.message}`);
    console.log(`[GCal] Tokens salvos para médico ${doctorId}`);
}

/**
 * Busca tokens do médico; renova automaticamente se expirados
 * @param {string} doctorId
 * @returns {{ access_token, refresh_token, expires_at } | null}
 */
async function getValidTokens(doctorId) {
    const { data, error } = await supabase
        .from('doctor_gcal_tokens')
        .select('access_token, refresh_token, expires_at, clinic_id')
        .eq('doctor_id', doctorId)
        .maybeSingle();

    if (error || !data) return null;

    const expiresAt = new Date(data.expires_at);
    const nowPlusBuf = new Date(Date.now() + 5 * 60 * 1000); // 5 min de buffer

    if (expiresAt > nowPlusBuf) {
        return data; // token ainda válido
    }

    if (!data.refresh_token) {
        console.warn(`[GCal] Token expirado e sem refresh_token para médico ${doctorId}`);
        return null;
    }

    try {
        console.log(`[GCal] Renovando access_token para médico ${doctorId}`);
        const renewed = await refreshAccessToken(data.refresh_token);
        await saveTokens(doctorId, data.clinic_id, {
            access_token:  renewed.access_token,
            refresh_token: data.refresh_token, // refresh_token não é retornado na renovação
            expires_in:    renewed.expires_in,
        });
        return { ...data, access_token: renewed.access_token };
    } catch (err) {
        console.error(`[GCal] Falha ao renovar token para ${doctorId}:`, err.message);
        return null;
    }
}

// ============================================================
// STATUS DE CONEXÃO
// ============================================================

/**
 * Verifica se o médico autorizou o Google Calendar
 * @param {string} doctorId
 * @returns {boolean}
 */
export async function isDoctorCalendarConnected(doctorId) {
    const { data } = await supabase
        .from('doctor_gcal_tokens')
        .select('doctor_id')
        .eq('doctor_id', doctorId)
        .maybeSingle();
    return !!data;
}

// ============================================================
// HELPERS DE CLASSIFICAÇÃO
// ============================================================

function isBlockKeyword(text) {
    if (!text) return false;
    const lower = text.toLowerCase();
    return BLOCK_KEYWORDS.some(kw => lower.includes(kw));
}

function isAllDayEvent(event) {
    return !!(event.start?.date && !event.start?.dateTime);
}

function shouldBlock(event) {
    return isAllDayEvent(event) || isBlockKeyword(event.summary) || isBlockKeyword(event.description);
}

function eventToDateRange(event) {
    if (isAllDayEvent(event)) {
        return { start: event.start.date, end: event.end.date };
    }
    // Evento com hora → extrai apenas a data
    const startDate = event.start.dateTime.split('T')[0];
    const endDate   = event.end.dateTime.split('T')[0];
    return { start: startDate, end: endDate };
}

// ============================================================
// SINCRONIZAÇÃO DE EVENTOS → schedule_blocks
// ============================================================

/**
 * Sincroniza eventos do Google Calendar de um médico para schedule_blocks
 * @param {string} clinicId
 * @param {string} doctorId
 * @param {number} daysAhead - quantos dias à frente sincronizar (padrão 60)
 */
export async function syncDoctorCalendar(clinicId, doctorId, daysAhead = 60) {
    const tokens = await getValidTokens(doctorId);
    if (!tokens) {
        console.warn(`[GCal] Médico ${doctorId} sem tokens válidos — sync ignorado`);
        return { synced: 0, skipped: 0, reason: 'no_tokens' };
    }

    const timeMin = new Date().toISOString();
    const timeMax = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000).toISOString();

    const params = new URLSearchParams({
        calendarId:  'primary',
        timeMin,
        timeMax,
        singleEvents: 'true',
        orderBy:      'startTime',
        maxResults:   '250',
    });

    const response = await fetch(
        `${GOOGLE_CALENDAR_API}/calendars/primary/events?${params.toString()}`,
        { headers: { Authorization: `Bearer ${tokens.access_token}` } }
    );

    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(`Erro na API Google Calendar: ${err.error?.message || response.status}`);
    }

    const { items: events = [] } = await response.json();
    const blockableEvents = events.filter(shouldBlock);

    console.log(`[GCal] Médico ${doctorId}: ${events.length} eventos encontrados, ${blockableEvents.length} a bloquear`);

    let synced = 0;
    let skipped = 0;

    for (const event of blockableEvents) {
        const { start, end } = eventToDateRange(event);
        const gcalEventId = event.id;

        // Upsert baseado no gcal_event_id (evita duplicatas)
        const { error } = await supabase
            .from('schedule_blocks')
            .upsert({
                clinic_id:     clinicId,
                doctor_id:     doctorId,
                start_date:    start,
                end_date:      end,
                reason:        event.summary || 'Bloqueio Google Calendar',
                source:        'gcal',
                gcal_event_id: gcalEventId,
                created_at:    new Date().toISOString(),
            }, { onConflict: 'gcal_event_id' });

        if (error) {
            console.warn(`[GCal] Erro ao inserir bloqueio ${gcalEventId}:`, error.message);
            skipped++;
        } else {
            synced++;
        }
    }

    // Remove bloqueios gcal que não existem mais no Google Calendar
    const activeIds = blockableEvents.map(e => e.id);
    if (activeIds.length > 0) {
        await supabase
            .from('schedule_blocks')
            .delete()
            .eq('clinic_id', clinicId)
            .eq('doctor_id', doctorId)
            .eq('source', 'gcal')
            .not('gcal_event_id', 'in', `(${activeIds.map(id => `"${id}"`).join(',')})`);
    } else {
        // Nenhum evento bloqueável → limpa todos os bloqueios gcal deste médico no período
        await supabase
            .from('schedule_blocks')
            .delete()
            .eq('clinic_id', clinicId)
            .eq('doctor_id', doctorId)
            .eq('source', 'gcal');
    }

    console.log(`[GCal] Sync concluído para ${doctorId}: ${synced} inseridos, ${skipped} erros`);
    return { synced, skipped };
}

/**
 * Sincroniza todos os médicos da clínica que têm tokens salvos
 * @param {string} clinicId
 * @param {number} daysAhead
 */
export async function syncAllDoctorsCalendar(clinicId, daysAhead = 60) {
    const { data: tokenRecords, error } = await supabase
        .from('doctor_gcal_tokens')
        .select('doctor_id')
        .eq('clinic_id', clinicId);

    if (error) throw new Error(`Erro ao listar tokens: ${error.message}`);
    if (!tokenRecords || tokenRecords.length === 0) {
        console.log(`[GCal] Nenhum médico com Google Calendar conectado na clínica ${clinicId}`);
        return { total: 0, results: [] };
    }

    const results = [];
    for (const { doctor_id } of tokenRecords) {
        try {
            const result = await syncDoctorCalendar(clinicId, doctor_id, daysAhead);
            results.push({ doctor_id, ...result });
        } catch (err) {
            console.error(`[GCal] Erro ao sincronizar médico ${doctor_id}:`, err.message);
            results.push({ doctor_id, error: err.message });
        }
    }

    return { total: tokenRecords.length, results };
}
