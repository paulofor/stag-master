# Sistema

2026-10-06 — STAG é um aplicativo Windows com Electron/React e Codex App Server local. O painel de conversa e suas políticas permanecem no aplicativo. Fonte: `README.md`, `AGENTS.md` e `package.json`.

O lado servidor de traces está em `server/`, com Langfuse 4.50.0 independente do desktop, Compose, proxy HTTPS opcional e harness sintético. A integração de exportação no STAG ainda está pendente. Fonte: solicitação do cliente e arquivos de `server/`.

2026-10-06 — Anexos de vídeo são preparados no main por `request-video.ts`: FFmpeg/ffprobe e Whisper base multilíngue quantizado, instalados por `scripts/prepare-media.mjs` com versões/checksums em `native/media-lock.json`. A interface envia somente um id de anexo; o serviço encaminha quadros e contexto temporal não confiável ao Codex, sob as permissões originais. Fonte: solicitação de vídeo para memória e implementação 0.4.19.
