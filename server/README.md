# Servidor de traces do STAG Plus

Piloto independente do aplicativo Windows, baseado em Langfuse e OpenTelemetry. Desenvolvido por: **Paulo Forestieri** (integração STAG Plus; Langfuse mantém sua autoria e licença).

Esta pasta prepara o lado servidor. O STAG Plus ainda não exporta traces e nenhuma coleta é ativada por esta entrega. A integração futura precisa de consentimento, filtragem local, identificadores pseudônimos e fila limitada em segundo plano. Não transmitir conversas, argumentos de ferramentas, imagens, raciocínio interno, caminhos de projetos ou credenciais do Codex.

## Componentes e acesso

`STAG Plus (integração futura) → HTTPS/Caddy → Langfuse web → PostgreSQL + ClickHouse + Redis + MinIO + worker`

`compose.yaml` fixa as imagens upstream por digest (web e worker Langfuse 4.50.0), mantém dados em volumes e limita a rotação dos logs. O worker aguarda o web concluir a inicialização; ambos respondem ao healthcheck em loopback. Somente o web publica uma porta, em `127.0.0.1:3000`. Os bancos, o armazenamento e o worker ficam na rede do Compose. `compose.https.yaml` acrescenta o Caddy construído por `Dockerfile.proxy`, com certificado automático, limite de corpo de 1 MB e portas 80/443. O proxy não habilita log de acesso com payloads.

Cadastro público e telemetria do próprio Langfuse ficam desativados. A inicialização cria um administrador e um projeto piloto com chaves próprias; essas credenciais são independentes do ChatGPT/Codex. A configuração solicita retenção de 30 dias para o projeto inicial. Confira a retenção efetiva no painel da versão/licença instalada e inclua também backups no prazo de descarte. A inicialização é idempotente: mudar os valores `LANGFUSE_INIT_*` não é um mecanismo de rotação de usuários/chaves já existentes. [Inicialização oficial](https://langfuse.com/self-hosting/administration/headless-initialization).

MinIO não está publicado: mídia e exportações de dados não fazem parte deste piloto. Nenhuma chave de provedor de IA é encaminhada aos containers.

## Preparação local

Na raiz do repositório, com Node 22.12+, Docker Engine e Compose v2.24.4+ (ou v5):

```sh
node server/scripts/init-env.mjs
docker compose -p stag-traces-local --env-file server/.env -f server/compose.yaml config --quiet
docker compose -p stag-traces-local --env-file server/.env -f server/compose.yaml up -d --wait --wait-timeout 360
```

Abra `http://localhost:3000`. O email inicial e a senha estão no arquivo local `server/.env`, criado com permissão restrita e ignorado pelo Git. Não copie esse arquivo para logs, tickets ou o desktop. O gerador nunca sobrescreve um arquivo existente; o exemplo sem segredos falha na validação do Compose. Não use `docker compose config` sem `--quiet` em logs: a saída expandida inclui segredos.

Para parar preservando dados, use o mesmo comando Compose com `down`. `down --volumes` destrói os dados e só deve ser usado nos ambientes descartáveis de teste.

## Preparação para a VPS

O destino, domínio e capacidade da VPS ainda precisam ser definidos. O guia upstream recomenda pelo menos 4 CPUs e 16 GiB de RAM para essa topologia; dimensionar disco, retenção e backups conforme o volume observado. [Instalação oficial](https://langfuse.com/self-hosting/deployment/docker-compose).

Prepare um arquivo de ambiente novo em local protegido, informando `--url https://traces.seu-dominio` e `--email` do administrador no gerador. O domínio precisa apontar para a VPS e permitir emissão do certificado nas portas 80/443. O workflow de implantação a ser configurado para o destino deve consumir `compose.yaml` + `compose.https.yaml`, construir o proxy a partir deste repositório e usar segredos do ambiente de implantação. Esta entrega não instala serviços numa VPS nem cria um deploy sem destino definido.

Antes de receber dados reais: validar HTTPS externamente, acessos de operadores, isolamento por projetos/chaves e restauração de backups. Fazer backups consistentes de PostgreSQL, ClickHouse e MinIO, com acesso restrito e prazo de retenção; preservar os segredos necessários para restauração. Redis usa AOF para a fila. A cópia de volumes abertos não substitui um procedimento de backup validado. Atualizações de digests devem repetir o smoke e passar por PR; migrações podem exigir restauração completa para rollback. [Guia de backups](https://langfuse.com/self-hosting/configuration/backups).

## Contrato da futura integração

O endpoint é `POST /api/public/otel/v1/traces`, com OTLP/HTTP JSON ou protobuf e autenticação Basic formada pelas chaves do projeto Langfuse. Em Langfuse 4, enviar `x-langfuse-ingestion-version: 4`. Não usar OAuth/tokens do Codex para essa autenticação. [Ingestão OpenTelemetry oficial](https://langfuse.com/integrations/native/opentelemetry).

| Dado previsto                                      | Tratamento antes do envio                                                          |
| -------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Projeto, conversa e tarefa                         | IDs opacos/pseudônimos, com isolamento por projeto; nunca caminho, título ou texto |
| Versões, modelo e esforço                          | Valores observados da execução; não fixar modelos no cliente                       |
| Ferramentas, aprovação, recusa, erro e recuperação | Categorias limitadas, sem argumentos ou mensagens brutas de erro                   |
| Duração e tokens                                   | Números medidos/informados; ausência não equivale a zero                           |
| Feedback                                           | Avaliação explícita do usuário, inicialmente sem comentário livre                  |

Consentimento fica desligado inicialmente. Enviar somente campos permitidos após filtragem local; manter fila limitada, timeout, tratamento de indisponibilidade e IDs estáveis para reenvio, sem bloquear a conversa. Chaves de um projeto Langfuse autorizam consultar seus dados: não embutir uma chave compartilhada de toda a organização no instalador. Definir credenciais/destinos isolados antes da integração. Exportar métricas não habilita ferramentas, acesso ao desktop ou navegação.

## Executar a homologação

```sh
npm run test:server
```

O harness precisa de Docker, Node e ShellCheck. Cria um projeto Compose exclusivo, credenciais aleatórias, dois projetos Langfuse e volumes descartáveis. Não lê `server/.env`, configurações do Codex ou contas reais. Valida o Compose de produção e o Caddy real; usa HTTP privado no teste para não emitir certificados públicos. Ao terminar ou falhar, aguarda `down --volumes --remove-orphans`. Recusa namespaces com containers/volumes preexistentes. `STAG_TEST_COMPOSE_PROJECT` permite informar o namespace exclusivo fornecido pela sandbox.

Somente no teste, imagens do Docker Hub são obtidas pelo [espelho público do Google](https://docs.cloud.google.com/artifact-registry/docs/pull-cached-dockerhub-images), preservando o digest definido no Compose/Dockerfile. O harness deriva esse overlay dos arquivos versionados, sem duplicar versões ou alterar a configuração do daemon e da produção; outros registros permanecem iguais. Isso evita o limite anônimo do Docker Hub observado no CI. O espelho não garante disponibilidade permanente: imagem ausente ou divergente falha explicitamente, sem trocar versão ou remover a verificação por digest.

O job **Trace server contracts** usa o mesmo harness no PR e na main. O probe testa a página de login por HTTP; não homologa a experiência móvel do painel de terceiros. O aplicativo STAG Plus mantém sua suíte Chromium/Pixel 7/Electron. Certificado público, backup restaurado e capacidade da VPS exigem homologação no destino escolhido.

## Homologação definida antes dos testes

| Área                          | Cenário e aceite                                                                                                                | Evidência                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Caminho feliz                 | Inicializar stack, enviar OTLP/HTTP JSON e consultar trace persistido                                                           | Containers Langfuse reais e metadados sintéticos  |
| Validações                    | Segredos obrigatórios, URL sem credenciais, HTTP somente em loopback, arquivo existente preservado                              | Testes do gerador e Compose real                  |
| Autenticação e segregação     | Ingestão/consulta sem chave ou com chave inválida recusadas; projeto B não lê trace de A                                        | Duas chaves de projetos descartáveis              |
| Duplicatas                    | Reenvio do mesmo trace/span não cria observações extras                                                                         | Consulta pela API                                 |
| Recuperação                   | Falha de conexão observada; reinício preserva dados e aceita novo trace                                                         | Stop/start da stack, volumes do mesmo teste       |
| Privacidade e observabilidade | Fixture contém somente metadados previstos; nenhuma entrada/saída; logs do harness não expõem payloads ou segredos              | Inspeção do trace persistido, mensagens por etapa |
| Rede e HTTPS                  | Somente UI em loopback; bancos/worker sem portas publicadas; proxy TLS validado                                                 | Compose normalizado e Caddy real                  |
| Dispositivos                  | API independe de navegador; página de login do dashboard responde; regressões STAG Plus em Chromium compacto/Pixel 7 e Electron | Smoke HTTP e suíte desktop existente              |
| Dados de teste                | Projeto Compose exclusivo, contas `.invalid`, credenciais aleatórias e volumes descartados inclusive em falha                   | Harness sem acesso ao Codex ou a contas reais     |

As fixtures comprovam transporte e configuração. Não comprovam filtragem futura do STAG Plus nem obediência semântica do modelo. Langfuse aceita conteúdo arbitrário autenticado: a política de somente metadados deverá ser aplicada **antes** do envio pelo aplicativo.
