# Decisões

2026-10-06 — Preparar servidor em pasta própria, usando Langfuse e OTLP/HTTP. Não ativar coleta no aplicativo nesta etapa. Testes usam somente contas e metadados sintéticos, com stack descartável. Fonte: solicitação e delimitação desta implementação.

2026-10-06 — Web e worker fixados na versão 4.50.0 por digest; o worker aguarda a inicialização do web. O harness verifica ingestão real, chaves por projeto, duplicatas e recuperação. Fonte: `server/compose.yaml` e homologação local.

2026-10-06 — Enter insere nova linha; envio pelo botão. Instalação e Sobre creditam Paulo Forestieri. Já integrados pelos PRs #20 e #21, com CI main aprovado. Fonte: código e GitHub.

2026-10-06 — Para permitir Continuar conectado, adicionar persistência opcional de sessões de sites por raiz canônica de projeto no perfil local do STAG, desligada por padrão e ativada pela interface antes do login. Consentimento do modelo permanece em memória por conversa; Esquecer logins limpa os dados e desativa a opção. Expiração/MFA continuam sob controle do site. Fonte: pedido atual, código e homologação local com cookies HttpOnly sintéticos, isolamento e dois reinícios reais do Electron. Entrega integrada pelo PR #24, SHA `f52410a4438b1778f50acc6196201d87059006cf`, workflow main `37410964325` aprovado (GitHub consultado em 2026-10-06).

2026-10-06 — Diagnóstico de certificados no navegador usa códigos Chromium e orienta ação manual/TI, preservando a validação TLS padrão. Não adicionar exceção de confiança ou importar autoridades sem identificar a configuração corporativa. Harness passa a reproduzir autoridade inválida com HTTPS loopback sintético e verificar recuperação e ausência de URL na mensagem. Fonte: imagem do cliente e código de `browser-panel.ts`. O acesso corporativo não foi verificado nesta sandbox.
