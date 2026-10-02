# Matriz de homologação da versão 0.1

Definida antes da implementação dos testes. O aplicativo é desktop Windows; Chromium em dimensões compactas e emulação Pixel 7 validam layout, toque e acessibilidade, sem implicar suporte a app Android. A sandbox Linux não possui sessão gráfica Windows, OAuth interativo do cliente nem ferramentas nativas Windows. Essas limitações são registradas separadamente dos testes locais.

| Área            | Cenário e aceite                                                                                                                         | Evidência                                                    |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Caminho feliz   | Escolher projeto, entrar, descobrir modelos, iniciar conversa, receber deltas, Markdown e conclusão                                      | E2E Chromium + serviço com App Server simulado               |
| Histórico       | Nova conversa e retomada no mesmo projeto sem misturar itens ou permissões                                                               | Unidade e E2E                                                |
| Validações      | Mensagem vazia, projeto ausente, modelo inválido, modo Windows sem consentimento e argumentos inesperados recusados                      | Unidade e E2E                                                |
| Aprovações      | Comando/arquivo recusado ou aceito; perguntas obrigatórias; request desconhecido recebe erro; aprovação resolvida/interrompida some      | Unidade e E2E                                                |
| Falhas          | Timeout, processo encerrado, erro do turno e login; usuário pode reconectar; pedidos pendentes são liberados                             | Unidade e E2E                                                |
| Corridas        | Deltas/conclusão antes da resposta `turn/start`; texto final autoritativo; eventos de outra conversa ignorados                           | Unidade                                                      |
| Integração      | App Server empacotado responde initialize, account/read e model/list com CODEX_HOME isolado, sem chamada paga                            | `npm run test:codex` local e CI                              |
| Windows         | Parser PowerShell; listar janelas; foco, teclado, clique e screenshot com contratos simulados; instalador contém Codex e scripts nativos | Unidade local + `test:windows` e empacotamento Windows em CI |
| Observabilidade | Estado da conexão, comandos, diffs, plano e tokens visíveis; métricas apenas contadores locais; logs sem conteúdo/autenticação           | Unidade e E2E                                                |
| Dados de teste  | Fake OAuth, projetos temporários, CODEX_HOME temporário, sem autenticação real nem automação real de desktop nos testes de navegador     | Fixtures e teste real de handshake                           |
| Interface       | Painel único, rolagem, Enter/Shift+Enter, parar, foco e leitores de tela, Markdown sem HTML executável                                   | E2E Chromium                                                 |
| Dimensões       | 640×900, 390×844 (Pixel 7), 1280×800; sem overflow horizontal                                                                            | E2E e screenshots locais                                     |

O teste `test:desktop` abre uma janela Electron real e valida protocolo local, preload isolado, origem IPC e seleção de projeto. No Linux (Xvfb), também exercita login, conversa e aprovação por um processo simulado; no Windows usa o Codex real isolado, sem OAuth.

O OAuth real requer ação do cliente no navegador da sua máquina. A interação nativa com aplicativos Windows requer homologação manual em sessão Windows interativa; não é declarada como testada em Linux. Não há backend hospedado ou deploy web: a entrega desktop gera um instalador como artefato do workflow, sem certificado de assinatura nesta versão.
