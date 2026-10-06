# Decisões

2026-10-06 — Preparar servidor em pasta própria, usando Langfuse e OTLP/HTTP. Não ativar coleta no aplicativo nesta etapa. Testes usam somente contas e metadados sintéticos, com stack descartável. Fonte: solicitação e delimitação desta implementação.

2026-10-06 — Web e worker fixados na versão 4.50.0 por digest; o worker aguarda a inicialização do web. O harness verifica ingestão real, chaves por projeto, duplicatas e recuperação. Fonte: `server/compose.yaml` e homologação local.

2026-10-06 — Enter insere nova linha; envio pelo botão. Instalação e Sobre creditam Paulo Forestieri. Já integrados pelos PRs #20 e #21, com CI main aprovado. Fonte: código e GitHub.

2026-10-06 — Para permitir Continuar conectado, adicionar persistência opcional de sessões de sites por raiz canônica de projeto no perfil local do STAG, desligada por padrão e ativada pela interface antes do login. Consentimento do modelo permanece em memória por conversa; Esquecer logins limpa os dados e desativa a opção. Expiração/MFA continuam sob controle do site. Fonte: pedido atual, código e homologação local com cookies HttpOnly sintéticos, isolamento e dois reinícios reais do Electron. Entrega remota ainda depende dos checks Windows/PR/main.
