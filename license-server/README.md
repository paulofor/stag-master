# Servidor de licenças do STAG Plus

Serviço independente, versão **0.1.0**, com administração pelo navegador, API de ativação e PostgreSQL. Desenvolvido por **Paulo Forestieri**, sob a licença proprietária da raiz do repositório. Não usa contas, tokens ou configurações do Codex e não recebe conversas, projetos ou credenciais das conexões do STAG Plus.

Esta entrega cria o servidor. O aplicativo Windows **ainda não consulta nem exige uma licença deste serviço**; essa integração será uma próxima etapa, depois da definição do destino e da chave pública confiável. A pasta `server/` continua destinada somente a traces. O VPS e o domínio ainda serão escolhidos; nenhum serviço produtivo é publicado por este módulo.

## Administração pelo navegador

O painel permite:

- Entrar com o administrador inicial e alterar sua senha.
- Emitir licença de avaliação, inicialmente por **30 dias e um computador**, com prazo de 1–3.650 dias e limite de 1–100 computadores.
- Buscar licenças, acompanhar dispositivos e conferir acessos vigentes, vencidos, revogados ou próximos de vencer.
- Alterar identificação, validade e limite; prorrogar em 30 dias; revogar e reativar explicitamente.
- Liberar um computador para troca e gerar novo código quando o anterior for perdido/compartilhado.
- Consultar auditoria recente, sem conteúdo das solicitações, nomes de máquinas, senhas, códigos ou tokens.

O código completo aparece **somente na emissão ou na rotação**. O banco mantém seu hash e um sufixo de identificação. Gerar novo código desabilita as ativações anteriores. A liberação de uma máquina disponibiliza a vaga; o antigo titular ainda pode ativar de novo se conservar o código e houver uma vaga. Para impedir isso, revogue a licença ou gere outro código.

## Executar com Docker

Pré-requisitos: Docker Engine, Buildx e Compose v2.24.4+ (ou v5). Na raiz do checkout:

```sh
docker version
docker buildx version
docker compose version
docker compose -p stag-licenses-local -f license-server/compose.yaml build license-server postgres setup
LOCAL_UID=$(id -u) LOCAL_GID=$(id -g) docker compose -p stag-licenses-local -f license-server/compose.yaml --profile setup run --rm --no-deps setup
docker compose -p stag-licenses-local --env-file license-server/.env -f license-server/compose.yaml up -d --wait
```

Abra **http://127.0.0.1:8080**. Usuário inicial: `admin`. Abra localmente `license-server/.secrets/initial-admin-password.txt` em um editor para obter a senha, entre e altere-a no painel. Não envie senha ou chave privada pela conversa. O setup usa a imagem construída pelos arquivos versionados e uma montagem da própria pasta; não precisa instalar Node no VPS. A variante Node para desenvolvimento é `npm ci --prefix license-server --include=dev`, `npm --prefix license-server run build` e `node license-server/scripts/init.mjs`.

O gerador recusa destinos existentes, inclusive links, e não sobrescreve segredos ou configuração. O diretório `.secrets` tem permissão 0700 no Linux; a senha inicial tem 0600. Os arquivos montados como Docker secrets têm leitura 0444 porque o Compose preserva as permissões do arquivo de origem, permitindo leitura pelo serviço sem root; o diretório privado limita seu acesso no host. No Windows, proteja a pasta também pelas permissões NTFS apropriadas. Arquivos são ignorados pelo Git e excluídos dos contextos de build. Cada serviço recebe somente seus próprios segredos em montagem somente leitura. A senha inicial não é montada no serviço.

Inicialização do administrador é idempotente: reiniciar não restaura a senha inicial. A senha alterada é persistida com scrypt e salt; trocar o hash de bootstrap não redefine um usuário existente. As sessões duram até oito horas e são invalidadas na alteração de senha. O painel usa cookie HttpOnly/SameSite=Strict, proteção de origem e CSRF; fora de loopback exige HTTPS e cookie Secure. A limitação de tentativas usa o endereço do socket, ignorando headers de encaminhamento não confiáveis; atrás de um proxy, operadores compartilham o limite conservador de dez tentativas de login em cinco minutos.

O app fica em `127.0.0.1`; o banco não publica porta e usa rede interna. O container do serviço não roda como root, tem filesystem somente leitura, limites de memória/processos e logs com rotação. Para parar preservando cadastros, use o mesmo comando com `down`. **`down --volumes` apaga o banco** e é reservado a dados descartáveis.

PostgreSQL também é construído pelo Dockerfile versionado. Seu bootstrap cria um usuário da aplicação sem privilégios de superusuário, criação de bancos/roles ou replicação. A credencial de administração do banco é separada e recebida somente pelo container PostgreSQL; não é montada na API. O bootstrap ocorre na primeira criação do volume. Atualizações de schema são transacionais, com bloqueio de migração, e não reinicializam cadastros.

## API para a futura integração

`POST /api/v1/activate`, `/refresh` e `/deactivate` recebem JSON com:

| Campo        | Uso                                                                       |
| ------------ | ------------------------------------------------------------------------- |
| `credential` | Código completo na ativação; token opaco da ativação nas demais operações |
| `publicKey`  | Chave Ed25519 da instalação, SPKI DER em base64url                        |
| `deviceName` | Identificação curta, sem caminho/serial/dado pessoal necessário           |
| `nonce`      | UUID v4 novo por solicitação                                              |
| `issuedAt`   | Instante em milissegundos, diferença máxima de cinco minutos              |
| `signature`  | Assinatura Ed25519 da prova construída pelo cliente de referência         |

O [cliente de referência](client/client.mjs) importa a implementação real da prova/verificação após o build. `createDevice()` gera uma identidade por instalação; `deviceRequest()` vincula operação, credencial, chave, nome, nonce e instante; `requestLicense()` exige HTTPS fora de loopback, valida TLS, recusa redirects e não repete solicitações automaticamente. Uma resposta perdida exige conferir o estado antes de reenviar. Reativar a mesma instalação com uma nova prova mantém a vaga e troca o token de renovação anterior.

O desktop futuro deve guardar a chave privada da instalação, token e cache de licença no armazenamento protegido do sistema, somente no main. Esta identidade **não comprova hardware físico**: copiar essa chave privada pode copiar a identidade. O servidor não coleta MAC, serial, nome de usuário Windows ou caminho dos projetos. Nenhuma proteção local impede toda adulteração de um executável; a API controla ativações e renovações válidas.

Ativação/renovação retornam `{lease, activationToken?, refreshAfterSeconds}`. `lease` contém `keyId`, `payload` e `signature`: Ed25519 sobre `STAG-PLUS-LEASE-V1.` mais o payload em base64url. O payload vincula licença, ativação, hash da chave de instalação, audiência `stag-plus`, emissão e vencimentos. A assinatura usa [crypto do Node](https://nodejs.org/docs/latest-v22.x/api/crypto.html).

O cliente precisa confiar na chave pública de emissão **pré-configurada**, como o arquivo `.secrets/public-key.pem` entregue por um canal confiável. `GET /api/v1/public-key` apenas divulga a chave; confiar só na chave devolvida pelo mesmo servidor que emite a autorização permite sua substituição. Nunca distribua `signing-key.pem`. A rotação da chave de emissão exige atualizar a confiança dos clientes e planejar o fim das autorizações antigas; trocar arquivos sem esse plano não é uma operação de painel.

A autorização offline dura no máximo **48 horas**, configurável para menos por `OFFLINE_HOURS`, e nunca ultrapassa a validade da licença. Recomenda-se renovar a cada hora conforme `refreshAfterSeconds`. Revogação, liberação e troca de código impedem novas renovações; autorizações já assinadas podem permanecer válidas até seu vencimento. O cliente futuro deve tratar recusa explícita como revogação/expiração e usar cache apenas em indisponibilidade de rede/serviço, com proteção contra retrocesso do relógio. O verificador de referência confere assinatura, identidade e prazos; não protege sozinho o relógio do Windows.

O servidor serializa mudanças na mesma licença com [bloqueio de linha do PostgreSQL](https://www.postgresql.org/docs/current/explicit-locking.html). Duas ativações concorrentes não ultrapassam o limite. Provas já consumidas são recusadas por nonce; não há importação de identidade de outro projeto, acesso às ferramentas ou alteração das políticas do STAG Plus por uma licença.

## Saúde, backup e recuperação

`GET /health/live` indica processo ativo; `/health/ready` consulta o banco. Falhas retornam erro sanitizado e um `requestId`. Logs têm categoria fixa, status e duração; não registram URLs, headers, SQL, corpos, credenciais ou erros brutos do banco. O painel tem contadores administrativos e auditoria de IDs/ações, retida por 90 dias. Nenhum exportador de telemetria é habilitado.

Backup consistente e restauração usam as ferramentas nativas do PostgreSQL, com arquivo local privado. Na raiz do repositório:

```sh
mkdir -m 700 license-server/backups
LICENSE_COMPOSE_PROJECT=stag-licenses-local bash license-server/scripts/backup.sh backup license-server/backups/licenses.dump
# Execute com o app parado e confirme a substituição dos dados somente no destino apropriado:
LICENSE_COMPOSE_PROJECT=stag-licenses-local bash license-server/scripts/backup.sh restore license-server/backups/licenses.dump --confirm-replace
```

O backup não sobrescreve arquivos existentes. Restauração substitui os cadastros e exige a opção explícita. Preserve também `.secrets` em armazenamento protegido: restaurar só o banco não recupera a chave de emissão. Não use cópia de volume aberto como backup consistente. Para perdas de acesso administrativo, preserve os dados e use um procedimento operacional revisado para substituir a senha no banco e invalidar sessões; o serviço não oferece endpoint público de recuperação.

## Preparação para o VPS

Quando forem definidos VPS, domínio e responsável pelos backups, crie segredos novos diretamente no ambiente de implantação e informe `PUBLIC_URL=https://licencas.seu-dominio` ao setup. Para a porta padrão HTTPS 443, ele prepara `LICENSE_DOMAIN`. O domínio precisa apontar ao servidor e permitir as portas 80/443.

`compose.https.yaml` acrescenta Caddy construído por Dockerfile versionado, TLS automático, limite de requisição e volumes de certificados. O serviço usa o domínio como origem do painel; a porta interna continua em loopback. O banco não fica público. O [mecanismo de secrets do Compose](https://docs.docker.com/compose/how-tos/use-secrets/) monta somente os arquivos autorizados nos serviços.

A publicação será feita pelo fluxo PR/pipeline a configurar para o VPS escolhido, consumindo este Compose, Dockerfiles, commit validado e segredos protegidos. Não publicar por SSH nem usar imagem criada fora dos arquivos versionados. Antes de liberar colegas, homologar HTTPS real, saúde, restauração de backup, acesso administrativo e a integração do desktop. Esta entrega não cria um workflow de deploy fictício sem destino. O workflow **License Server CI** valida o módulo no PR e na main; **Desktop CI** mantém as regressões do aplicativo Windows.

## Homologação local

```sh
npm ci --include=dev
npm ci --prefix license-server --include=dev --ignore-scripts
npx playwright install --with-deps chromium
npm run test:licenses
```

Na sandbox gerenciada, informe sempre o projeto Compose exclusivo disponibilizado para a tarefa em `STAG_TEST_COMPOSE_PROJECT`. O harness recusa containers/volumes preexistentes, gera senhas e identidades descartáveis, importa cliente/verificador reais, testa PostgreSQL, API, painel Chromium desktop/Pixel 7, reinício e backup/restauração. Reutiliza o espelho de imagens do harness de traces preservando os digests de produção. Aguarda `down --volumes --remove-orphans` em sucesso/falha e remove credenciais/dumps temporários. Somente screenshots do painel sem códigos e um relatório de validação podem permanecer em `.local`; o CI os publica como evidência. Veja a [matriz definida antes dos testes](HOMOLOGACAO.md).

Se a engine Docker estiver isolada do filesystem local, `STAG_TEST_SECRETS_VIA_STDIN=1` seleciona o transporte de secrets **somente do teste**: stdin para volumes efêmeros separados, sem segredos na imagem, argumentos ou ambiente. O Compose de produção permanece com mounts de arquivos, utilizados por padrão no CI. Essa opção não altera raízes ou acesso da sandbox.

Esse perfil também usa um relay HTTP limitado por pipes, de loopback da sandbox para destino fixo no container, quando a engine possui loopback próprio. Os serviços, navegador e banco continuam reais; não há Docker socket nos containers, host network ou porta pública. O transporte normal do Compose é validado pelo CI.
