# Matriz de homologação da versão 0.2.1

Definida antes da implementação dos testes. O aplicativo é desktop Windows; Chromium em dimensões compactas e emulação Pixel 7 validam layout, toque e acessibilidade, sem implicar suporte a app Android. A sandbox Linux não possui sessão gráfica Windows, OAuth interativo do cliente nem ferramentas nativas Windows. Essas limitações são registradas separadamente dos testes locais.

| Área            | Cenário e aceite                                                                                                                         | Evidência                                                          |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Caminho feliz   | Escolher projeto, entrar, descobrir modelos, iniciar conversa, receber deltas, Markdown e conclusão                                      | E2E Chromium + serviço com App Server simulado                     |
| Histórico       | Nova conversa e retomada no mesmo projeto sem misturar itens ou permissões                                                               | Unidade e E2E                                                      |
| Validações      | Mensagem vazia, projeto ausente, modelo inválido, modo Windows sem consentimento e argumentos inesperados recusados                      | Unidade e E2E                                                      |
| Aprovações      | Comando/arquivo recusado ou aceito; perguntas obrigatórias; request desconhecido recebe erro; aprovação resolvida/interrompida some      | Unidade e E2E                                                      |
| Falhas          | Timeout, processo encerrado, erro do turno e login; usuário pode reconectar; pedidos pendentes são liberados                             | Unidade e E2E                                                      |
| Corridas        | Deltas/conclusão antes da resposta `turn/start`; texto final autoritativo; eventos de outra conversa ignorados                           | Unidade                                                            |
| Integração      | App Server empacotado responde initialize, account/read e model/list com CODEX_HOME isolado, sem chamada paga                            | `npm run test:codex` local e CI                                    |
| Windows         | Parser PowerShell; listar janelas; foco, teclado, clique e screenshot com contratos simulados; instalador contém Codex e scripts nativos | Unidade local + `test:windows` e empacotamento Windows em CI       |
| Empacotamento   | Main, tags e PRs geram artefatos sem ativar publisher, solicitar token de release ou enviar arquivos                                     | CLI e evento de artefato do electron-builder real, com CI simulado |
| Observabilidade | Estado da conexão, comandos, diffs, plano e tokens visíveis; métricas apenas contadores locais; logs sem conteúdo/autenticação           | Unidade e E2E                                                      |
| Dados de teste  | Fake OAuth, projetos temporários, CODEX_HOME temporário, sem autenticação real nem automação real de desktop nos testes de navegador     | Fixtures e teste real de handshake                                 |
| Interface       | Painel único, rolagem, Enter/Shift+Enter, parar, foco e leitores de tela, Markdown sem HTML executável                                   | E2E Chromium                                                       |
| Dimensões       | 640×900, 390×844 (Pixel 7), 1280×800; sem overflow horizontal                                                                            | E2E e screenshots locais                                           |

## Controle autorizado do desktop

Matriz definida antes de executar as validações deste fluxo. Os doubles só retornam janelas e imagens sintéticas; nenhuma conta, janela ou captura do cliente é usada nos testes.

| Área               | Cenário e aceite                                                                                                                                                     | Evidência prevista                                                |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Autorização        | Botão Autorizar desktop visível no Windows; cancelar mantém conversa e modo; consentir inicia conversa Windows; revogar encerra esse acesso                          | E2E Chromium desktop/Pixel 7 + serviço                            |
| Capacidade         | Agente recebe o modo atual e orientação para autorizar; windows_desktop só é registrado em conversa Windows autorizada; retomada mantém política e tools             | Serviço + smoke com o Codex fixado e CODEX_HOME temporário        |
| Caminho feliz      | Listar janelas, capturar tela, focar, clicar, digitar texto literal, usar atalhos e rolar; cada operação aguarda aprovação e devolve seu resultado                   | Sequência bidirecional e dispatcher PowerShell com APIs simuladas |
| Validação e falhas | Argumentos inválidos, namespace/thread/turn incorretos, plataforma não Windows, recusa e falha do driver não executam ações indevidas nem prendem o agente           | Unidade do serviço/driver                                         |
| Recuperação        | Interromper libera pedidos; aprovação repetida não executa duas vezes; reconectar retoma a mesma conversa; nova conversa ou outro histórico exige novo consentimento | Unidade do serviço                                                |
| Privacidade        | Aprovação de captura explica envio ao ChatGPT; renderer não recebe pixels retornados ao agente; dados sintéticos, sem OAuth real                                     | Unidade + E2E                                                     |
| Observabilidade    | Aprovações descrevem operação e alvo; execução e resultado aparecem na conversa; erros contam nas métricas locais                                                    | Unidade + E2E                                                     |
| Windows nativo     | Parser e list_windows no CI Windows; foco, digitação, mouse e captura em sessão interativa continuam com homologação manual declarada                                | test:windows + instalador no job Windows                          |

O teste `test:desktop` abre uma janela Electron real e valida protocolo local, preload isolado, origem IPC e seleção de projeto. No Linux (Xvfb), também exercita login, conversa e aprovação por um processo simulado; no Windows usa o Codex real isolado, sem OAuth.

## Execução do controle sob política PowerShell restritiva

Matriz definida antes dos testes desta correção. A política é definida somente no processo filho que executa o script empacotado, após aprovação da operação. Os testes não alteram políticas persistentes nem usam as janelas do cliente.

| Área                   | Cenário e aceite                                                                                                                               | Evidência prevista                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Caminho feliz          | Driver de produção executa script sintético com política herdada Restricted; JSON Unicode chega por stdin e o processo usa Bypass              | Unidade local + test:windows                                    |
| Aprovação e isolamento | Consentimento da conversa e aprovação de cada operação continuam obrigatórios; recusa não inicia processo                                      | Unidade do serviço e E2E existentes                             |
| Política do computador | CurrentUser, LocalMachine, UserPolicy e MachinePolicy permanecem iguais antes/depois; nenhuma alteração persistente ou elevação                | test:windows, com ambiente temporário e consulta das políticas  |
| Falha e recuperação    | Bloqueio de política recebe mensagem legível, responde ao agente e incrementa falhas; nova tentativa exige aprovação e pode funcionar          | Unidade do driver e serviço                                     |
| Integração             | Parser, dispatcher sintético e driver real compartilham o código de produção; regressão falha se a política do subprocesso for removida        | Unidade local + test:windows                                    |
| Ambiente PowerShell    | PSModulePath do PowerShell 7 não passa ao filho powershell.exe; caminhos e política do processo pai permanecem iguais                          | Unidade do driver + test:windows sob o shell PowerShell 7 do CI |
| Limites                | Linux valida contratos e UI; Windows CI valida powershell.exe 5.1 e instalador; GPO corporativa e aplicativos reais requerem sessão do cliente | check, test:desktop, format:check, job Windows                  |

O harness anterior iniciava scripts diretamente com a política permissiva do runner Windows, sem exercitar o driver de produção sob Restricted. A regressão agora deve demonstrar o bloqueio sem a política de processo, o sucesso pelo driver e a preservação das políticas persistentes. Políticas de grupo continuam tendo precedência e não são contornadas.

O OAuth real requer ação do cliente no navegador da sua máquina. A interação nativa com aplicativos Windows requer homologação manual em sessão Windows interativa; não é declarada como testada em Linux. Não há backend hospedado ou deploy web: a entrega desktop gera um instalador como artefato do workflow, sem certificado de assinatura nesta versão.
