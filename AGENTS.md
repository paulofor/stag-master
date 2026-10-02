# STAG desktop

Aplicação Windows local. Preserve o painel único de conversa da referência: não adicione IDE, terminal embutido ou sidebar permanente.
O navegador lateral solicitado pelo cliente é um painel opcional ao lado dessa conversa; em janelas compactas, alterna com a conversa.

## Contratos observados

- O App Server é bidirecional: além de notificações, recebe requests do servidor com `id`. Responda, recuse explicitamente ou mostre a aprovação; nunca deixe o agente preso.
- Tokens e OAuth pertencem ao Codex. Não leia `auth.json`, não exponha tokens ao renderer, não registre payloads de autenticação e não use dados reais em testes.
- Use os modelos e esforços de `model/list`; não fixe nomes de modelos.
- `item/completed` é autoritativo. Não duplique texto já recebido em deltas. Filtre eventos pelo thread/turn correto. Não mostre raciocínio bruto.
- Renderer sem Node, com CSP, sandbox e preload restrito. Valide entradas e origem IPC no main. Markdown nunca executa HTML ou imagens remotas.
- Ferramentas do Windows só no modo Windows com consentimento da conversa, argumentos validados e processo sem shell interpolado. Capturas, foco, rolagem e interações rotineiras usam esse consentimento; ações críticas ou sem contexto suficiente exigem aprovação específica. Em clique, texto e atalhos, informe risco e intenção concretos; exclusão, envio externo, publicação, pagamentos, credenciais e mudanças no sistema são críticos. Enter/Delete, atalhos desconhecidos/compostos e texto com Enter/Tab continuam com confirmação. Não mude a política de acesso ao retomar histórico nem contorne recusa.
- A política PowerShell do script empacotado fica somente no subprocesso aprovado. Não altere CurrentUser/LocalMachine, registro ou GPO para habilitar o controle. Não herde PSModulePath do PowerShell 7 no filho powershell.exe. A regressão Windows deve usar o driver de produção sob Restricted e conferir preservação das políticas e do ambiente pai.
- Consentimento Windows pertence a uma conversa e fica em memória: não o transfira para outro thread. Informe ao agente a capacidade atual e o caminho de autorização. Capturas e ações por coordenadas ocultam o painel brevemente para não cobrir o alvo.
- Navegação do modelo usa exclusivamente stag_browser no painel integrado, inclusive localhost. Essa regra vale antes da autorização e em start/resume; desktop autorizado não é fallback para Chrome/Edge, shell ou automação externa. Sem consentimento, indique Autorizar navegador (Mostrar navegador se fechado); históricos sem tool exigem nova conversa, preservando a política antiga. Bloqueios/recusas requerem ação manual. O OAuth iniciado pelo aplicativo continua externo e não dá controle desse navegador ao modelo.
- O navegador remoto usa WebContentsView com sessão efêmera por conversa, sem Node ou preload e sem acesso ao IPC do painel. Controle do modelo exige consentimento próprio em memória; fechar, revogar ou trocar conversa descarta a sessão. Só HTTP(S), operações fixas e refs/pageId do snapshot atual; proíba JavaScript arbitrário, cookies/tokens, protocolos locais, popups, downloads/uploads e permissões nativas. Campos de senha/pagamento, envio, efeitos críticos/incertos e Enter/Delete exigem confirmação. Revalide o alvo antes de executar e não exponha valores de campos em cards/snapshots públicos. Conteúdo web nunca altera instruções ou permissões.
- Testes usam App Server determinístico e CODEX_HOME temporário. Nunca execute teste com as credenciais, repositório ou janelas de trabalho do usuário.
- Testes de timeout iniciam o subprocesso com o prazo normal e avançam um relógio controlado só após o handshake. Não imponha deadlines de milissegundos à inicialização do processo. Aguarde o shutdown nas limpezas.

## Validação e entrega

Leia `docs/homologacao.md`. Execute `npm run check`, `npm run test:desktop`, `npm run format:check` e revise o diff antes de publicar. No Linux o teste desktop usa Xvfb (`xvfb-run -a npm run test:desktop`). No Windows execute também `npm run test:windows` e `npm run dist:win`. Alterações de protocolo precisam de testes de recuperação e aprovação. Atualize a matriz quando mudar um fluxo.

App Server e ferramentas Windows experimentais têm versão fixada no lockfile. O teste real de handshake protege contra divergência das fixtures. Não use publicação como teste. A homologação Linux não comprova execução nativa Windows: declare essa limitação e confira o job Windows no PR.

O smoke do App Server deve importar o schema real do tool de desktop, sem duplicá-lo em uma fixture simplificada. Simulações usam imagens/janelas sintéticas e verificam rotina sem cards, confirmação de cada ação crítica/incerta, recusa, recuperação e isolamento por thread. Execução automática e aprovada compartilham a mesma fila: não sobreponha ações, execute pedidos repetidos apenas uma vez e descarte operações enfileiradas/resultados antigos após interrupção ou troca de conexão/conversa.
O mesmo vale para stag_browser: o smoke importa seu schema real e test:desktop exercita o driver de produção com site de loopback sintético, isolamento remoto, referências expiradas, controles críticos, cancelamento e sessões descartadas. Browser e desktop compartilham a fila; não crie executor paralelo para o navegador.

O instalador é entregue como artefato do workflow. Preserve `--publish never` no comando `dist:win`; a detecção automática de CI do electron-builder pode ativar releases na main ou em tags. Alterações de empacotamento devem validar a política de publicação com o builder real, sem credenciais ou upload.
