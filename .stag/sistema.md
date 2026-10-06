# Sistema

2026-10-06 — A operação open_forticlient abre somente FortiClient.exe oficial instalado no Program Files/Program Files x86, sem shell ou argumentos do agente. A inspeção e a abertura passam pela fila compartilhada e confirmam/revalidam a identidade; o executável fica protegido contra escrita/substituição durante a abertura. Retorno de abertura não comprova conexão. Senha/MFA/SSO externos continuam manuais. Fonte: implementação 0.4.26 e matriz de homologação; interação com a instalação corporativa requer sessão Windows do cliente.

2026-10-06 — STAG é um aplicativo Windows com Electron/React e Codex App Server local. O painel de conversa e suas políticas permanecem no aplicativo. Fonte: `README.md`, `AGENTS.md` e `package.json`.

O lado servidor de traces está em `server/`, com Langfuse 4.50.0 independente do desktop, Compose, proxy HTTPS opcional e harness sintético. A integração de exportação no STAG ainda está pendente. Fonte: solicitação do cliente e arquivos de `server/`.

2026-10-06 — Anexos de vídeo são preparados no main por `request-video.ts`: FFmpeg/ffprobe e Whisper base multilíngue quantizado, instalados por `scripts/prepare-media.mjs` com versões/checksums em `native/media-lock.json`. A interface envia somente um id de anexo; o serviço encaminha quadros e contexto temporal não confiável ao Codex, sob as permissões originais. Fonte: solicitação de vídeo para memória e implementação 0.4.19.

2026-10-06 — Vídeos longos em segundo plano (0.4.23) já integrados pelo PR #30, SHA main `52a43d2b5699c8d7f2c5a50eb8e9abd61d7fd9ce`, CI main `37516302461` aprovado. Trechos de cinco minutos, leitura limitada do arquivo nativo e checkpoint privado sem mídia/transcrição; notas seguem ferramentas nativas do agente. Fonte: código atual e GitHub consultado nesta tarefa.

2026-10-06 — Movimento periódico opcional pertence ao main e à conversa Windows autorizada: temporizador de cinco minutos, gesto fixo de até dois pixels na fila de desktop/browser, com cancelamento de subprocesso e sem turnos LLM. Driver revalida processo assinado, janela, foco e cursor; exclui FortiClient, arraste e alvos não permitidos. Fonte: pedido do cliente e implementação 0.4.24. Validação local: 421 contratos, 78 cenários Chromium, Electron final e 580 verificações nativas sintéticas/C# sem APIs gráficas; limites Windows/bwrap registrados na matriz de homologação.
