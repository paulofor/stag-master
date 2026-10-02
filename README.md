# STAG

Assistente desktop para Windows, com um painel compacto de conversa inspirado na área marcada da referência. Foco em programação: ler especificações, pesquisar documentação, trabalhar com arquivos e Git, executar testes e interagir com o Windows do cliente.

Esta é a versão 0.4.2: conversa em tempo real, navegador lateral controlado pelo modelo, Markdown, pasta e subpastas com leitura/escrita autorizadas ao selecionar, modelos/níveis de esforço descobertos da conta, histórico por projeto, parar execução, controle autorizado do desktop com confirmação nos pontos críticos, comandos/diffs/plano e métricas de tokens. Login pela conta ChatGPT usando **Codex App Server local**, sem chave de API.

## Executar no Windows

Requisitos de desenvolvimento: Windows 10/11 x64, Node.js 22.12 ou superior, Git e PowerShell 5.1. O instalador inclui Electron e Codex; o cliente não precisa instalar Node ou Codex separadamente.

```powershell
npm ci --include=dev
npm run dev
```

1. Clique em **Entrar com ChatGPT** e conclua o login no navegador.
2. Use **Selecionar projeto** para escolher a pasta de trabalho. A seleção já autoriza leitura e escrita nessa pasta e nas subpastas e ativa **Projeto · leitura e escrita**. O modelo pode ler, criar e editar arquivos e executar testes da tarefa sem novas permissões de rotina.
3. Escolha um modelo disponível e envie a tarefa. Arquivos, histórias de usuário e AGENTS.md dessa pasta ficam acessíveis ao agente. Se quiser impedir alterações, selecione **Leitura** em **Acesso** depois de escolher a pasta; históricos mantêm seu modo original.
4. Para controlar aplicativos, clique em **Autorizar desktop** ao lado da mensagem e confirme **Continuar** e **Permitir acesso**. Isso abre uma nova conversa no modo Windows; repita a tarefa nela. O projeto e o rascunho continuam selecionados.
5. O STAG pode listar/focar janelas, ver a tela principal, clicar, digitar texto literal, enviar atalhos e rolar. Capturas, foco, rolagem, navegação e edição local rotineiras seguem sem novas permissões. Exclusão, envio externo, publicação, pagamentos, credenciais e mudanças no sistema aguardam **Permitir esta ação**, com intenção e alvo visíveis; **Recusar** devolve a recusa sem executar. Interações sem contexto suficiente, Enter/Delete, atalhos desconhecidos/compostos e texto com Enter/Tab também pedem confirmação.
6. **Revogar acesso** ou **Nova conversa** encerra o consentimento. Para retomar um histórico Windows, autorize antes de abri-lo; o consentimento não migra de outra conversa.
7. O **Navegador** aparece à direita. Use a barra de endereço ou clique em **Autorizar navegador** uma vez na conversa e peça ao STAG para pesquisar, abrir páginas ou trabalhar nelas. O modelo pode ler, capturar, clicar, preencher campos, selecionar opções e rolar; ações críticas exigem **Permitir esta ação**. **Revogar navegador**, fechar o painel ou abrir outra conversa descarta a autorização e a sessão de sites. Em janelas compactas, use o ícone de globo e **Voltar à conversa**.

O modelo deve usar o navegador integrado para abrir e interagir com páginas, inclusive aplicações locais em localhost. Sem autorização, ele orienta **Autorizar navegador**; se o painel estiver fechado, **Mostrar navegador** (ícone de globo). A autorização do desktop não permite substituir o painel por Chrome, Edge ou outro navegador externo, nem usar shell ou atalhos como alternativa. Essa orientação também é enviada ao retomar uma conversa. O login ChatGPT iniciado pelo aplicativo continua abrindo o navegador externo para OAuth, sem dar seu controle ao modelo.

A autorização da pasta usa o sandbox nativo do Codex e não concede controle do desktop/navegador. Exclusão, publicação, envio externo, credenciais e mudanças no sistema continuam exigindo confirmação específica. O modo Projeto bloqueia escrita fora da raiz escolhida, inclusive por links/junctions; arquivos protegidos pelo Codex e bloqueios NTFS ou de políticas corporativas continuam sujeitos às permissões efetivas. O STAG não altera permissões globais do Windows nem eleva privilégios automaticamente para contornar bloqueios.

O navegador usa uma sessão separada por conversa, sem importar cookies dos seus outros navegadores. Conteúdo e capturas de páginas autorizadas vão ao ChatGPT. Campos de senha/pagamento e controles de envio têm confirmação adicional; valores preenchidos não aparecem nos cards. Downloads, uploads, popups, permissões nativas e protocolos locais ficam bloqueados e requerem ação manual fora desse painel. Sites que bloqueiam navegadores embutidos ou exigem popups precisam de ação manual do cliente; o modelo informa a limitação e não abre outro navegador automaticamente. Históricos anteriores à versão 0.4 precisam de uma nova conversa para registrar a ferramenta; o aplicativo preserva a política original do histórico.

Capturas e títulos de janelas são enviados ao ChatGPT para a tarefa conforme a autorização inicial. O painel do STAG fica oculto brevemente durante capturas, cliques e rolagem, para não cobrir o alvo, e retorna sem tomar o foco. As ações executam em sequência. **Parar execução** descarta aprovações pendentes e ações enfileiradas; uma operação nativa já iniciada pode terminar antes da interrupção.

O agente classifica o efeito de cada interação na tela; o serviço exige confirmação quando falta esse contexto e para teclas que podem confirmar ou executar. Coordenadas não identificam semanticamente todos os controles dos aplicativos. Para usar o contrato novo após atualizar, abra uma nova conversa e autorize o desktop. Históricos antigos preservam o schema registrado pelo Codex e ainda pedem confirmação para interações sem contexto.

As operações aprovadas executam o script empacotado com política PowerShell definida apenas para o processo filho. Não é necessário mudar a política de execução do usuário ou do computador. Se uma política corporativa ainda bloquear o script, o STAG informa a falha e pede a verificação pelo administrador; essa política tem precedência. A versão 0.2.1 corrige o bloqueio causado pela política local padrão Restricted.

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

- A aplicação mostra conversa e navegador lateral opcional, com controles compactos; não inclui IDE, terminal embutido, voz ou edição de vídeo.
- Programação e pesquisa usam ferramentas nativas do Codex; interação com páginas usa o navegador integrado autorizado. A IDE pode ser aberta por comando autorizado no Windows.
- Controle de desktop: listar/focar janelas, digitação literal, atalhos, clique, rolagem e captura da tela principal; não inclui integração semântica com todas as IDEs.
- O modo Windows dá acesso amplo ao computador. A autorização vale somente para a conversa; operações rotineiras usam esse consentimento e pontos críticos exigem confirmação. Aprovações de comandos/arquivos solicitadas pelo Codex continuam sendo apresentadas.
- OAuth e interações reais de desktop precisam da conta e da sessão Windows do cliente. A matriz documenta o que é simulado e o que exige Windows.
- Integração local e de código aberto, conforme o escopo documentado do [App Server](https://learn.chatgpt.com/docs/app-server). Não é um serviço comercial hospedado.

Veja [arquitetura](docs/arquitetura.md), [matriz de homologação](docs/homologacao.md) e [instruções do harness](AGENTS.md).
