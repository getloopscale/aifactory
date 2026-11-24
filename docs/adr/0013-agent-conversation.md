# ADR 0013: conversa com os agentes (spikes S2 e S3)

Status: **não verificado**. Os spikes não foram rodados.

## Contexto

O M13 (`docs/PLAN.md`) depende de duas respostas que só um sandbox real dá:

- **S2:** uma mensagem alcança o processo em execução? O passo atual sobrevive? O modo Perguntar
  (Claude `--permission-mode plan`, Codex `--sandbox read-only`) impede escrita?
- **S3:** a sessão do CLI, salva fora do sandbox e restaurada num sandbox novo, responde sobre um fato
  dito antes?

## Execução

O roteiro é `spikes/vercel-sandbox/04-agent-conversation.mjs`, um CLI por vez
(`node --env-file=.env.local spikes/vercel-sandbox/04-agent-conversation.mjs claude|codex`). A chave do
provedor é anexada pelo firewall e nunca entra no sandbox; o texto chega ao CLI por arquivo. Ele imprime
só versão, código de saída, duração, se o fato único voltou e o `git status` depois do modo Perguntar.

O ambiente do builder não tem credenciais do Vercel Sandbox, da Anthropic nem da OpenAI (e não deve
tê-las). Nada foi rodado, e nenhum resultado abaixo é evidência.

## Resultados

| Pergunta                                               | Claude     | Codex      |
| ------------------------------------------------------ | ---------- | ---------- |
| Versão do CLI                                          | não rodado | não rodado |
| S2: mensagem chega ao processo em execução             | não rodado | não rodado |
| S2: o passo em andamento sobrevive                     | não rodado | não rodado |
| S2: Perguntar não escreve (árvore e HEAD)              | não rodado | não rodado |
| S3: fato único lembrado após restaurar em sandbox novo | não rodado | não rodado |
| S3: estado mínimo da sessão                            | não rodado | não rodado |

## Decisão

Nenhum mecanismo está escolhido. O desenho do M13 permanece o do plano, **como hipótese**:

- entrega: stdin onde existir; senão interromper e retomar. O roteiro mede só o segundo caminho; o
  `stream-json` por stdin precisa de teste próprio, pois o backend da fábrica não expõe stdin, mas o `runCommand` do SDK tem `stdin: true`, ainda não testado;
- isolamento do Perguntar: confirmar pela árvore de trabalho e pelo `git status`, não só pelo SHA da branch;
- sessão: arquivos da pasta de sessões do CLI guardados em `agent_session`.

## Pendente (bloqueado por credenciais, precisa de uma pessoa)

Rodar o roteiro para os dois CLIs com credenciais válidas, preencher a tabela com a saída (sem segredos nem
conteúdo de sessão), escolher os mecanismos e reescrever o M13 se algo contradisser. A implementação do M13
não começa antes disso.
