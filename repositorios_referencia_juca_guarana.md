# Repositórios de Referência — Análise Comparativa para o Sistema JUCA GUARANÁ

**Objetivo:** Documentar 3 repositórios reais de agentes conversacionais de agendamento para análise comparativa com o sistema JUCA GUARANÁ.

**Data da pesquisa:** 02 de março de 2026

---

## Repositório 1 — langgraph-whatsapp-bot

**URL:** [https://github.com/GreatHayat/langgraph-whatsapp-bot](https://github.com/GreatHayat/langgraph-whatsapp-bot)

**Stack:**

| Campo | Detalhe |
|---|---|
| Linguagem principal | Python 3.x |
| Framework do agente | LangGraph + LangChain |
| Canal de mensageria | WhatsApp Business Cloud API (Meta) |
| Banco de dados | Nenhum (estado em memória via `InMemorySaver` do LangGraph) |
| LLM utilizado | GPT-4o-mini (OpenAI) + Groq (STT via Whisper) |

**Última atividade:** 04 de junho de 2025 | **Stars:** 15 / **Forks:** 4

**Funcionalidades de agendamento identificadas:**

- Verificação de disponibilidade por data — **Sim** (via `get_today_events` e `get_week_events` no Google Calendar)
- Verificação por dia da semana / período — **Sim** (busca da semana corrente, pula fins de semana automaticamente)
- Listagem de próximos horários disponíveis — **Parcial** (lista eventos existentes, não calcula slots livres explicitamente)
- Identificação de profissional por especialidade/nome — **Não** (domínio fixo: dentista)
- Confirmação e cancelamento — **Parcial** (cria eventos; cancelamento não implementado)
- Notificação de lembrete — **Não**
- Outros: Transcrição de áudio via Whisper (Groq); envio de convite por e-mail ao criar evento

**Gestão de estado da conversa:**

O estado é mantido em memória através do `InMemorySaver` do LangGraph, indexado pelo `thread_id` igual ao `wa_id` (número WhatsApp do usuário). O `StateGraph` define um `TypedDict` chamado `State` com dois campos: `type` (text ou audio) e `messages` (lista de mensagens com acumulação via `add_messages`). Cada requisição ao webhook `/webhook` invoca o grafo com o `thread_id` do contato, recuperando o histórico da sessão em memória. **Limitação crítica:** o estado é volátil — reiniciar o servidor apaga todo o histórico de conversas.

**Lógica de disponibilidade:**

O sistema usa três ferramentas LangChain decoradas com `@tool` que fazem chamadas reais à Google Calendar API via OAuth2:

- `get_today_events()` — lista eventos do dia atual
- `get_week_events()` — lista eventos da semana de trabalho corrente (seg–sex), pulando fins de semana
- `create_event(start_time, end_time, user_name, user_email)` — cria evento com convidado

A lógica **não verifica conflitos explicitamente** — o LLM decide com base nos eventos listados se um horário está disponível. A verificação de disponibilidade é, portanto, **inferencial** (o LLM raciocina sobre os eventos existentes) e não determinística.

**Deduplicação / proteção contra mensagens duplas:**

**Não implementada.** O webhook `/webhook` (POST) processa qualquer requisição recebida sem verificar `message_id` ou timestamp. Não há controle de idempotência, o que pode causar agendamentos duplicados em caso de retentativas do Meta.

**Tratamento de linguagem natural de datas:**

**Sim, via LLM.** O `appointment_system_prompt` instrui o GPT-4o-mini a interpretar expressões como "amanhã", "sexta-feira", "semana que vem" e convertê-las para o formato `YYYY-MM-DDTHH:MM:SS` antes de chamar `create_event`. O modelo recebe o contexto de data atual implicitamente pelo histórico de mensagens. Não há parser de datas dedicado (ex: `dateparser`).

**Pontos fortes observados:**

- Arquitetura de grafo com LangGraph bem estruturada, com nós distintos para roteamento, processamento de áudio e chatbot, facilitando extensibilidade
- Suporte nativo a mensagens de áudio via transcrição Whisper (Groq), funcionalidade relevante para o contexto de WhatsApp
- Integração real com Google Calendar API (não mock), com autenticação OAuth2 funcional
- Uso do `thread_id = wa_id` para isolamento de sessão por usuário, padrão correto para multi-usuário

**Pontos fracos ou ausências:**

- Estado em memória (`InMemorySaver`) sem persistência — reinicialização do servidor apaga todo o histórico de conversas
- Ausência de verificação determinística de conflitos de horário — o LLM pode agendar sobre eventos existentes
- Domínio fixo (dentista) com um único profissional — sem suporte a multi-tenant ou múltiplos prestadores
- Nenhuma proteção contra mensagens duplicadas (deduplicação por `message_id`)

**Arquivo(s) mais relevante(s) para análise:**

- `agent.py` — definição do grafo LangGraph, nós e lógica de roteamento
- `tools/google_calender.py` — ferramentas de calendário (verificação e criação de eventos)
- `main.py` — webhook FastAPI e integração com WhatsApp Cloud API
- `utils/prompts.py` — system prompt do agente de agendamento

---

## Repositório 2 — calibot

**URL:** [https://github.com/mallahyari/calibot](https://github.com/mallahyari/calibot)

**Stack:**

| Campo | Detalhe |
|---|---|
| Linguagem principal | Python 3.10+ |
| Framework do agente | FastAPI + LiteLLM (sem LangGraph) |
| Canal de mensageria | Telegram (python-telegram-bot) |
| Banco de dados | Arquivo local `token.pickle` (credenciais OAuth) — sem DB para conversas |
| LLM utilizado | GPT-4o (OpenAI), via LiteLLM (`acompletion`) |

**Última atividade:** 05 de março de 2025 | **Stars:** 44 / **Forks:** 8

**Funcionalidades de agendamento identificadas:**

- Verificação de disponibilidade por data — **Sim** (via `query_events` com `timeMin`/`timeMax` no Google Calendar)
- Verificação por dia da semana / período — **Parcial** (o NLP Agent extrai datas relativas; a API do Calendar filtra por range)
- Listagem de próximos horários disponíveis — **Parcial** (lista eventos existentes no dia; não calcula slots livres)
- Identificação de profissional por especialidade/nome — **Não** (calendário pessoal único por usuário)
- Confirmação e cancelamento — **Sim** (CRUD completo: `create_event`, `update_event`, `delete_event`)
- Notificação de lembrete — **Não**
- Outros: Detecção de relevância da mensagem (small talk vs. intenção de calendário) antes de processar

**Gestão de estado da conversa:**

O histórico de conversa é mantido em uma lista Python em memória (`conversation_history`), gerenciada pelo serviço `ConversationService`. Cada usuário do Telegram tem seu histórico isolado pelo `chat_id`. O histórico é passado diretamente no prompt do LLM a cada chamada, implementando o padrão de **memória de janela deslizante no prompt**. Não há persistência em banco de dados — o histórico é perdido ao reiniciar o servidor. O sistema implementa dois níveis de processamento: primeiro verifica se a mensagem é relevante ao calendário (`is_relevant_to_calendar`), e só então extrai a intenção (`extract_intent`).

**Lógica de disponibilidade:**

O sistema usa a Google Calendar API diretamente via `GoogleCalendarService`:

- `query_events(query_params)` — busca eventos por data (`timeMin`/`timeMax`) retornando lista de eventos existentes
- `create_event(event_data)` — cria evento com `summary`, `start`, `end`, `description` e `attendees`
- `update_event(event_id, event_data)` — atualiza evento existente
- `delete_event(event_id)` — remove evento

A verificação de disponibilidade é **indireta**: o sistema lista os eventos do dia e o LLM infere se o horário solicitado está livre. **Não há verificação de conflito programática** — o `create_event` não checa sobreposição antes de inserir.

**Deduplicação / proteção contra mensagens duplas:**

**Não implementada explicitamente.** O webhook do Telegram processa cada update recebido sem verificar `update_id` para deduplicação. O `python-telegram-bot` tem mecanismo interno de offset, mas não há lógica de idempotência na camada de aplicação.

**Tratamento de linguagem natural de datas:**

**Sim, via LLM com structured output.** O `NLPAgent.extract_intent()` usa GPT-4o com `response_format={"type": "json_object"}` para extrair campos estruturados incluindo `date` (formato `YYYY-MM-DD`), `start_time` e `end_time`. O system prompt inclui a data/hora atual (`current_datetime`) para que o modelo resolva expressões relativas como "amanhã", "próxima segunda", "daqui a 2 horas". A saída é validada como JSON antes de ser usada.

**Pontos fortes observados:**

- Arquitetura bem separada em camadas (`agent/`, `services/`, `api/`, `utils/`), com responsabilidades claras e código legível
- CRUD completo de eventos no Google Calendar (criar, atualizar, deletar, consultar), o conjunto mais completo entre os 3 repositórios analisados
- Detecção de relevância antes do processamento (small talk vs. calendário) reduz chamadas desnecessárias ao LLM e melhora a experiência
- Uso de `response_format=json_object` para extração estruturada de intenção, tornando o parsing de datas mais confiável

**Pontos fracos ou ausências:**

- Canal Telegram — não é WhatsApp, exigindo adaptação significativa para o contexto do JUCA GUARANÁ
- Ausência de verificação de conflito programática antes da criação de eventos
- Estado em memória sem persistência — histórico perdido ao reiniciar
- Sem suporte a múltiplos profissionais ou multi-tenant; calendário pessoal único por usuário autenticado

**Arquivo(s) mais relevante(s) para análise:**

- `backend/app/agent/nlp_agent.py` — extração de intenção e verificação de relevância via LLM
- `backend/app/services/google_calendar.py` — CRUD completo de eventos no Google Calendar
- `backend/app/services/ai_service.py` — geração de resposta conversacional
- `backend/app/services/conversation.py` — gestão do histórico de conversa
- `backend/app/prompts.py` — system prompts do agente

---

## Repositório 3 — Meeting-Room-Booking-AI-Agent

**URL:** [https://github.com/theaifutureguy/Meeting-Room-Booking-AI-Agent](https://github.com/theaifutureguy/Meeting-Room-Booking-AI-Agent)

**Stack:**

| Campo | Detalhe |
|---|---|
| Linguagem principal | Python 3.x |
| Framework do agente | LangGraph + LangChain |
| Canal de mensageria | Interface web (Flask/HTML) — sem integração com mensageria |
| Banco de dados | Arquivos JSON locais (`bookings.json`, `rooms.json`) |
| LLM utilizado | Groq API (Llama 3 / Mixtral) |

**Última atividade:** 20 de junho de 2025 | **Stars:** 24 / **Forks:** 7

**Funcionalidades de agendamento identificadas:**

- Verificação de disponibilidade por data — **Sim** (`check_time_conflict_tool` com comparação de intervalos ISO 8601)
- Verificação por dia da semana / período — **Parcial** (via extração LLM de `start_date` e `duration_hours`)
- Listagem de próximos horários disponíveis — **Não** (apenas verifica conflito para o horário solicitado)
- Identificação de profissional por especialidade/nome — **Sim** (por equipamentos e capacidade da sala — análogo à especialidade)
- Confirmação e cancelamento — **Sim** (fluxo de confirmação explícito com nó `confirm_booking`)
- Notificação de lembrete — **Não**
- Outros: Motor de sugestão de alternativas (`search_alternative_rooms`) com scoring por similaridade de equipamentos

**Gestão de estado da conversa:**

O estado é gerenciado pelo `AgentState` (TypedDict do LangGraph), que persiste entre os nós do grafo durante uma sessão. O estado inclui: `user_input`, `messages` (histórico), `parsed_request`, `clarification_needed`, `matching_rooms`, `available_rooms`, `alternative_rooms`, `selected_room`, `user_confirmation` e `booking_result`. O grafo implementa **loops de clarificação dinâmicos** — se o pedido estiver incompleto, o nó `ask_clarification` é ativado e o fluxo retorna ao início após a resposta do usuário. O estado é mantido em memória durante a sessão; não há persistência entre sessões.

**Lógica de disponibilidade:**

O sistema implementa a lógica de disponibilidade **mais robusta e determinística** entre os 3 repositórios:

- `check_time_conflict_tool(existing_bookings, room_id, start_time, end_time)` — verifica sobreposição de intervalos com lógica `start_time < booking_end AND end_time > booking_start`, incluindo buffer de `DELAY`
- `find_matching_rooms_tool(existing_rooms, capacity, equipments)` — filtra salas por capacidade mínima e equipamentos requeridos
- `find_similar_rooms_tool(capacity, equipments, top_n=3)` — motor de fallback com scoring por sobreposição de equipamentos
- `book_room_tool(room_id, start_time, end_time, user_name)` — verifica conflito antes de persistir o agendamento

A verificação de conflito é **programática e determinística**, não dependendo do LLM para decidir disponibilidade.

**Deduplicação / proteção contra mensagens duplas:**

**Parcialmente implementada.** A função `book_room_tool` verifica conflito de horário antes de persistir, prevenindo duplo agendamento para o mesmo recurso no mesmo período. Contudo, não há controle de idempotência por `request_id` ou proteção contra submissões duplicadas da interface web.

**Tratamento de linguagem natural de datas:**

**Sim, via LLM com structured output (Pydantic).** O nó `parse_request` usa o LLM (Groq) para preencher o modelo `BookingRequest` (Pydantic) com campos como `start_date` (YYYY-MM-DD), `start_time` (HH:MM:SS AM/PM), `duration_hours` e `capacity`. O system prompt instrui o modelo a resolver expressões relativas como "amanhã", "daqui a 1 hora". O campo `clarification_needed` é definido pelo LLM quando a solicitação é ambígua, ativando o loop de clarificação.

**Pontos fortes observados:**

- Verificação de conflito de horário **programática e determinística** (`check_time_conflict_tool`), a mais robusta entre os repositórios analisados — diretamente aplicável ao JUCA GUARANÁ
- Fluxo de agendamento com múltiplos estados bem definidos no LangGraph: parse → find rooms → check availability → confirm → book, com transições condicionais explícitas
- Motor de sugestão de alternativas (`find_similar_rooms_tool`) com scoring por similaridade — padrão útil para sugerir outros médicos/especialidades quando o solicitado não está disponível
- Loop de clarificação dinâmico: o agente pede informações faltantes antes de prosseguir, evitando agendamentos com dados incompletos

**Pontos fracos ou ausências:**

- Sem integração com canal de mensageria (WhatsApp, Telegram) — apenas interface web, exigindo adaptação completa para o contexto do JUCA GUARANÁ
- Persistência em arquivos JSON locais — não escalável para produção multi-tenant
- Sem integração com calendário externo (Google Calendar, Outlook) — usa banco de dados próprio
- Código com algumas inconsistências (funções `get_room_reserved_time_slots` incompletas, comentários de código em `workflow.py`)

**Arquivo(s) mais relevante(s) para análise:**

- `src/booking_agent/workflow.py` — definição completa do grafo LangGraph com todos os nós e transições condicionais
- `src/booking_agent/nodes.py` — implementação de cada nó do fluxo (parse, find rooms, check availability, confirm, book)
- `src/mock_apis/booking_services.py` — lógica de verificação de conflito (`check_time_conflict_tool`) e criação de reserva
- `src/mock_apis/room_services.py` — busca de recursos por capacidade e equipamentos (análogo a busca por especialidade)
- `src/booking_agent/schemas.py` — definição do `AgentState` e modelo `BookingRequest` com validação Pydantic

---

## Conclusão

Entre os três repositórios analisados, o **Meeting-Room-Booking-AI-Agent** (`theaifutureguy`) é o mais maduro do ponto de vista da **arquitetura de agendamento**, por três razões principais.

Em primeiro lugar, é o único que implementa verificação de conflito de horário de forma **programática e determinística** (`check_time_conflict_tool`), sem depender do LLM para decidir se um horário está disponível — padrão crítico para um sistema de produção como o JUCA GUARANÁ, onde agendamentos duplicados têm impacto direto na operação clínica.

Em segundo lugar, o fluxo de estados do LangGraph é o mais completo e explícito: parse → clarificação → busca de recursos → verificação de disponibilidade → confirmação → reserva, com transições condicionais bem definidas e um motor de fallback para sugestão de alternativas. Esse padrão é diretamente aplicável ao fluxo do JUCA GUARANÁ (identificar médico → verificar disponibilidade → confirmar → agendar).

Em terceiro lugar, o loop de clarificação dinâmico — que solicita informações faltantes antes de prosseguir — é uma funcionalidade de produção que os outros dois repositórios não possuem de forma estruturada.

O **langgraph-whatsapp-bot** (`GreatHayat`) é o mais próximo do stack do JUCA GUARANÁ por usar WhatsApp e Google Calendar reais, sendo o melhor candidato para referência de **integração de canal**, mas carece de robustez na verificação de disponibilidade. O **calibot** (`mallahyari`) destaca-se pela **qualidade de código e separação de responsabilidades**, sendo a melhor referência para arquitetura de serviços e extração estruturada de intenção via LLM.

A recomendação para o JUCA GUARANÁ é adotar o **padrão de verificação de conflito determinística** do repositório 3, combinado com a **arquitetura de serviços** do repositório 2 e a **integração WhatsApp + Google Calendar** do repositório 1.
