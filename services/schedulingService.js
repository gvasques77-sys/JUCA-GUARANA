// services/schedulingService.js
// ============================================================
// SERVIÇO DE AGENDAMENTO - ES MODULES
// ============================================================

import { createClient } from '@supabase/supabase-js';
import {
    getCachedSlots,
    setCachedSlots,
    invalidateSlotsCache
} from './redisService.js';

const supabase = createClient(
    process.env.SUPABASE_URL || 'missing',
    process.env.SUPABASE_SERVICE_ROLE_KEY || 'missing'
);

// ============================================================
// CONSTANTES
// ============================================================

// FIX 2 — Proteção contra recursão infinita em buscarProximasDatasDisponiveis
const MAX_RECURSION_DEPTH = 3;
const MAX_SLOTS_RETORNO   = 5;
const DIAS_BUSCA_FUTURO   = 30;

export const DIAS_SEMANA = {
    0: 'Domingo',
    1: 'Segunda-feira',
    2: 'Terça-feira',
    3: 'Quarta-feira',
    4: 'Quinta-feira',
    5: 'Sexta-feira',
    6: 'Sábado'
};

export const STATUS_LABELS = {
    'scheduled': 'Agendado',
    'confirmed': 'Confirmado',
    'waiting': 'Aguardando',
    'in_progress': 'Em atendimento',
    'completed': 'Finalizado',
    'cancelled': 'Cancelado',
    'no_show': 'Não compareceu'
};

// ============================================================
// HELPERS
// ============================================================

export function formatDate(dateStr) {
    const date = new Date(dateStr + 'T00:00:00');
    return date.toLocaleDateString('pt-BR');
}

export function formatTime(timeStr) {
    return timeStr ? timeStr.substring(0, 5) : '';
}

export function formatCurrency(value) {
    return new Intl.NumberFormat('pt-BR', {
        style: 'currency',
        currency: 'BRL'
    }).format(value);
}

function generateTimeSlots(startTime, endTime, slotDuration) {
    const slots = [];
    const [startHour, startMin] = startTime.split(':').map(Number);
    const [endHour, endMin] = endTime.split(':').map(Number);

    let currentHour = startHour;
    let currentMin = startMin;

    while (currentHour < endHour || (currentHour === endHour && currentMin < endMin)) {
        const timeStr = `${currentHour.toString().padStart(2, '0')}:${currentMin.toString().padStart(2, '0')}`;
        slots.push(timeStr);

        currentMin += slotDuration;
        if (currentMin >= 60) {
            currentHour += Math.floor(currentMin / 60);
            currentMin = currentMin % 60;
        }
    }

    return slots;
}

function getDayOfWeek(dateStr) {
    const date = new Date(dateStr + 'T12:00:00');
    return date.getDay();
}

// ============================================================
// FUNÇÕES PRINCIPAIS
// ============================================================

/**
 * Lista médicos/profissionais da clínica
 * @param {string} clinicId - UUID da clínica (obrigatório para isolamento multi-tenant)
 * @param {string|null} specialty - filtro de especialidade opcional
 */
export async function listarMedicos(clinicId, specialty = null) {
    try {
        let query = supabase
            .from('doctors')
            .select(`
                id,
                name,
                specialty,
                bio,
                doctor_services (
                    services (id, name, price, duration_minutes)
                )
            `)
            .eq('clinic_id', clinicId)
            .eq('active', true)
            .order('name');

        if (specialty) {
            query = query.ilike('specialty', `%${specialty}%`);
        }

        const { data: doctors, error } = await query;

        if (error) throw error;

        if (!doctors || doctors.length === 0) {
            return {
                success: true,
                message: specialty
                    ? `Não encontrei médicos com a especialidade "${specialty}".`
                    : 'Não há médicos cadastrados no momento.',
                doctors: []
            };
        }

        const medicosFormatados = doctors.map(doc => ({
            id: doc.id,
            nome: doc.name,
            especialidade: doc.specialty || 'Clínico Geral',
            bio: doc.bio
        }));

        let mensagem = '👨‍⚕️ **Nossos Profissionais:**\n\n';
        medicosFormatados.forEach((med, idx) => {
            mensagem += `${idx + 1}. **${med.nome}**\n`;
            mensagem += `   📋 ${med.especialidade}\n`;
            if (med.bio) mensagem += `   ℹ️ ${med.bio}\n`;
            mensagem += '\n';
        });

        return { success: true, message: mensagem, doctors: medicosFormatados };

    } catch (error) {
        console.error('Erro ao listar médicos:', error);
        return { success: false, message: 'Erro ao buscar médicos.', error: error.message };
    }
}

/**
 * Lista serviços da clínica
 * @param {string} clinicId - UUID da clínica (obrigatório para isolamento multi-tenant)
 * @param {string|null} doctorId - filtra serviços por médico específico
 */
export async function listarServicos(clinicId, doctorId = null) {
    try {
        let query;

        if (doctorId) {
            query = supabase
                .from('doctor_services')
                .select(`services (id, name, description, duration_minutes, price)`)
                .eq('clinic_id', clinicId)
                .eq('doctor_id', doctorId);
        } else {
            query = supabase
                .from('services')
                .select('*')
                .eq('clinic_id', clinicId)
                .eq('active', true)
                .order('name');
        }

        const { data, error } = await query;
        if (error) throw error;

        const servicos = doctorId
            ? data.map(d => d.services).filter(Boolean)
            : data;

        if (!servicos || servicos.length === 0) {
            return { success: true, message: 'Não há serviços disponíveis.', services: [] };
        }

        let mensagem = '💆 **Serviços Disponíveis:**\n\n';
        servicos.forEach((serv, idx) => {
            mensagem += `${idx + 1}. **${serv.name}**\n`;
            mensagem += `   ⏱️ ${serv.duration_minutes} min | 💰 ${formatCurrency(serv.price)}\n\n`;
        });

        return { success: true, message: mensagem, services: servicos };

    } catch (error) {
        console.error('Erro ao listar serviços:', error);
        return { success: false, message: 'Erro ao buscar serviços.', error: error.message };
    }
}

/**
 * Versão interna — verifica disponibilidade SEM fallback recursivo.
 * Usada por buscarProximasDatasDisponiveis para evitar recursão infinita.
 */
async function verificarDisponibilidadeSimples(clinicId, doctorId, date) {
    const dayOfWeek = getDayOfWeek(date);

    const { data: schedules } = await supabase
        .from('schedules')
        .select('start_time, end_time, slot_duration_minutes')
        .eq('doctor_id', doctorId)
        .eq('clinic_id', clinicId)
        .eq('day_of_week', dayOfWeek)
        .eq('active', true);

    if (!schedules || schedules.length === 0) return [];

    const { data: blocks } = await supabase
        .from('schedule_blocks')
        .select('id')
        .eq('clinic_id', clinicId)
        .or(`doctor_id.eq.${doctorId},doctor_id.is.null`)
        .lte('start_date', date)
        .gte('end_date', date);

    if (blocks && blocks.length > 0) return [];

    let allSlots = [];
    for (const schedule of schedules) {
        const slots = generateTimeSlots(
            schedule.start_time,
            schedule.end_time,
            schedule.slot_duration_minutes || 30
        );
        allSlots = [...allSlots, ...slots];
    }

    const { data: appointments } = await supabase
        .from('appointments')
        .select('start_time')
        .eq('clinic_id', clinicId)
        .eq('doctor_id', doctorId)
        .eq('appointment_date', date)
        .not('status', 'in', '("cancelled","no_show")');

    const occupied = new Set(appointments?.map(a => formatTime(a.start_time)) || []);
    return allSlots.filter(s => !occupied.has(s));
}

/**
 * Verifica disponibilidade de horários para um médico em uma data
 * @param {string} clinicId - UUID da clínica (obrigatório para isolamento multi-tenant)
 * @param {string} doctorId - UUID do médico
 * @param {string} date - data no formato YYYY-MM-DD
 */
export async function verificarDisponibilidade(clinicId, doctorId, date) {
    try {
        // ============================================================
        // PRIORIDADE 1 — Guard Clauses: Validação Determinística de Entrada
        // O LLM nunca deve decidir se há conflito — a função é 100% determinística.
        // ============================================================

        // Guard 1: Validar formato da data (YYYY-MM-DD)
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            console.warn(`[P1-GUARD] Data inválida recebida: '${date}'`);
            return {
                success: false,
                error: 'DATA_INVALIDA',
                message: 'A data informada está em formato inválido. Por favor, informe uma data no formato YYYY-MM-DD (ex: 2026-03-15).'
            };
        }

        // Guard 2: Validar se a data é uma data real (ex: 2026-02-30 não existe)
        const dateObj = new Date(date + 'T12:00:00');
        if (isNaN(dateObj.getTime())) {
            console.warn(`[P1-GUARD] Data inválida (NaN): '${date}'`);
            return {
                success: false,
                error: 'DATA_INVALIDA',
                message: 'A data informada não é válida. Por favor, verifique e informe uma data correta.'
            };
        }

        // Guard 3: Validar se a data não está no passado
        const hoje = new Date();
        hoje.setHours(0, 0, 0, 0);

        if (dateObj < hoje) {
            console.warn(`[P1-GUARD] Data no passado: '${date}'`);
            return {
                success: false,
                error: 'DATA_PASSADA',
                message: `A data ${formatDate(date)} já passou. Por favor, informe uma data futura.`
            };
        }

        // Guard 4: Validar se a data não está muito no futuro (mais de 1 ano)
        const umAnoFuturo = new Date();
        umAnoFuturo.setFullYear(umAnoFuturo.getFullYear() + 1);
        if (dateObj > umAnoFuturo) {
            console.warn(`[P1-GUARD] Data muito distante no futuro: '${date}'`);
            return {
                success: false,
                error: 'DATA_MUITO_DISTANTE',
                message: `A data ${formatDate(date)} está muito distante. Agendamentos podem ser feitos com até 1 ano de antecedência.`
            };
        }

        // Guard 5: Validar doctorId
        if (!doctorId || typeof doctorId !== 'string' || doctorId.trim() === '') {
            console.warn(`[P1-GUARD] doctorId inválido: '${doctorId}'`);
            return {
                success: false,
                error: 'MEDICO_INVALIDO',
                message: 'Médico não especificado. Por favor, informe o médico desejado.'
            };
        }

        // Cache L1: Redis
        const cached = await getCachedSlots(clinicId, doctorId, date);
        if (cached) {
            console.log(`[Scheduling] Cache HIT para ${doctorId} em ${date}`);
            return cached;
        }
        console.log(`[Scheduling] Cache MISS para ${doctorId} em ${date} — buscando no Supabase`);

        const dayOfWeek = getDayOfWeek(date);

        // Buscar médico (validando que pertence à clínica)
        const { data: doctor, error: doctorError } = await supabase
            .from('doctors')
            .select('id, name, specialty')
            .eq('id', doctorId)
            .eq('clinic_id', clinicId)
            .single();

        if (doctorError || !doctor) {
            return { success: false, message: 'Médico não encontrado.' };
        }

        // Buscar horários do médico para o dia da semana
        const { data: schedules, error: scheduleError } = await supabase
            .from('schedules')
            .select('*')
            .eq('doctor_id', doctorId)
            .eq('clinic_id', clinicId)
            .eq('day_of_week', dayOfWeek)
            .eq('active', true);

        if (scheduleError) throw scheduleError;

        if (!schedules || schedules.length === 0) {
            console.log(`[Scheduling] ${doctor.name} não atende ${DIAS_SEMANA[dayOfWeek]}s — buscando próximas datas`);
            // FIX 2: Usar buscarProximasDatasDisponiveis com profundidade 1 para evitar recursão
            const proximasDatas = await buscarProximasDatasDisponiveis(clinicId, doctorId, 21, 1);
            const resultado = {
                success: true,
                available_slots: [],
                doctor: doctor,
                date: date,
                no_schedule_this_day: true,
                next_available_dates: proximasDatas.dates || [],
                message: proximasDatas.dates?.length > 0
                    ? `${doctor.name} não atende às ${DIAS_SEMANA[dayOfWeek]}s.\n\n${proximasDatas.message}`
                    : `${doctor.name} não tem horários disponíveis nos próximos 21 dias. Posso te ajudar com outro médico?`
            };
            await setCachedSlots(clinicId, doctorId, date, resultado);
            return resultado;
        }

        // Verificar bloqueios de agenda
        const { data: blocks } = await supabase
            .from('schedule_blocks')
            .select('*')
            .eq('clinic_id', clinicId)
            .or(`doctor_id.eq.${doctorId},doctor_id.is.null`)
            .lte('start_date', date)
            .gte('end_date', date);

        if (blocks && blocks.length > 0) {
            return {
                success: true,
                message: `${doctor.name} não está disponível nesta data.`,
                available_slots: [],
                doctor: doctor
            };
        }

        // Gerar todos os slots de horário
        let allSlots = [];
        for (const schedule of schedules) {
            const slots = generateTimeSlots(
                schedule.start_time,
                schedule.end_time,
                schedule.slot_duration_minutes || 30
            );
            allSlots = [...allSlots, ...slots];
        }

        // Buscar agendamentos já existentes na data para subtrair slots ocupados
        const { data: appointments } = await supabase
            .from('appointments')
            .select('start_time')
            .eq('clinic_id', clinicId)
            .eq('doctor_id', doctorId)
            .eq('appointment_date', date)
            .not('status', 'in', '("cancelled","no_show")');

        const occupiedSlots = new Set(
            appointments?.map(a => formatTime(a.start_time)) || []
        );

        let availableSlots = allSlots.filter(slot => !occupiedSlots.has(slot));

        // Se for hoje, remover horários passados (+30 min de buffer)
        const todayStr = hoje.toISOString().split('T')[0];
        if (date === todayStr) {
            const agora = new Date();
            const horaAtual = agora.getHours() * 60 + agora.getMinutes();
            availableSlots = availableSlots.filter(slot => {
                const [h, m] = slot.split(':').map(Number);
                return (h * 60 + m) > horaAtual + 30;
            });
        }

        if (availableSlots.length === 0) {
            // FIX 2: Usar buscarProximasDatasDisponiveis com profundidade 1 para evitar recursão
            const proximasDatas = await buscarProximasDatasDisponiveis(clinicId, doctorId, 21, 1);
            const resultado = {
                success: true,
                available_slots: [],
                doctor: doctor,
                date: date,
                fully_booked: true,
                next_available_dates: proximasDatas.dates || [],
                message: proximasDatas.dates?.length > 0
                    ? `Não há horários vagos para ${doctor.name} em ${formatDate(date)}.\n\n${proximasDatas.message}`
                    : `Não há horários disponíveis para ${doctor.name} em ${formatDate(date)} e nos próximos 21 dias.`
            };
            await setCachedSlots(clinicId, doctorId, date, resultado);
            return resultado;
        }

        // Agrupar por período
        const manha = availableSlots.filter(s => parseInt(s.split(':')[0]) < 12);
        const tarde = availableSlots.filter(s => {
            const h = parseInt(s.split(':')[0]);
            return h >= 12 && h < 18;
        });
        const noite = availableSlots.filter(s => parseInt(s.split(':')[0]) >= 18);

        let mensagem = `📅 **Horários disponíveis**\n`;
        mensagem += `👨‍⚕️ ${doctor.name}\n`;
        mensagem += `📆 ${DIAS_SEMANA[dayOfWeek]}, ${formatDate(date)}\n\n`;

        if (manha.length > 0) mensagem += `☀️ **Manhã:** ${manha.join(', ')}\n`;
        if (tarde.length > 0) mensagem += `🌤️ **Tarde:** ${tarde.join(', ')}\n`;
        if (noite.length > 0) mensagem += `🌙 **Noite:** ${noite.join(', ')}\n`;

        mensagem += `\nQual horário você prefere?`;

        const resultado = {
            success: true,
            message: mensagem,
            available_slots: availableSlots,
            doctor: doctor,
            date: date
        };
        await setCachedSlots(clinicId, doctorId, date, resultado);
        return resultado;

    } catch (error) {
        console.error('Erro ao verificar disponibilidade:', error);
        return { success: false, message: 'Erro ao verificar disponibilidade.', error: error.message };
    }
}


// Mapeamento de nomes de dias da semana em inglês para número (0=domingo, 1=segunda...)
const WEEKDAY_NAME_MAP = {
    'sunday': 0,
    'monday': 1,
    'tuesday': 2,
    'wednesday': 3,
    'thursday': 4,
    'friday': 5,
    'saturday': 6,
};

/**
 * BUG 4 FIX: Verifica disponibilidade de um médico por dia da semana.
 * Busca as próximas ocorrências do dia da semana especificado.
 * @param {string} clinicId - UUID da clínica
 * @param {string} doctorId - UUID do médico
 * @param {string} weekday - dia da semana em inglês ("friday", "monday", etc.)
 * @param {number} weeksAhead - quantas semanas à frente buscar (padrão: 2)
 */
export async function verificarDisponibilidadePorDiaSemana(clinicId, doctorId, weekday, weeksAhead = 2) {
    try {
        const targetDay = WEEKDAY_NAME_MAP[weekday?.toLowerCase()];
        if (targetDay === undefined) {
            return {
                success: false,
                message: `Dia da semana inválido: "${weekday}". Use: monday, tuesday, wednesday, thursday, friday, saturday.`
            };
        }

        // Buscar médico
        const { data: doctor, error: doctorError } = await supabase
            .from('doctors')
            .select('id, name, specialty')
            .eq('id', doctorId)
            .eq('clinic_id', clinicId)
            .single();

        if (doctorError || !doctor) {
            return { success: false, message: 'Médico não encontrado.' };
        }

        const DIAS_SEMANA_PT = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
        const dayNamePt = DIAS_SEMANA_PT[targetDay];

        const datasDisponiveis = [];
        const hoje = new Date();
        hoje.setHours(0, 0, 0, 0);

        // Buscar as próximas ocorrências do dia da semana
        const maxDays = weeksAhead * 7 + 7; // margem extra
        for (let i = 1; i <= maxDays; i++) {
            const data = new Date(hoje);
            data.setDate(data.getDate() + i);

            if (data.getDay() !== targetDay) continue;

            const dateStr = data.toISOString().split('T')[0];
            const slots = await verificarDisponibilidadeSimples(clinicId, doctorId, dateStr);

            if (slots.length > 0) {
                datasDisponiveis.push({
                    date: dateStr,
                    date_iso: dateStr,
                    formatted_date: formatDate(dateStr),
                    day_of_week: DIAS_SEMANA[data.getDay()],
                    slots_count: slots.length,
                    available_slots: slots,
                });
            }

            if (datasDisponiveis.length >= MAX_SLOTS_RETORNO) break;
        }

        if (datasDisponiveis.length === 0) {
            return {
                success: true,
                available_slots: [],
                doctor: doctor,
                weekday: weekday,
                message: `${doctor.name} não tem horários disponíveis nas próximas ${weeksAhead} semanas nas ${dayNamePt}s. Gostaria de tentar outro dia?`
            };
        }

        // Se encontrou apenas uma data, retornar os slots diretamente
        if (datasDisponiveis.length === 1) {
            const d = datasDisponiveis[0];
            const manha = d.available_slots.filter(s => parseInt(s.split(':')[0]) < 12);
            const tarde = d.available_slots.filter(s => { const h = parseInt(s.split(':')[0]); return h >= 12 && h < 18; });
            const noite = d.available_slots.filter(s => parseInt(s.split(':')[0]) >= 18);

            let mensagem = `Encontrei horários para ${doctor.name} na ${dayNamePt}:\n`;
            mensagem += `${d.day_of_week}, ${d.formatted_date}\n\n`;
            if (manha.length > 0) mensagem += `Manha: ${manha.join(', ')}\n`;
            if (tarde.length > 0) mensagem += `Tarde: ${tarde.join(', ')}\n`;
            if (noite.length > 0) mensagem += `Noite: ${noite.join(', ')}\n`;
            mensagem += `\nQual horário você prefere?`;

            return {
                success: true,
                message: mensagem,
                available_slots: d.available_slots,
                doctor: doctor,
                date: d.date,
                dates: datasDisponiveis,
                weekday: weekday,
            };
        }

        // Múltiplas datas encontradas
        let mensagem = `Encontrei as seguintes ${dayNamePt}s disponíveis para ${doctor.name}:\n\n`;
        datasDisponiveis.forEach((d, idx) => {
            mensagem += `${idx + 1}. ${d.day_of_week}, ${d.formatted_date} — ${d.slots_count} horários\n`;
        });
        mensagem += `\nQual data você prefere?`;

        return {
            success: true,
            message: mensagem,
            dates: datasDisponiveis,
            doctor: doctor,
            weekday: weekday,
        };

    } catch (error) {
        console.error('[BUG4-FIX] Erro ao verificar disponibilidade por dia da semana:', error);
        return { success: false, message: 'Erro ao verificar disponibilidade.', error: error.message };
    }
}


/**
 * Busca próximas datas disponíveis para um médico
 * @param {string} clinicId - UUID da clínica
 * @param {string} doctorId - UUID do médico
 * @param {number} days - quantos dias verificar (padrão 14)
 * @param {number} profundidade - controle de recursão (uso interno)
 * @param {string|null} dataInicio - data de início da busca no formato YYYY-MM-DD (padrão: hoje)
 */
export async function buscarProximasDatasDisponiveis(clinicId, doctorId, days = 14, profundidade = 0, dataInicio = null) {
    // FIX 2: Condição de saída para evitar recursão infinita
    if (profundidade >= MAX_RECURSION_DEPTH) {
        console.warn(`[Scheduling] buscarProximasDatasDisponiveis atingiu MAX_RECURSION_DEPTH (${MAX_RECURSION_DEPTH}) — abortando`);
        return { success: true, message: 'Não encontrei disponibilidade no momento.', dates: [] };
    }

    try {
        const datasDisponiveis = [];
        // Se dataInicio for fornecida, buscar a partir dela; senão, a partir de hoje
        const baseDate = dataInicio ? new Date(dataInicio + 'T12:00:00') : new Date();
        const now = new Date(); // FIX v5.2: referência para filtrar horários passados

        // CORREÇÃO 1: Buscar o nome do médico para a mensagem
        let doctorName = null;
        let doctorSpecialty = null;
        try {
            const { data: doc } = await supabase
                .from('doctors')
                .select('name, specialty')
                .eq('id', doctorId)
                .eq('clinic_id', clinicId)
                .single();
            if (doc) {
                doctorName = `${doc.name} (${doc.specialty})`;
                doctorSpecialty = doc.specialty;
            }
        } catch { /* ignora erro — nome é opcional */ }

        for (let i = 0; i <= days; i++) {   // começa em 0 (inclui hoje se ainda há horários)
            const data = new Date(baseDate);
            data.setDate(data.getDate() + i);
            const dateStr = data.toISOString().split('T')[0];

            // USA A VERSÃO SIMPLES — sem fallback recursivo
            let slots = await verificarDisponibilidadeSimples(clinicId, doctorId, dateStr);

            // FIX v5.2: Filtrar horários que já passaram no dia atual
            const todayStr = now.toISOString().split('T')[0];
            if (dateStr === todayStr) {
                const currentHour = now.getHours();
                const currentMin = now.getMinutes();
                const currentTotalMin = currentHour * 60 + currentMin;
                slots = slots.filter(s => {
                    const [h, m] = s.split(':').map(Number);
                    return (h * 60 + m) > currentTotalMin; // só futuros
                });
            }

            if (slots.length > 0) {
                datasDisponiveis.push({
                    date: dateStr,
                    date_iso: dateStr,
                    formatted_date: formatDate(dateStr),
                    day_of_week: DIAS_SEMANA[getDayOfWeek(dateStr)],
                    slots_count: slots.length,
                    slots: slots // guardar todos para uso posterior
                });
            }

            if (datasDisponiveis.length >= MAX_SLOTS_RETORNO) break;
        }

        if (datasDisponiveis.length === 0) {
            return {
                success: true,
                message: `Não encontrei disponibilidade nos próximos ${days} dias.`,
                dates: []
            };
        }

        // FIX v5.2: Apresentação em DUAS ETAPAS — primeiro só os dias
        const nomeExibicao = doctorName || 'o médico selecionado';
        let mensagem = `📅 ${nomeExibicao} atende nos seguintes dias:\n\n`;
        datasDisponiveis.forEach((d, idx) => {
            mensagem += `${idx + 1}. ${d.day_of_week}, ${d.formatted_date} — ${d.slots_count} horários disponíveis\n`;
        });
        mensagem += `\nQual dia você prefere?`;

        return { success: true, message: mensagem, dates: datasDisponiveis };

    } catch (error) {
        console.error('Erro ao buscar datas:', error);
        return { success: false, message: 'Erro ao buscar datas.', error: error.message };
    }
}

/**
 * Obtém ou cria paciente na clínica
 * @param {string} clinicId - UUID da clínica (obrigatório para isolamento multi-tenant)
 * @param {string} phone - telefone do paciente
 * @param {string|null} name - nome do paciente (necessário para criação)
 */
export async function obterOuCriarPaciente(clinicId, phone, name = null) {
    try {
        const phoneNormalized = phone.replace(/\D/g, '');

        const { data: existingPatient } = await supabase
            .from('patients')
            .select('*')
            .eq('clinic_id', clinicId)
            .eq('phone', phoneNormalized)
            .maybeSingle();

        if (existingPatient) {
            return { success: true, patient: existingPatient, isNew: false };
        }

        if (name) {
            const { data: newPatient, error } = await supabase
                .from('patients')
                .insert({ clinic_id: clinicId, phone: phoneNormalized, name: name })
                .select()
                .single();

            if (error) throw error;
            return { success: true, patient: newPatient, isNew: true };
        }

        return {
            success: false,
            needsRegistration: true,
            message: 'Para agendar, preciso do seu nome completo. Como você se chama?'
        };

    } catch (error) {
        console.error('Erro ao obter/criar paciente:', error);
        return { success: false, message: 'Erro ao processar cadastro.', error: error.message };
    }
}

/**
 * Cria agendamento na clínica
 */
export async function criarAgendamento(params) {
    const { clinicId, patientPhone, patientName, doctorId, serviceId, date, time, notes = null } = params;

    try {
        // Obter/criar paciente (vinculado à clínica)
        const patientResult = await obterOuCriarPaciente(clinicId, patientPhone, patientName);
        if (!patientResult.success) return patientResult;

        const patient = patientResult.patient;

        // Verificar disponibilidade real (double-check para evitar race condition)
        const disponibilidade = await verificarDisponibilidade(clinicId, doctorId, date);
        if (!disponibilidade.success || !disponibilidade.available_slots?.includes(time)) {
            return {
                success: false,
                message: 'Este horário não está mais disponível. Por favor, escolha outro.'
            };
        }

        // Buscar serviço — se serviceId não foi fornecido, usar o primeiro serviço do médico
        let service;
        if (serviceId) {
            const { data, error: serviceError } = await supabase
                .from('services')
                .select('*')
                .eq('id', serviceId)
                .eq('clinic_id', clinicId)
                .single();
            if (serviceError || !data) {
                return { success: false, message: 'Serviço não encontrado.' };
            }
            service = data;
        } else {
            // Fallback: primeiro serviço do médico
            const { data: doctorServices } = await supabase
                .from('doctor_services')
                .select('services(*)')
                .eq('doctor_id', doctorId)
                .eq('clinic_id', clinicId)
                .limit(1);
            service = doctorServices?.[0]?.services;

            if (!service) {
                // Fallback genérico: qualquer serviço ativo da clínica
                const { data: genericService } = await supabase
                    .from('services')
                    .select('*')
                    .eq('clinic_id', clinicId)
                    .eq('active', true)
                    .limit(1)
                    .single();
                service = genericService;
            }

            if (!service) {
                return { success: false, message: 'Não encontrei nenhum serviço disponível para este médico.' };
            }
            console.log(`[Scheduling] serviceId não fornecido — usando serviço fallback: "${service.name}"`);
        }

        // Calcular horário de término
        const [hours, minutes] = time.split(':').map(Number);
        const endDate = new Date(2000, 0, 1, hours, minutes);
        endDate.setMinutes(endDate.getMinutes() + service.duration_minutes);
        const endTime = `${endDate.getHours().toString().padStart(2, '0')}:${endDate.getMinutes().toString().padStart(2, '0')}`;

        // Criar agendamento (incluindo clinic_id para multi-tenância)
        const { data: appointment, error: createError } = await supabase
            .from('appointments')
            .insert({
                clinic_id: clinicId,
                patient_id: patient.id,
                doctor_id: doctorId,
                service_id: service.id,
                appointment_date: date,
                start_time: time,
                end_time: endTime,
                status: 'scheduled',
                price: service.price,
                notes: notes,
                created_by: 'whatsapp'
            })
            .select(`
                *,
                doctors (name, specialty),
                services (name, price, duration_minutes),
                patients (name, phone)
            `)
            .single();

        if (createError) {
            if (createError.code === '23505') {
                return { success: false, message: 'Este horário acabou de ser reservado.' };
            }
            throw createError;
        }

        await invalidateSlotsCache(clinicId, doctorId, date);
        console.log(`[Scheduling] Cache invalidado para ${doctorId} em ${date} após novo agendamento`);

        const mensagem = `
✅ **Agendamento Confirmado!**

📋 **Detalhes:**
👤 Paciente: ${patient.name}
👨‍⚕️ Profissional: ${appointment.doctors.name}
📌 Serviço: ${appointment.services.name}
📅 Data: ${formatDate(date)} (${DIAS_SEMANA[getDayOfWeek(date)]})
⏰ Horário: ${formatTime(time)} às ${formatTime(endTime)}
💰 Valor: ${formatCurrency(service.price)}

⚠️ **Importante:**
• Chegue com 10 minutos de antecedência
• Em caso de cancelamento, avise com 24h de antecedência

Posso ajudar com mais alguma coisa?
        `.trim();

        return { success: true, message: mensagem, appointment: appointment };

    } catch (error) {
        console.error('Erro ao criar agendamento:', error);
        return { success: false, message: 'Erro ao criar agendamento.', error: error.message };
    }
}

/**
 * Lista agendamentos do paciente
 * @param {string} clinicId - UUID da clínica
 * @param {string} patientPhone - telefone do paciente
 * @param {string|null} status - filtro de status opcional
 */
export async function listarAgendamentosPaciente(clinicId, patientPhone, status = null) {
    try {
        const phoneNormalized = patientPhone.replace(/\D/g, '');

        const { data: patient } = await supabase
            .from('patients')
            .select('id, name')
            .eq('clinic_id', clinicId)
            .eq('phone', phoneNormalized)
            .maybeSingle();

        if (!patient) {
            return { success: true, message: 'Você ainda não tem agendamentos.', appointments: [] };
        }

        let query = supabase
            .from('appointments')
            .select(`
                *,
                doctors (name, specialty),
                services (name, price)
            `)
            .eq('clinic_id', clinicId)
            .eq('patient_id', patient.id)
            .gte('appointment_date', new Date().toISOString().split('T')[0])
            .order('appointment_date', { ascending: true })
            .order('start_time', { ascending: true });

        if (status) {
            query = query.eq('status', status);
        } else {
            query = query.not('status', 'in', '("cancelled","no_show","completed")');
        }

        const { data: appointments, error } = await query;
        if (error) throw error;

        if (!appointments || appointments.length === 0) {
            return { success: true, message: 'Você não tem consultas agendadas.', appointments: [] };
        }

        let mensagem = `📋 **Suas Consultas:**\n\n`;
        appointments.forEach((apt, idx) => {
            mensagem += `${idx + 1}. **${apt.services.name}**\n`;
            mensagem += `   👨‍⚕️ ${apt.doctors.name}\n`;
            mensagem += `   📅 ${formatDate(apt.appointment_date)} às ${formatTime(apt.start_time)}\n`;
            mensagem += `   📌 ${STATUS_LABELS[apt.status] || apt.status}\n\n`;
        });

        mensagem += `Para cancelar ou remarcar, me avise!`;

        return { success: true, message: mensagem, appointments: appointments, patient: patient };

    } catch (error) {
        console.error('Erro ao listar agendamentos:', error);
        return { success: false, message: 'Erro ao buscar agendamentos.', error: error.message };
    }
}

/**
 * Cancela agendamento
 * @param {string} clinicId - UUID da clínica (valida que o agendamento pertence a esta clínica)
 * @param {string} appointmentId - UUID do agendamento
 * @param {string|null} reason - motivo do cancelamento
 * @param {string} cancelledBy - quem cancelou ('patient' ou 'admin')
 */
export async function cancelarAgendamento(clinicId, appointmentId, reason = null, cancelledBy = 'patient') {
    try {
        const { data: appointment, error: fetchError } = await supabase
            .from('appointments')
            .select(`
                *,
                doctors (name),
                services (name),
                patients (name, phone)
            `)
            .eq('id', appointmentId)
            .eq('clinic_id', clinicId)
            .single();

        if (fetchError || !appointment) {
            return { success: false, message: 'Agendamento não encontrado.' };
        }

        if (appointment.status === 'cancelled') {
            return { success: false, message: 'Este agendamento já foi cancelado.' };
        }

        if (appointment.status === 'completed') {
            return { success: false, message: 'Não é possível cancelar consulta já realizada.' };
        }

        await supabase
            .from('appointments')
            .update({
                status: 'cancelled',
                cancellation_reason: reason,
                cancelled_by: cancelledBy
            })
            .eq('id', appointmentId)
            .eq('clinic_id', clinicId);

        await invalidateSlotsCache(clinicId, appointment.doctor_id, appointment.appointment_date);

        const mensagem = `
❌ **Agendamento Cancelado**

👨‍⚕️ ${appointment.doctors.name}
📌 ${appointment.services.name}
📅 ${formatDate(appointment.appointment_date)} às ${formatTime(appointment.start_time)}
${reason ? `\n📝 Motivo: ${reason}` : ''}

Se desejar reagendar, é só me avisar!
        `.trim();

        return { success: true, message: mensagem, appointment: appointment };

    } catch (error) {
        console.error('Erro ao cancelar:', error);
        return { success: false, message: 'Erro ao cancelar.', error: error.message };
    }
}

// ============================================================
// PRIORIDADE 4 — Motor de Alternativas (find_alternatives)
// Quando não há disponibilidade, oferecer opções reais ao paciente.
// ============================================================

/**
 * Busca alternativas quando não há disponibilidade:
 * Opção 1: Próxima data disponível com o mesmo médico (próximos 14 dias)
 * Opção 2: Outros médicos da mesma especialidade com disponibilidade na data solicitada
 * @param {string} clinicId - UUID da clínica
 * @param {string} doctorId - UUID do médico solicitado
 * @param {string} date - data solicitada (YYYY-MM-DD)
 */
export async function buscarAlternativas(clinicId, doctorId, date) {
    try {
        const alternativas = {
            success: true,
            proxima_data_mesmo_medico: null,
            outros_medicos_mesma_especialidade: [],
            message: ''
        };

        // Buscar dados do médico solicitado
        const { data: doctor, error: doctorError } = await supabase
            .from('doctors')
            .select('id, name, specialty')
            .eq('id', doctorId)
            .eq('clinic_id', clinicId)
            .single();

        if (doctorError || !doctor) {
            return { success: false, message: 'Médico não encontrado.' };
        }

        // -------------------------------------------------------
        // Opção 1: Próxima data disponível com o mesmo médico
        // -------------------------------------------------------
        const proximasDatas = await buscarProximasDatasDisponiveis(clinicId, doctorId, 14, 0, date);
        if (proximasDatas.success && proximasDatas.dates && proximasDatas.dates.length > 0) {
            alternativas.proxima_data_mesmo_medico = proximasDatas.dates[0];
        }

        // -------------------------------------------------------
        // Opção 2: Outros médicos da mesma especialidade com vaga na data solicitada
        // -------------------------------------------------------
        if (doctor.specialty && date) {
            const { data: outrosMedicos } = await supabase
                .from('doctors')
                .select('id, name, specialty')
                .eq('clinic_id', clinicId)
                .eq('specialty', doctor.specialty)
                .eq('active', true)
                .neq('id', doctorId); // excluir o médico original

            if (outrosMedicos && outrosMedicos.length > 0) {
                for (const outroMedico of outrosMedicos) {
                    const slots = await verificarDisponibilidadeSimples(clinicId, outroMedico.id, date);
                    if (slots.length > 0) {
                        alternativas.outros_medicos_mesma_especialidade.push({
                            doctor_id: outroMedico.id,
                            doctor_name: outroMedico.name,
                            specialty: outroMedico.specialty,
                            date: date,
                            formatted_date: formatDate(date),
                            available_slots: slots,
                            slots_count: slots.length
                        });
                    }
                    // Limitar a 2 médicos alternativos
                    if (alternativas.outros_medicos_mesma_especialidade.length >= 2) break;
                }
            }
        }

        // -------------------------------------------------------
        // Montar mensagem de resposta
        // -------------------------------------------------------
        const temAlternativas = alternativas.proxima_data_mesmo_medico ||
            alternativas.outros_medicos_mesma_especialidade.length > 0;

        if (!temAlternativas) {
            alternativas.message = `Não encontrei alternativas disponíveis para ${doctor.name} nos próximos 14 dias nem outros médicos de ${doctor.specialty} com vaga em ${formatDate(date)}.`;
            return alternativas;
        }

        let msg = `Não há horários para ${doctor.name} em ${formatDate(date)}, mas encontrei estas alternativas:\n\n`;

        if (alternativas.proxima_data_mesmo_medico) {
            const d = alternativas.proxima_data_mesmo_medico;
            msg += `📅 **${doctor.name}** tem vaga em: ${d.day_of_week}, ${d.formatted_date} (${d.slots_count} horários)\n`;
        }

        if (alternativas.outros_medicos_mesma_especialidade.length > 0) {
            for (const alt of alternativas.outros_medicos_mesma_especialidade) {
                const primeirosSlots = alt.available_slots.slice(0, 3).join(', ');
                msg += `👨‍⚕️ **${alt.doctor_name}** (${alt.specialty}) tem vaga em ${alt.formatted_date} às: ${primeirosSlots}\n`;
            }
        }

        msg += `\nQual opção você prefere?`;
        alternativas.message = msg;

        return alternativas;

    } catch (error) {
        console.error('[P4] Erro ao buscar alternativas:', error);
        return { success: false, message: 'Erro ao buscar alternativas.', error: error.message };
    }
}

/**
 * Confirma presença em agendamento
 * @param {string} clinicId - UUID da clínica
 * @param {string} appointmentId - UUID do agendamento
 */
export async function confirmarAgendamento(clinicId, appointmentId) {
    try {
        const { data: appointment, error } = await supabase
            .from('appointments')
            .update({ status: 'confirmed' })
            .eq('id', appointmentId)
            .eq('clinic_id', clinicId)
            .eq('status', 'scheduled')
            .select(`*, doctors (name), services (name)`)
            .single();

        if (error || !appointment) {
            return { success: false, message: 'Não foi possível confirmar.' };
        }

        return {
            success: true,
            message: `✅ Presença confirmada para ${formatDate(appointment.appointment_date)} às ${formatTime(appointment.start_time)}!`,
            appointment: appointment
        };

    } catch (error) {
        console.error('Erro ao confirmar:', error);
        return { success: false, message: 'Erro ao confirmar.', error: error.message };
    }
}
