// tools/schedulingTools.js
// ============================================================
// TOOLS DE AGENDAMENTO PARA O AGENTE - ES MODULES
// ============================================================

import * as schedulingService from '../services/schedulingService.js';

// ============================================================
// DEFINIÇÕES DAS TOOLS (para adicionar ao array tools do seu server.js)
// ============================================================

export const schedulingToolsDefinitions = [
    {
        type: 'function',
        function: {
            name: 'listar_medicos',
            strict: false,
            description: 'Lista todos os médicos e profissionais disponíveis na clínica. Use quando o paciente perguntar sobre médicos, especialidades, ou quiser saber quem atende.',
            parameters: {
                type: 'object',
                properties: {
                    especialidade: {
                        type: 'string',
                        description: 'Filtrar por especialidade (ex: "dermatologia"). Deixe vazio para listar todos.'
                    }
                },
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'listar_servicos',
            strict: false,
            description: 'Lista os serviços/procedimentos disponíveis com preços e duração. Use quando perguntar sobre procedimentos, tratamentos ou preços.',
            parameters: {
                type: 'object',
                properties: {
                    doctor_id: {
                        type: 'string',
                        description: 'ID do médico para filtrar serviços específicos dele.'
                    }
                },
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'verificar_disponibilidade',
            strict: false,
            // BUG 4 FIX: Suporte a 3 modos de operação
            description: 'Verifica horários disponíveis de um médico. Suporta 3 modos:\n' +
                '1) Data específica: use campo "data" (YYYY-MM-DD)\n' +
                '2) Próximas disponibilidades: use "find_next: true" com "days_ahead" (padrão 14)\n' +
                '3) Por dia da semana: use "weekday" ("monday","tuesday","wednesday","thursday","friday","saturday") com "weeks_ahead" (padrão 2)\n' +
                'Use modo 2 ou 3 quando o paciente perguntar "que dia tem vaga?" ou "prefiro sexta".',
            parameters: {
                type: 'object',
                properties: {
                    doctor_id: {
                        type: 'string',
                        description: 'ID do médico (obrigatório)'
                    },
                    data: {
                        type: 'string',
                        description: 'Data no formato YYYY-MM-DD (ex: "2025-02-25"). Usar no Modo 1.'
                    },
                    find_next: {
                        type: 'boolean',
                        description: 'Se true, busca as próximas datas disponíveis (Modo 2). Não requer "data".'
                    },
                    days_ahead: {
                        type: 'number',
                        description: 'Quantos dias à frente buscar no Modo 2 (padrão: 14)'
                    },
                    weekday: {
                        type: 'string',
                        enum: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'],
                        description: 'Dia da semana para buscar (Modo 3). Ex: "friday" para sexta-feira.'
                    },
                    weeks_ahead: {
                        type: 'number',
                        description: 'Quantas semanas à frente buscar no Modo 3 (padrão: 2)'
                    }
                },
                required: ['doctor_id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'buscar_proximas_datas',
            strict: false,
            description: 'Busca próximas datas com horários disponíveis para um médico. Use quando o paciente não tem data específica.',
            parameters: {
                type: 'object',
                properties: {
                    doctor_id: {
                        type: 'string',
                        description: 'ID do médico (obrigatório)'
                    },
                    dias: {
                        type: 'number',
                        description: 'Quantos dias buscar (padrão: 14)'
                    }
                },
                required: ['doctor_id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'criar_agendamento',
            strict: false,
            description: 'Cria um novo agendamento. Use APENAS quando tiver TODAS as informações confirmadas pelo paciente.',
            parameters: {
                type: 'object',
                properties: {
                    patient_phone: {
                        type: 'string',
                        description: 'Telefone do paciente'
                    },
                    patient_name: {
                        type: 'string',
                        description: 'Nome completo do paciente'
                    },
                    doctor_id: {
                        type: 'string',
                        description: 'ID do médico'
                    },
                    service_id: {
                        type: 'string',
                        description: 'ID do serviço'
                    },
                    data: {
                        type: 'string',
                        description: 'Data (YYYY-MM-DD)'
                    },
                    horario: {
                        type: 'string',
                        description: 'Horário (HH:MM)'
                    },
                    observacoes: {
                        type: 'string',
                        description: 'Observações (opcional)'
                    }
                },
                required: ['patient_phone', 'patient_name', 'doctor_id', 'service_id', 'data', 'horario']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'listar_meus_agendamentos',
            strict: false,
            description: 'Lista os agendamentos futuros do paciente.',
            parameters: {
                type: 'object',
                properties: {
                    patient_phone: {
                        type: 'string',
                        description: 'Telefone do paciente'
                    }
                },
                required: ['patient_phone']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'cancelar_agendamento',
            strict: false,
            description: 'Cancela um agendamento existente.',
            parameters: {
                type: 'object',
                properties: {
                    appointment_id: {
                        type: 'string',
                        description: 'ID do agendamento'
                    },
                    motivo: {
                        type: 'string',
                        description: 'Motivo do cancelamento'
                    }
                },
                required: ['appointment_id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'confirmar_presenca',
            strict: false,
            description: 'Confirma presença em um agendamento.',
            parameters: {
                type: 'object',
                properties: {
                    appointment_id: {
                        type: 'string',
                        description: 'ID do agendamento'
                    }
                },
                required: ['appointment_id']
            }
        }
    }
];

// ============================================================
// EXECUTOR DAS TOOLS
// ============================================================

export async function executeSchedulingTool(toolName, args, context = {}) {
    console.log(`[SchedulingTools] Executando: ${toolName}`, args);

    const clinicId = context.clinicId;
    if (!clinicId) {
        console.error('[SchedulingTools] clinicId ausente no context — abortando tool');
        return { success: false, message: 'Configuração interna inválida (clinic_id ausente).' };
    }

    try {
        switch (toolName) {
            case 'listar_medicos':
                return await schedulingService.listarMedicos(clinicId, args.especialidade);

            case 'listar_servicos':
                return await schedulingService.listarServicos(clinicId, args.doctor_id);

            case 'verificar_disponibilidade':
                // BUG 4 FIX: Suporte a 3 modos de operação
                if (args.find_next === true) {
                    // Modo 2: Próximas disponibilidades
                    console.log(`[BUG4-FIX] Modo 2 (find_next): buscando próximas ${args.days_ahead || 14} datas`);
                    return await schedulingService.buscarProximasDatasDisponiveis(
                        clinicId,
                        args.doctor_id,
                        args.days_ahead || 14,
                        0,
                        null
                    );
                } else if (args.weekday) {
                    // Modo 3: Por dia da semana
                    console.log(`[BUG4-FIX] Modo 3 (weekday): buscando ${args.weekday} nas próximas ${args.weeks_ahead || 2} semanas`);
                    return await schedulingService.verificarDisponibilidadePorDiaSemana(
                        clinicId,
                        args.doctor_id,
                        args.weekday,
                        args.weeks_ahead || 2
                    );
                } else {
                    // Modo 1: Data específica (comportamento original)
                    if (!args.data) {
                        console.warn('[BUG4-FIX] verificar_disponibilidade chamada sem data, find_next ou weekday — retornando erro claro');
                        return {
                            success: false,
                            error: 'data_required',
                            message: 'Para verificar disponibilidade, informe: (1) uma data específica em YYYY-MM-DD, (2) find_next=true para próximas datas, ou (3) weekday com o dia da semana preferido.'
                        };
                    }
                    return await schedulingService.verificarDisponibilidade(clinicId, args.doctor_id, args.data);
                }

            case 'buscar_proximas_datas':
                // FIX-FALLBACK: Suporte a data_inicio para buscar a partir de uma data específica
                return await schedulingService.buscarProximasDatasDisponiveis(
                    clinicId,
                    args.doctor_id,
                    args.dias || 14,
                    0,                    // profundidade inicial
                    args.data_inicio || null  // data de início da busca (null = hoje)
                );

            case 'criar_agendamento':
                return await schedulingService.criarAgendamento({
                    clinicId: clinicId,
                    patientPhone: args.patient_phone || context.userPhone,
                    patientName: args.patient_name,
                    doctorId: args.doctor_id,
                    serviceId: args.service_id,
                    date: args.data,
                    time: args.horario,
                    notes: args.observacoes
                });

            case 'listar_meus_agendamentos':
                return await schedulingService.listarAgendamentosPaciente(
                    clinicId,
                    args.patient_phone || context.userPhone
                );

            case 'cancelar_agendamento':
                return await schedulingService.cancelarAgendamento(clinicId, args.appointment_id, args.motivo, 'patient');

            case 'confirmar_presenca':
                return await schedulingService.confirmarAgendamento(clinicId, args.appointment_id);

            default:
                return { success: false, message: `Tool desconhecida: ${toolName}` };
        }
    } catch (error) {
        console.error(`[SchedulingTools] Erro em ${toolName}:`, error);
        return { success: false, message: 'Erro ao processar solicitação.', error: error.message };
    }
}

// Lista de nomes das tools de agendamento
export const SCHEDULING_TOOL_NAMES = [
    'listar_medicos',
    'listar_servicos', 
    'verificar_disponibilidade',
    'buscar_proximas_datas',
    'criar_agendamento',
    'listar_meus_agendamentos',
    'cancelar_agendamento',
    'confirmar_presenca'
];

export function isSchedulingTool(toolName) {
    return SCHEDULING_TOOL_NAMES.includes(toolName);
}
