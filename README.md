# STAG

Assistente desktop para Windows, com um painel compacto de conversa inspirado na área marcada da referência. Foco em programação: ler especificações, pesquisar documentação, trabalhar com arquivos e Git, executar testes e interagir com o Windows do cliente.

Esta é a base funcional 0.1: conversa em tempo real, Markdown, projeto local, modelos/níveis de esforço descobertos da conta, histórico por projeto, parar execução, aprovações, comandos/diffs/plano e métricas de tokens. Login pela conta ChatGPT usando **Codex App Server local**, sem chave de API.

## Executar no Windows

Requisitos de desenvolvimento: Windows 10/11 x64, Node.js 22.12 ou superior, Git e PowerShell 5.1. O instalador inclui Electron e Codex; o cliente não precisa instalar Node ou Codex separadamente.

```powershell
npm ci --include=dev
npm run dev
```

1. Clique em **Entrar com ChatGPT** e conclua o login no navegador.
2. Use **Selecionar projeto** para escolher a pasta de trabalho.
3. Escolha um modelo disponível e envie a tarefa. Arquivos, histórias de usuário e AGENTS.md dessa pasta ficam acessíveis ao agente.
4. Use **Projeto** para programação ou **Windows** para controlar aplicativos, com consentimento por conversa e aprovação de ações.

O Codex guarda credenciais e conversas na pasta local da aplicação (`%APPDATA%/STAG/codex`). O aplicativo não lê tokens nem usa a autenticação global de outros clientes.

## Validar e gerar instalador

```powershell
npm run check
npm run test:desktop
npm run test:windows
npm run dist:win
```

O instalador fica em `release/`. O workflow **Desktop CI** valida cada PR e gera o instalador Windows em PRs e na main; baixe o artefato `stag-windows-x64` da execução. O comando usa `--publish never`: gera o arquivo, sem publicar releases automaticamente nem exigir token de release. O build é reproduzível pelo código do repositório. Ainda não há certificado de assinatura: o Windows pode mostrar o aviso de aplicativo desconhecido.

O aplicativo prepara o sandbox nativo Windows no modo unelevated ao conectar. No Linux, o teste da janela real usa `xvfb-run -a npm run test:desktop`.

Para desenvolvimento de interface em Linux: `npm run dev:web`. Esse modo exibe o painel, mas não controla o computador nem usa LLM. O simulador da ponte é injetado **apenas pelos testes**, sem um modo fake no produto.

## Escopo inicial e limites

- A aplicação mostra apenas conversa e controles compactos; não inclui IDE, terminal embutido, voz ou edição de vídeo.
- Programação e navegação web usam ferramentas nativas do Codex. A IDE pode ser aberta por comando autorizado no Windows.
- Controle inicial de desktop: listar/focar janelas, teclas, clique e captura da tela principal; não inclui integração semântica com todas as IDEs.
- O modo Windows dá acesso amplo ao computador. Selecione-o só para tarefas que precisam desse acesso; a interface pede consentimento e aprovação das ações do tool de desktop.
- OAuth e interações reais de desktop precisam da conta e da sessão Windows do cliente. A matriz documenta o que é simulado e o que exige Windows.
- Integração local e de código aberto, conforme o escopo documentado do [App Server](https://learn.chatgpt.com/docs/app-server). Não é um serviço comercial hospedado.

Veja [arquitetura](docs/arquitetura.md), [matriz de homologação](docs/homologacao.md) e [instruções do harness](AGENTS.md).
