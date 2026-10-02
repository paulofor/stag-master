# STAG desktop

Aplicação Windows local. Preserve o painel único de conversa da referência: não adicione IDE, terminal embutido ou sidebar permanente.

## Contratos observados

- O App Server é bidirecional: além de notificações, recebe requests do servidor com `id`. Responda, recuse explicitamente ou mostre a aprovação; nunca deixe o agente preso.
- Tokens e OAuth pertencem ao Codex. Não leia `auth.json`, não exponha tokens ao renderer, não registre payloads de autenticação e não use dados reais em testes.
- Use os modelos e esforços de `model/list`; não fixe nomes de modelos.
- `item/completed` é autoritativo. Não duplique texto já recebido em deltas. Filtre eventos pelo thread/turn correto. Não mostre raciocínio bruto.
- Renderer sem Node, com CSP, sandbox e preload restrito. Valide entradas e origem IPC no main. Markdown nunca executa HTML ou imagens remotas.
- Ferramentas do Windows só no modo Windows, sempre com aprovação específica, argumentos validados e processo sem shell interpolado. Não mude a política de acesso ao retomar histórico.
- Testes usam App Server determinístico e CODEX_HOME temporário. Nunca execute teste com as credenciais, repositório ou janelas de trabalho do usuário.
- Testes de timeout iniciam o subprocesso com o prazo normal e avançam um relógio controlado só após o handshake. Não imponha deadlines de milissegundos à inicialização do processo. Aguarde o shutdown nas limpezas.

## Validação e entrega

Leia `docs/homologacao.md`. Execute `npm run check`, `npm run test:desktop`, `npm run format:check` e revise o diff antes de publicar. No Linux o teste desktop usa Xvfb (`xvfb-run -a npm run test:desktop`). No Windows execute também `npm run test:windows` e `npm run dist:win`. Alterações de protocolo precisam de testes de recuperação e aprovação. Atualize a matriz quando mudar um fluxo.

App Server e ferramentas Windows experimentais têm versão fixada no lockfile. O teste real de handshake protege contra divergência das fixtures. Não use publicação como teste. A homologação Linux não comprova execução nativa Windows: declare essa limitação e confira o job Windows no PR.

O instalador é entregue como artefato do workflow. Preserve `--publish never` no comando `dist:win`; a detecção automática de CI do electron-builder pode ativar releases na main ou em tags. Alterações de empacotamento devem validar a política de publicação com o builder real, sem credenciais ou upload.
