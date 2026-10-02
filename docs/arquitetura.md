# Arquitetura inicial

```
Painel React → preload restrito → serviço no processo Electron main
                                       ↕ JSONL por stdio
                              Codex App Server local
                                       ↕
                         Conta ChatGPT / shell / Git / web
```

O main inicia o executável nativo do Codex fixado em `package-lock.json`, empacotado pelo build do repositório. Não há proxy remoto, chave de API ou dependência do terminal global. O login é `account/login/start` com `type: chatgpt`; o navegador abre somente a URL de autenticação validada. O próprio Codex recebe o callback, persiste e renova tokens. Cada instalação usa `userData/codex`, separado de outros clientes Codex.

`RpcClient` correlaciona respostas, trata requests reversos, limita frames e rejeita chamadas ao encerrar. `AssistantService` controla projeto, modelos, histórico, permissões e turnos. O renderer recebe somente estado público selecionado. Tokens de login, conteúdo de raciocínio e respostas completas de conta nunca atravessam a ponte.

O modo **Leitura** usa sandbox read-only. **Projeto**, padrão, habilita mudanças no diretório escolhido e acesso de rede com aprovações on-request. **Windows** exige consentimento por conversa e usa full access para shell do cliente; operações do tool `windows_desktop` têm aprovação específica adicional. Ele oferece listar janelas, focar uma janela, enviar teclas, clicar e capturar a tela principal. O screenshot informa dimensões em pixels; cliques usam essas coordenadas e aceitam monitores com origem negativa. O controle não é executado em Linux. Git, testes e acesso a arquivos ficam nas ferramentas nativas do Codex; o projeto selecionado fornece histórias, AGENTS.md e especificações ao agente.

Histórico e contexto são persistidos pelo Codex. Configuração leve e a política original de cada conversa são persistidas atomicamente pelo main. Retomar uma conversa não amplia acessos nem muda de projeto. Eventos e aprovações são associados ao thread ativo, com limpeza no término/interrupção. Reconectar relê o histórico; não tenta reenviar mensagens automaticamente.

O harness inclui AGENTS.md, instruções do assistente, fixtures bidirecionais, testes de corridas e teste real do executável. A lacuna observada no início foi a ausência de contratos/testes em um repositório vazio, especialmente para requests de aprovação e deltas fora de ordem. O simulador e o smoke real cobrem essa lacuna sem credenciais ou infraestrutura adicional.

Fontes: [Codex App Server](https://learn.chatgpt.com/docs/app-server), [segurança Electron](https://www.electronjs.org/docs/latest/tutorial/security), [empacotamento Windows](https://www.electron.build/v26/docs/win/). As ferramentas dinâmicas do App Server são experimentais; a versão é fixada e seu contrato é exercitado nos testes.
