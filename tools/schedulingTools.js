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
            description: 'Verifica horários disponíveis de um médico em uma data específica.',
            parameters: {
                type: 'object',
                properties: {
                    doctor_id: {
                        type: 'string',
                        description: 'ID do médico (obrigatório)'
                    },
                    data: {
                        type: 'string',
                        description: 'Data no formato YYYY-MM-DD (ex: "2025-02-25")'
                    }
                },
                required: ['doctor_id', 'data']
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
    
    try {
        switch (toolName) {
            case 'listar_medicos':
                return await schedulingService.listarMedicos(args.especialidade);
            
            case 'listar_servicos':
                return await schedulingService.listarServicos(args.doctor_id);
            
            case 'verificar_disponibilidade':
                return await schedulingService.verificarDisponibilidade(args.doctor_id, args.data);
            
            case 'buscar_proximas_datas':
                return await schedulingService.buscarProximasDatasDisponiveis(args.doctor_id, args.dias || 14);
            
            case 'criar_agendamento':
                return await schedulingService.criarAgendamento({
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
                    args.patient_phone || context.userPhone
                );
            
            case 'cancelar_agendamento':
                return await schedulingService.cancelarAgendamento(args.appointment_id, args.motivo, 'patient');
            
            case 'confirmar_presenca':
                return await schedulingService.confirmarAgendamento(args.appointment_id);
            
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
