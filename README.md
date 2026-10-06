# STAG

Assistente desktop para Windows, com um painel compacto de conversa inspirado na área marcada da referência. Orientado como Engenheiro de Sistemas especialista e experiente em arquitetura e programação: ler especificações, entender o negócio do sistema, pesquisar documentação, trabalhar com arquivos e Git, executar testes e interagir com o Windows do cliente.

Esta é a versão 0.4.27: tela de branches por projeto, abertura confirmada da console FortiClient, fluxo completo no desenvolvimento autorizado, botão opcional de movimento periódico do mouse, análise de vídeos longos em segundo plano com pausa e retomada, painel do navegador ampliado para reduzir rolagem horizontal, correção de recusas indevidas de pedidos preventivos, acesso autorizado no desenvolvimento e homologação, vídeos com extração de imagens e transcrição local para as anotações do projeto, diagnóstico de certificados HTTPS, sessões de sites opcionais por projeto, consulta visual e reconexão VPN pelo FortiClient com confirmação por ação, crédito a Paulo Forestieri, Enter para nova linha e envio pelo botão, fila de textos, fontes de documentação, imagens coladas e memória em `.stag`. Preserva a proteção contra abuso, engenharia de sistemas, painel único, navegador lateral, modelos/esforços da conta, histórico por projeto, aprovações, comandos/diffs/plano e métricas. Login pela conta ChatGPT usando **Codex App Server local**, sem chave de API.

## Branches dos projetos

Selecione a pasta de trabalho e clique em **Branches**, ao lado de **Fontes**. A tela lista os repositórios da pasta e das subpastas; escolha o projeto para ver a branch em uso, as alterações locais e suas branches locais/remotas já conhecidas. Não precisa estar conectado ao ChatGPT para gerenciar branches.

Use **Nova branch** para criar a partir de uma branch existente, **Trocar** para trabalhar nela, **Renomear** para editar o nome e **Excluir** para remover uma branch local já integrada na atual. Referências remotas oferecem **Criar local**, sem conectar ao servidor nem publicar mudanças. Depois da seleção, descreva na conversa o código que o assistente deve editar. O agente recebe a última observação das branches e deve conferir o estado atual antes de escrever.

Trocas exigem ausência de alterações pendentes, sem descarte automático. Exclusão tem confirmação nativa, não força remoção de commits e não afeta o remoto; branch atual ou em uso em outra pasta não pode ser excluída. Leitura permite apenas consulta. Aguarde a tarefa atual e pause análises de vídeo antes de usar a tela; mudanças deixam a fila de mensagens pausada para revisão. O rascunho e a conversa são preservados.

**Atualizar lista** relê o Git após mudanças externas ou falhas. A tela não executa fetch/push, hooks ou filtros de arquivos; branches com filtros como Git LFS precisam ser trocadas no cliente Git para preservar os conteúdos. Busca limitada a 200 repositórios/20 mil pastas/dois minutos e até 1.000 branches por projeto; falhas e listas parciais ficam explícitas. Repositórios com metadados externos ou redirecionados não são operados pela tela.

## Movimento periódico do mouse

No Windows, autorize o desktop, inicie a conversa e clique em **Mover mouse a cada 5 min**. Confirme a ativação. A cada cinco minutos, o main tenta deslocar o cursor até dois pixels e retornar, sem cliques, teclas ou troca de foco; não consome turnos do assistente.

O cursor precisa estar sobre **Postman, IntelliJ IDEA, Visual Studio Code ou DBeaver em primeiro plano**, com o executável/produto/assinatura reconhecidos e sem botões do mouse pressionados. FortiClient, outros aplicativos, sobreposições e alvos alterados são omitidos. O painel mostra o estado e as contagens; uma falha desliga a opção e permite ativar novamente.

Funciona com o STAG minimizado. **Desligar movimento do mouse**, **Parar**, pausar/cancelar vídeo, revogar desktop, trocar de conversa/projeto, desconectar ou fechar desligam e descartam movimentos pendentes. Reload da interface conserva o estado do main; reinício exige ativação explícita. Não há persistência de consentimento nem garantia de impedir suspensão, bloqueio ou expiração de sessões; as políticas do Windows permanecem preservadas.

## Vídeos longos em segundo plano

Selecione o projeto e clique em **Analisar em segundo plano**, escolhendo o original no diálogo do Windows. Aceita MP4, MOV, MKV e WebM até **20 GB e 12 horas**, com até 4096 pixels por lado/8,8 megapixels. O STAG lê o arquivo por partes, sem carregá-lo inteiro nem copiá-lo para o projeto. Cada trecho de até **cinco minutos** produz até 12 imagens/4 MB e fala transcrita localmente pelo Whisper; esses dados seguem ao assistente da sua conta em um turno por trecho, respeitando o modelo escolhido, as fontes atuais, o modo original e as aprovações. Não é uma reprodução contínua: a amostragem e a transcrição podem omitir detalhes ou conter erros.

A conversa mostra fase, trechos concluídos e progresso. **Pausar análise** cancela a extração local ou conclui o trecho que já está sendo analisado; aguarde essa conclusão/limpeza antes de retomar. **Cancelar análise** interrompe o turno atual e preserva notas já verificadas. Textos podem ficar na fila, que só avança após a análise terminar ou ser pausada, respeitando a pausa da própria fila. O rascunho não é enviado nem apagado pelo botão de análise.

Minimizar mantém o trabalho enquanto o computador estiver ligado e acordado. Fechar salva o avanço nos dados privados do STAG, sem mídia ou transcrição no checkpoint. Ao reabrir com a mesma conta/projeto, clique em **Retomar análise**; a conversa e o modo originais serão usados. Se estiver em outro histórico, selecione a conversa da análise. O original deve permanecer disponível e não ser alterado/movido; a identidade é conferida por metadados e amostras limitadas do arquivo. Consentimentos de navegador/desktop não são restaurados automaticamente. É possível manter uma análise salva por projeto e conta.

O avanço só é confirmado após a conclusão do turno e da fila compartilhada de ferramentas. Históricos com análise em segundo plano são recuperados por páginas, um turno por resposta; os quadros da análise não são mantidos no histórico visual. Até os 1.000 turnos mais recentes são exibidos, preservando o histórico original do Codex. Se a resposta de envio se perder, o STAG confere o histórico antes de continuar. Um envio sem evidência fica pausado: confira a conversa e use **Reprocessar trecho** somente após a confirmação específica. Um trecho ainda em andamento no histórico pode ser aguardado ou interrompido por **Parar execução**, sem reenviar automaticamente. Falhas de arquivo, conexão, preparação ou persistência ficam explícitas e preservam o último checkpoint confirmado.

O agente deve consultar e consolidar `.stag` a cada trecho, com fonte, identificador da análise, tempo e data, sem duplicar fatos ao reprocessar. **Leitura** permite análise sem gravar notas. Trechos concluídos não comprovam memorização: confira nas respostas os arquivos efetivamente gravados e relidos. O aplicativo não transcreve o vídeo inteiro para `.stag` nem promete decisões semânticas absolutas do modelo.

## Vídeos para as anotações do projeto

Selecione a pasta do projeto e clique em **Anexar vídeo** abaixo da mensagem. Aceita um MP4, MOV, MKV ou WebM de até **100 MB e 10 minutos**, com até 4096 pixels por lado e 8,8 megapixels. Aguarde a preparação, acrescente uma orientação se quiser e clique em **Enviar**. É possível cancelar a preparação ou remover o anexo sem perder o texto. Enter continua apenas inserindo nova linha. A fila aceita somente texto; vídeos e imagens coladas são enviados separadamente.

O STAG extrai até 12 imagens distribuídas pelo vídeo e transcreve a primeira trilha de áudio **localmente**, com Whisper base multilíngue quantizado. A preparação pode levar alguns minutos. Ao enviar, as imagens e a transcrição temporal seguem para o assistente da conta, que deve extrair informações relevantes de sistema/negócio e atualizar as notas em `.stag`, com fonte, data e referência de tempo. No modo **Leitura**, ele analisa e resume, mas não salva notas. A resposta deve indicar o que foi efetivamente gravado; falhas de escrita não equivalem a memorização.

Amostragem e transcrição podem perder detalhes ou errar nomes, valores e negações. Confira informações importantes e forneça correções. A mídia e a transcrição integral não devem ser copiadas para a memória. O original não é alterado nem copiado para o projeto. Temporários são removidos após preparação/cancelamento e no encerramento normal; término forçado do aplicativo/SO pode deixar arquivos em `stag-media` no diretório temporário do sistema. O anexo preparado fica em memória na conversa e é descartado ao trocar projeto/conversa/conta. Falha/cancelamento da seleção preserva o anexo anterior; falha de envio preserva o rascunho.

Para consultar a versão e o crédito **Desenvolvido por: Paulo Forestieri**, abra o menu **Conta e conexão** (três pontos no cabeçalho) e selecione **Sobre o STAG**. A consulta está disponível antes do login e preserva a conversa e o rascunho. O mesmo crédito aparece nas boas-vindas do instalador Windows.

O piloto do **servidor de traces** fica em [`server/`](server/README.md), com Langfuse, Compose, preparação HTTPS e testes sintéticos. O aplicativo ainda não envia telemetria para esse servidor; a integração com consentimento e filtragem local será uma etapa própria.

## Fila de solicitações

Enquanto o assistente trabalha, escreva no campo de mensagem e clique em **Enfileirar**, ao lado de Parar. O texto será enviado quando a tarefa atual terminar. Você pode adicionar até 20 textos, ver a ordem, expandir cada texto e removê-lo antes do envio. A fila envia um por vez na mesma conversa. **Pausar fila** suspende os próximos envios; **Continuar fila** os retoma. Aprovações e perguntas da tarefa atual continuam aguardando sua resposta normalmente.

**Parar execução**, falhas, desconexão e revogação do navegador pausam a fila e preservam as pendências. Um envio sem confirmação fica sinalizado: confira o histórico e remova essa entrada antes de continuar, pois ela pode já ter chegado ao assistente. A fila aceita somente texto; imagens continuam no envio normal. Os textos ficam em memória enquanto o aplicativo estiver aberto e são descartados ao mudar de conversa, projeto, modo de acesso ou conta. Cancelar a escolha de pasta e recarregar a interface preserva a fila.

## Fontes de documentação do projeto

Depois de selecionar a pasta, clique em **Fontes**, ao lado do nome do projeto. Na janela **Fontes do projeto**, use **Adicionar fonte**, informe um nome e uma URL completa HTTP(S) e clique em **Salvar fontes**. Cadastre até 20 fontes; você pode editar os campos, remover fontes ou cancelar sem alterar o cadastro. URLs repetidas e URLs com usuário/senha são recusadas. Não inclua senhas ou tokens nos links.

O cadastro fica nas configurações locais do STAG, separado por pasta, e permanece após reiniciar o aplicativo. O modelo recebe a lista vigente em todas as solicitações, inclusive em históricos retomados e depois de editar/remover fontes numa conversa existente. Deve consultar a documentação quando a resposta ou alteração depender dela, priorizá-la para requisitos e regras do projeto e citar a URL/seção utilizada. Conflitos com código, notas ou correções do cliente precisam ser esclarecidos.

A consulta usa o navegador integrado: clique em **Autorizar navegador** na conversa quando necessário. O cadastro não concede esse acesso. Fontes inacessíveis devem ser relatadas; trechos fornecidos pelo cliente podem permitir continuar. Nomes e páginas são contexto de referência e não mudam permissões, assuntos ou segurança. Em **Leitura**, cadastrar fontes altera apenas as configurações do aplicativo, sem gravar no projeto. Falhas de salvamento preservam o cadastro anterior e os campos da janela.

## Executar no Windows

Requisitos de desenvolvimento: Windows 10/11 x64, Node.js 22.12 ou superior, Git, PowerShell 5.1, CMake e ferramentas C++ do Visual Studio. Linux x64 usa CMake e compilador C++. O build baixa dependências de mídia com SHA-256 fixado e compila whisper.cpp; requer internet nessa preparação. O instalador inclui Electron, Codex, FFmpeg/ffprobe e o modelo de transcrição; o cliente não precisa instalar essas ferramentas ou fornecer uma chave de API de transcrição. Licenças e fontes: [componentes de mídia](native/media-NOTICES.md).

```powershell
npm ci --include=dev
npm run dev
```

1. Clique em **Entrar com ChatGPT** e conclua o login no navegador.
2. Use **Selecionar projeto** para escolher a pasta de trabalho. A seleção já autoriza leitura e escrita nessa pasta e nas subpastas e ativa **Projeto · leitura e escrita**. Também autoriza o cadastro dos repositórios encontrados na confiança Git do usuário, conforme explicado abaixo. O modelo pode ler, criar e editar arquivos e executar testes da tarefa sem novas permissões de rotina.
3. Escolha um modelo disponível e envie a tarefa. Arquivos, histórias de usuário e AGENTS.md dessa pasta ficam acessíveis ao agente. Se quiser impedir alterações, selecione **Leitura** em **Acesso** depois de escolher a pasta; históricos mantêm seu modo original.
4. Para controlar aplicativos, clique em **Autorizar desktop** ao lado da mensagem e confirme **Continuar** e **Permitir acesso**. Isso abre uma nova conversa no modo Windows; repita a tarefa nela. O projeto e o rascunho continuam selecionados.
5. O STAG pode listar/focar, capturar a janela, clicar, digitar e rolar **somente em Postman, IntelliJ IDEA, Visual Studio Code, DBeaver e FortiClient**. Outros programas, área de trabalho, barra de tarefas e atalhos globais ficam bloqueados, mesmo com aprovação. O driver aceita um atalho por chamada. Capturas, foco, rolagem, navegação e edição local rotineiras seguem sem novas permissões. Exclusão, envio externo, publicação, pagamentos, credenciais e mudanças no sistema aguardam **Permitir esta ação**, com intenção e alvo visíveis; **Recusar** devolve a recusa sem executar. Interações sem contexto suficiente, Enter/Delete, atalhos desconhecidos/compostos e texto com Enter/Tab também pedem confirmação.
6. **Revogar acesso** ou **Nova conversa** encerra o consentimento. Para retomar um histórico Windows, autorize antes de abri-lo; o consentimento não migra de outra conversa.
7. O **Navegador** aparece à direita. Use a barra de endereço ou clique em **Autorizar navegador** uma vez na conversa e peça ao STAG para pesquisar, abrir páginas ou trabalhar nelas. O modelo pode ler, capturar, clicar, preencher campos, selecionar opções e rolar; ações críticas exigem **Permitir esta ação**. **Revogar navegador**, fechar o painel ou abrir outra conversa encerra a autorização. Por padrão, também descarta a sessão dos sites; para preservá-la, ative **Lembrar sessões neste projeto** antes do login. Em janelas compactas, use o ícone de globo e **Voltar à conversa**.

O modelo deve usar o navegador integrado para abrir e interagir com páginas, inclusive aplicações locais em localhost. Sem autorização, ele orienta **Autorizar navegador**; se o painel estiver fechado, **Mostrar navegador** (ícone de globo). A autorização do desktop não permite substituir o painel por Chrome, Edge ou outro navegador externo, nem usar shell ou atalhos como alternativa. Essa orientação também é enviada ao retomar uma conversa. O login ChatGPT iniciado pelo aplicativo continua abrindo o navegador externo para OAuth, sem dar seu controle ao modelo.

A autorização da pasta usa o sandbox nativo do Codex e não concede controle do desktop/navegador. Exclusão, publicação, envio externo, credenciais e mudanças no sistema continuam exigindo confirmação específica. O modo Projeto bloqueia escrita fora da raiz escolhida, inclusive por links/junctions; arquivos protegidos pelo Codex e bloqueios NTFS ou de políticas corporativas continuam sujeitos às permissões efetivas. O STAG não altera permissões globais do Windows nem eleva privilégios automaticamente para contornar bloqueios.

O navegador começa com uma sessão temporária por conversa, sem importar cookies dos seus outros navegadores. **Lembrar sessões neste projeto** é opcional e mantém cookies e dados dos sites neste computador, no perfil local do STAG separado por projeto, inclusive após reiniciar. Ative antes de entrar no site: a mudança fecha a página e não transfere o login temporário anterior. Faça o login manualmente e marque **Continuar conectado** se o site oferecer essa opção. O site continua controlando validade, expiração, MFA e regras corporativas; o STAG não garante login permanente nem salva senhas de formulário. O [Electron mantém sessões em partições persistentes](https://www.electronjs.org/docs/latest/api/session#sessionfrompartitionpartition-options).

**Esquecer logins** apaga os dados locais de navegação do projeto e desativa a opção, após confirmação; não encerra sessões em outros computadores. Fechar, revogar ou trocar conversa sempre fecha a página e encerra o controle do modelo, mesmo com dados salvos: autorize novamente quando necessário. Outro projeto tem um perfil separado. A leitura da página informa caixas marcadas/desmarcadas/mistas para evitar cliques que invertam uma escolha; opções para lembrar login exigem confirmação própria.

Conteúdo e capturas de páginas autorizadas vão ao ChatGPT, inclusive páginas já conectadas. Campos de senha/pagamento e controles de envio têm confirmação adicional; valores preenchidos não aparecem nos cards. Downloads, uploads, popups, permissões nativas e protocolos locais ficam bloqueados e requerem ação manual fora desse painel. Sites que bloqueiam navegadores embutidos ou exigem popups precisam de ação manual do cliente; o modelo informa a limitação e não abre outro navegador automaticamente. Históricos anteriores à versão 0.4 precisam de uma nova conversa para registrar a ferramenta; o aplicativo preserva a política original do histórico.

A versão 0.4.12 melhora os combos do navegador: listas nativas podem ser selecionadas pelo texto da opção ou pelo índice; combos personalizados acessíveis expõem o campo, a lista e suas opções para abrir, pesquisar e selecionar. As setas do teclado também foram corrigidas. Opções desabilitadas, ambíguas ou alteradas são recusadas com orientação para atualizar a leitura; efeitos críticos continuam com confirmação. Abra uma **nova conversa** após atualizar para registrar o schema ampliado da ferramenta, e autorize o navegador. Listas múltiplas e widgets sem alvos acessíveis podem precisar de ação manual.

Somente capturas e títulos das janelas permitidas são enviados ao ChatGPT para a tarefa. A lista verifica nome do executável, produto e assinatura válida do fornecedor, sem depender do título ou de uma pasta de instalação fixa. Instalações não reconhecidas exigem verificação manual. Capturas usam o conteúdo da janela escolhida, sem capturar outros programas que a sobreponham. Cliques e rolagem exigem que o ponto pertença ao processo escolhido; uma sobreposição bloqueia a ação. O painel do STAG fica oculto brevemente durante capturas, cliques e rolagem, para não cobrir o alvo, e retorna sem tomar o foco. As ações executam em sequência. **Parar execução** descarta aprovações pendentes e ações enfileiradas; uma operação nativa já iniciada pode terminar antes da interrupção.

No DBeaver, a lista reconhece `dbeaver.exe`, produto `DBeaver`/`DBeaver Community` e assinatura válida de `DBeaver Corp`. Inspeção da interface e edição de SQL sem execução usam a autorização da conversa. Alterações de dados/esquema, confirmação de transações, importação/exportação/envio de dados, credenciais e efeitos incertos pedem confirmação com a conexão e o alvo informados. O modelo deve conferir o contexto do banco antes de agir, sem presumir uma conexão local ou de teste.

No FortiClient, após atualizar, inicie uma nova conversa e clique em **Autorizar desktop** no STAG. Históricos antigos conservam o schema original da ferramenta. Se o aplicativo estiver somente no ícone, o assistente pode solicitar a abertura do console oficial com **Permitir esta ação**, pela operação fixa `open_forticlient`. O driver usa apenas as pastas conhecidas de instalação do Windows, valida produto/assinatura Fortinet e recusa links/junctions; não recebe caminho, argumentos ou perfil do modelo e não controla a barra de tarefas. A abertura não comprova conexão nem dispensa a confirmação das interações seguintes. Se a instalação não for reconhecida, abra **a Console FortiClient** pelo ícone manualmente. Durante a tarefa, o assistente pode consultar visualmente o estado da VPN e ajudar a reconectar quando ela cair. A lista exige `FortiClient.exe`, produto `FortiClient`, `FortiClient VPN` ou `FortiClient Standalone` e assinatura válida de `Fortinet, Inc.`. Cliques, digitação e atalhos sempre pedem **Permitir esta ação**, inclusive quando informados como rotina; o driver confere o alvo antes da confirmação e novamente na execução. A reconexão deve identificar o perfil/conexão e o efeito concreto. Senha/MFA, SSO externo e bloqueios corporativos podem exigir intervenção manual. Não há monitoramento permanente após a tarefa nem controle de serviços/FortiTray, alteração de proteção/EMS ou exceção para certificados.

O agente classifica o efeito de cada interação na tela; o serviço exige confirmação quando falta esse contexto e para teclas que podem confirmar ou executar. Coordenadas não identificam semanticamente todos os controles dos aplicativos. Para usar o contrato novo após atualizar, abra uma nova conversa e autorize o desktop. Históricos antigos preservam seu schema e sua política de acesso, mas não podem ultrapassar a lista de programas; chamadas antigas sem processId são recusadas com orientação para corrigir o alvo.

As operações aprovadas executam o script empacotado com política PowerShell definida apenas para o processo filho. Não é necessário mudar a política de execução do usuário ou do computador. Se uma política corporativa ainda bloquear o script, o STAG informa a falha e pede a verificação pelo administrador; essa política tem precedência. A versão 0.2.1 corrige o bloqueio causado pela política local padrão Restricted.

O Codex guarda credenciais e conversas na pasta local da aplicação (`%APPDATA%/STAG/codex`). O aplicativo não lê tokens nem usa a autenticação global de outros clientes.

## Certificado HTTPS não confiável

`ERR_CERT_AUTHORITY_INVALID (-202)` significa que o navegador não conseguiu validar a cadeia de confiança do certificado apresentado pelo site. Pode haver autoridade corporativa ausente, cadeia incompleta ou inspeção HTTPS pela VPN/proxy; o código sozinho não distingue essas causas nem comprova queda da VPN. Autorizar navegador e Lembrar sessões não mudam a validação TLS.

No mesmo computador, confira manualmente se o endereço abre no Chrome/Edge **sem aviso**. Se também falhar, encaminhe o diagnóstico à TI para conferir o certificado do servidor, sua cadeia e a distribuição da autoridade corporativa aprovada no Windows. Se apenas o STAG falhar, informe essa diferença à TI e confira com ela a confiança e as políticas aplicadas ao aplicativo. Não exporte nem envie chaves privadas. Depois da correção, encerre e reabra o STAG e tente novamente. Não aceite certificados de origem desconhecida nem desative a validação HTTPS.

O STAG usa a validação padrão do Electron, bloqueia certificados inválidos e mostra orientação específica para autoridade, validade, nome divergente e revogação. A ferramenta informa a mesma falha, sem copiar a URL completa para a mensagem de erro; uma página que falhou não é apresentada como leitura concluída. A atualização melhora esse diagnóstico, mas não instala certificados nem corrige sozinha a configuração corporativa. Consulte a [definição do Chromium](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/net/base/net_error_list.h) e a [documentação de certificados locais do Chrome](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/net/data/ssl/chrome_root_store/faq.md).

## Git na pasta e nas subpastas

Ao selecionar a pasta, o STAG procura `.git` na raiz e nas subpastas. Para cada repositório válido, executa o equivalente a `git config --global --add safe.directory "RAIZ_EXATA"`, sem duplicar entradas já existentes, e verifica `git -C "RAIZ_EXATA" status --short --branch`. O aviso **Git pronto** informa quantos foram verificados; **Detalhes do Git** mostra cadastros e pendências. A execução automática desativa callbacks/filtros locais, acesso de rede e a escrita opcional do índice durante essa verificação.

Isso resolve o bloqueio **dubious ownership**, sem pedir usuário ou senha. A confiança fica persistida na configuração global do Git do mesmo usuário que executa o STAG, inclusive para outros clientes Git desse usuário; só as raízes encontradas são acrescentadas. Não é autenticação para push/pull, alteração de permissões NTFS/GPO ou autorização de outros programas. O [Git documenta `safe.directory`](https://git-scm.com/docs/git-config#Documentation/git-config.txt-safedirectory) como uma exceção de confiança por repositório.

A busca não entra em `.git` nem segue links/junctions; worktrees e submódulos só são aceitos quando seus metadados também estão dentro da pasta selecionada. Nenhum curinga é cadastrado. Limites de 20 mil diretórios, 200 repositórios e dois minutos de preparação evitam uma busca indefinida; cada processo Git tem 15 segundos e uma busca interrompida aparece como incompleta, com orientação para selecionar uma subpasta menor. A interface não mostra saídas brutas do Git nem credenciais.

Se o Git não estiver instalado, a configuração estiver bloqueada ou o repositório falhar, o aviso informa a pendência e a conversa continua utilizável. Instale **Git for Windows** se necessário, reabra o STAG e selecione a pasta novamente para repetir a preparação. Abrir o aplicativo, retomar histórico ou mudar para **Leitura** não repete o cadastro; cancelar o seletor mantém o contexto anterior.

## Imagens na solicitação

Copie uma captura ou imagem **PNG/JPEG** e use **Ctrl+V** no campo da mensagem. Confira as miniaturas e remova qualquer anexo pelo **X**. Você pode acrescentar a descrição ou enviar somente a imagem pelo botão de envio. **Enter** e **Shift+Enter** criam uma nova linha no rascunho, inclusive durante uma execução; para adicionar um texto à fila, clique em **Enfileirar**.

Cada mensagem aceita até quatro imagens e **4 MB no total**, com até 8192 pixels por lado e 20 megapixels por imagem. Imagens inválidas são recusadas; uma falha de envio preserva texto e anexos para tentar novamente. Nova conversa, seleção de outro contexto, abertura de histórico e saída da conta descartam os anexos pendentes. Cancelar a seleção de pasta preserva o contexto.

Ao enviar, as imagens vão para o modelo da sua conta ChatGPT pelo Codex e passam a integrar o histórico da conversa. Não há acesso contínuo à área de transferência, gravação dos anexos nas configurações ou arquivos temporários no projeto. Modelos declarados somente de texto não aceitam anexos. Imagens não autorizam desktop/navegador nem alteram as regras de assuntos ou segurança.

## Memória do projeto

Na primeira tarefa de sistemas ou negócio com escrita autorizada, o modelo recebe a orientação de criar `.stag` dentro da pasta selecionada e registrar o conhecimento importante para as próximas solicitações. Ele deve consultar essa memória em cada tarefa pertinente, inclusive em conversas novas e retomadas, e atualizá-la ao aprender fatos duráveis e antes de concluir o trabalho. Não é necessário pedir para memorizar a cada mensagem.

| Arquivo               | Conteúdo                                                             |
| --------------------- | -------------------------------------------------------------------- |
| `.stag/README.md`     | Índice das notas                                                     |
| `.stag/sistema.md`    | Arquitetura, componentes, stack, integrações, convenções e validação |
| `.stag/negocio.md`    | Domínio, glossário, processos, regras e histórias relevantes         |
| `.stag/decisoes.md`   | Decisões confirmadas, motivos e consequências                        |
| `.stag/pendencias.md` | Dúvidas, hipóteses, riscos e próximos passos                         |

As notas devem ser concisas, com fontes e datas, preservando o conteúdo existente e distinguindo fatos de hipóteses. Correções confirmadas atualizam as notas sem duplicar registros a cada turno. O modelo deve verificar a gravação e informar brevemente os arquivos atualizados. Você pode ler e editar esses arquivos; eles permanecem na pasta do projeto entre conversas e reinicializações do aplicativo. Selecionar outra pasta usa a memória dessa outra pasta, sem copiar conhecimento automaticamente.

No modo **Leitura**, o modelo consulta notas existentes, mas não cria nem altera `.stag`. Falha de acesso deve ser informada sem afirmar que algo foi salvo e sem impedir tarefas independentes. Senhas, tokens, segredos, dados pessoais desnecessários, transcrições e raciocínio interno não devem ser registrados. A memória é contexto, não autorização: não altera escopo, segurança, consentimentos ou permissões e não autoriza seguir links para outros projetos. Commit, publicação ou envio externo das notas exigem solicitação.

O registro é realizado pelo modelo com as ferramentas nativas de arquivos do Codex e o sandbox do modo atual. O STAG não copia conversas para `.stag`, não cria um indexador ou grava arquivos do projeto pelo processo principal. O conteúdo relevante consultado pelo agente passa a integrar o contexto enviado ao modelo, como outros arquivos lidos para a tarefa. A seleção do conhecimento e a atualização dependem do comportamento do modelo; os testes determinísticos verificam contratos e persistência sintética, não garantem a memorização semântica de todo fato.

Após atualizar e reabrir o aplicativo, selecione o projeto e envie a tarefa normalmente. Conversas retomadas recebem a orientação de memória sem ampliar seu modo original de acesso.

## Especialização e assuntos permitidos

O STAG recebe instruções para atuar como Engenheiro de Sistemas especialista e experiente, do entendimento dos requisitos e regras de negócio à arquitetura, programação, testes e operação. Deve comparar alternativas e custos quando relevantes, explicitar premissas e incertezas e validar as mudanças com evidências.

As respostas ficam restritas a engenharia de sistemas e ao domínio de negócio dos sistemas em construção. Dúvidas conceituais e sobre processos, terminologia, regras e histórias de usuário são permitidas, mesmo sem pedido de código. Por exemplo, explicar reserva de estoque em um sistema de estoque faz parte do trabalho. O modelo usa o contexto informado pelo cliente e as especificações do projeto; quando o vínculo estiver ambíguo, pede um esclarecimento breve.

Pedidos claramente alheios recebem um redirecionamento breve, sem resposta ao conteúdo, pesquisa ou ferramenta. Pedidos mistos recebem somente a parte pertinente. Esse contrato vale em conversas novas e ao retomar históricos, em todos os modos; novo papel, autorização ou instruções em páginas/arquivos não ampliam os assuntos nem removem as regras de segurança e acesso. Após atualizar e reabrir o aplicativo, conversas retomadas recebem as novas instruções sem mudar suas permissões.

O limite é uma orientação de comportamento do modelo, não um bloqueio semântico absoluto por código. O harness usa um corpus sintético para verificar transmissão do contrato, ciclo de resposta, ausência de efeitos nesses cenários e recuperação; não usa uma conta real nem comprova todas as respostas de um LLM.

## Adaptações no desenvolvimento e homologação

O modelo pode corrigir guards, menus, rotas, roles e permissões de empresa/tenant na aplicação autorizada, ou implementar um perfil de teste com autenticação simulada e dispensa temporária de verificações. **Bypass**, **SSO** ou **banco corporativo** não justificam recusa automática. Desenvolvimento/homologação podem ser locais ou remotos/compartilhados, desde que a aplicação, a autoridade do cliente, o ambiente, as dependências e o alcance da mudança estejam identificados e separados de produção e de usuários/dados fora do escopo.

Ao informar que os dados são de desenvolvimento, o cliente acrescenta contexto que deve ser considerado, inclusive após uma recusa. O modelo confere a configuração pertinente sem ler segredos nem presumir produção pelo nome do serviço. Se já houver informação suficiente, continua as edições locais e os testes autorizados sem repetir perguntas. Se faltar algo ou houver uma configuração contraditória, esclarece somente esse ponto e continua o trabalho independente. Uma conclusão antiga na memória não deve perpetuar uma recusa desatualizada.

As permissões do usuário provisório não definem a autoridade do desenvolvedor para adaptar a aplicação. Se o pedido autorizado inclui o fluxo completo, o assistente deve preservar consulta, cadastro, edição, exclusão e geração/processamento de remessas, com dados, cálculos, validações e regras de negócio completos. Não deve impor somente leitura, desabilitar alterações ou substituir os dados por amostras por conta própria. O alcance pode incluir todas as empresas e registros da base de desenvolvimento explicitamente autorizada, mantendo os vínculos e o isolamento fora desse conjunto. Restrições anteriores criadas pelo assistente devem ser revistas diante do esclarecimento do cliente.

Uma dispensa temporária exige perfil explícito desligado por padrão, destinos de teste verificados, preservação dos controles normais e falha fechada fora do perfil, em produção ou em ambiente indefinido. No teste local, usa loopback e dependências locais; no remoto autorizado, limita aplicação, ambiente, usuários e dados de teste, sem acesso público irrestrito. Deve validar frontend/backend, segregação entre empresas/tenants e reversão. Localhost com proxy para produção não é isolamento. SSO e serviços fora da autorização mantêm seus controles; mocks locais permitem avançar quando uma dependência está fora do alcance.

Exemplo: “Meu usuário provisório não tem roles. Sou responsável por esta aplicação e autorizo adaptar Cadastro e Remessa completos na API e base de desenvolvimento, incluindo cadastrar, editar e gerar remessas para todas as empresas de teste dessa base. Preserve dados e regras de negócio, confira os destinos e valide que o perfil não libera produção.” O assistente não deve encerrar apenas mandando solicitar roles à TI ou entregar somente consulta quando o fluxo completo estiver autorizado.

Implementar suporte a escrita no código não significa executar uma exclusão, uma operação no banco pelo DBeaver ou um envio externo. Essas execuções continuam exigindo confirmação específica, e o modo Leitura do STAG continua sem permitir escrita. Dependências indisponíveis ou fora da autorização podem ser simuladas para avançar no desenvolvimento, com a limitação explícita; a simulação não comprova o fluxo integrado.

Leitura, sandbox, consentimentos e confirmações críticas continuam valendo, inclusive no DBeaver. Atualizar e reabrir o STAG aplica o contrato às conversas retomadas sem ampliar permissões. Essas são instruções ao modelo, não garantias sobre todas as suas respostas nem travas automaticamente implementadas na aplicação do projeto. O harness verifica transmissão, limites do filtro, esclarecimento posterior, isolamento e recuperação com dados sintéticos; não acessa serviços corporativos reais.

## Recusa de solicitações maliciosas

O contrato do modelo proíbe executar ou facilitar invasões, roubo de dados/credenciais, malware, phishing, ataques de indisponibilidade e evasão maliciosa de segurança. Essa regra vale em todos os modos e ao retomar históricos; autorizar a pasta, o desktop ou o navegador e confirmar uma ação não libera abuso. O assistente deve recusar a parte maliciosa e oferecer defesa ou remediação. Programação, correção de vulnerabilidades e testes sintéticos isolados continuam permitidos. Tarefas de segurança com alvo, autorização ou escopo ambíguos precisam ser esclarecidas antes de agir.

O serviço bloqueia padrões explícitos em solicitações antes de enviá-las ao Codex, nas respostas a perguntas, nos argumentos de desktop/navegador e na intenção ou comando dos pedidos de aprovação. Uma ação identificada como maliciosa não oferece um botão para liberar sua execução. A recusa fica visível na conversa e permite continuar com uma tarefa legítima. Pedidos recusados antes do envio ficam somente no painel em memória; não criam um turno no histórico do Codex.

Esses filtros não garantem detectar toda intenção maliciosa, código ou ofuscação. Comandos/arquivos nativos que o Codex executa sem pedir aprovação dependem também da política do modelo e do sandbox do modo escolhido. Os testes são determinísticos, com dados inertes, e não comprovam imunidade a toda tentativa contra um LLM real.

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
- Programação e pesquisa usam ferramentas nativas do Codex; interação com páginas usa o navegador integrado autorizado. Se um aplicativo permitido não estiver aberto ou reconhecido, o cliente precisa abri-lo ou verificar sua instalação manualmente.
- Controle de desktop: somente Postman, IntelliJ IDEA, Visual Studio Code, DBeaver e FortiClient, com captura de janela e validação do processo antes das interações; não inclui integração semântica com todas as IDEs.
- A autorização do desktop vale somente para a conversa e os quatro programas. A política de comandos/arquivos do Codex permanece a do modo e histórico selecionados; o bloqueio nativo do desktop não é um sandbox de todos os comandos. As instruções proíbem usar comandos, terminal da IDE ou automação externa para contornar a lista; operações rotineiras usam esse consentimento e pontos críticos exigem confirmação. Aprovações de comandos/arquivos solicitadas pelo Codex continuam sendo apresentadas.
- OAuth e interações reais de desktop precisam da conta e da sessão Windows do cliente. A matriz documenta o que é simulado e o que exige Windows.
- Integração local e de código aberto, conforme o escopo documentado do [App Server](https://learn.chatgpt.com/docs/app-server). Não é um serviço comercial hospedado.

Veja [arquitetura](docs/arquitetura.md), [matriz de homologação](docs/homologacao.md) e [instruções do harness](AGENTS.md).
