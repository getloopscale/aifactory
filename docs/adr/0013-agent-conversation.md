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

O roteiro instala os CLIs nas versões que a fábrica fixa (`CLAUDE_CODE_VERSION`, `CODEX_VERSION`) e aborta
se `--version` ou um passo de preparo falhar, para que uma execução quebrada não pareça resultado.

O ambiente do builder não tem credenciais do Vercel Sandbox, da Anthropic nem da OpenAI (e não deve
tê-las). Nada foi rodado, e nenhum resultado abaixo é evidência.

## Resultados

| Pergunta                                               | Claude     | Codex      |
| ------------------------------------------------------ | ---------- | ---------- |
| Versão do CLI                                          | não rodado | não rodado |
| S2: mensagem chega ao processo em execução             | não rodado | não rodado |
| S2: entrega por stdin (segunda mensagem respondida)    | não rodado | não rodado |
| S2: o passo em andamento sobrevive                     | não rodado | não rodado |
| S2: Perguntar não escreve (árvore e HEAD)              | não rodado | não rodado |
| S3: fato único lembrado após restaurar em sandbox novo | não rodado | não rodado |
| S3: estado mínimo da sessão                            | não rodado | não rodado |

## Decisão

Nenhum mecanismo está escolhido. O desenho do M13 permanece o do plano, **como hipótese**:

- entrega: stdin onde existir; senão interromper e retomar. O roteiro mede os dois
  caminhos: `runCommand({ stdin: true })` com `writeStdin` (Claude `stream-json`, Codex `exec -`) e
  retomar com `--continue`/`resume --last`. A fábrica hoje não expõe stdin; o SDK sim. Ainda não rodado;
- isolamento do Perguntar: confirmar pela árvore de trabalho e pelo `git status`, não só pelo SHA da branch;
- sessão: só a pasta de conversas do CLI (`~/.claude/projects`, `~/.codex/sessions`), sem credenciais nem
  caches, guardada em `agent_session`; o roteiro testa se isso basta.

## Pendente (bloqueado por credenciais, precisa de uma pessoa)

Rodar o roteiro para os dois CLIs com credenciais válidas, preencher a tabela com a saída (sem segredos nem
conteúdo de sessão), escolher os mecanismos e reescrever o M13 se algo contradisser. A implementação do M13
não começa antes disso.

## Superfície dos CLIs verificada sem credenciais (2026-11-24)

Claude Code 2.1.319 e `codex-cli` 0.166.0, só `--help`, sem chamar o modelo. Isto diz que os caminhos
existem, não que funcionam:

- Claude: `--input-format stream-json` existe e só vale com `--print`; `--replay-user-messages` existe;
  `--resume <id>`, `--session-id <uuid>`, `--fork-session`, `--no-session-persistence`; `--permission-mode`
  aceita `plan`.
- Codex: `codex exec resume [SESSION_ID] [PROMPT]` existe e lê o prompt do stdin com `-`; `--sandbox <modo>`
  existe. Não há opção de entrada em fluxo para um `codex exec` já iniciado.

## Outras variantes a provar

- Caixa de correio lida por hook (`PostToolUse` / `UserPromptSubmit`) dentro do sandbox (Claude; n/a no Codex).
- Perguntar: pedir uma escrita por todos os meios (editor, `sed -i`, redirecionamento, `git`) e comparar SHA e
  `git status` antes e depois. Se algo escrever, a garantia vira a checagem do SHA da branch depois da resposta.
- Sessão: o Claude deriva o diretório da sessão do `cwd`, que precisa ser idêntico na restauração; medir o
  tamanho do arquivo e checar se contém segredo antes de guardá-lo.

| Spike                      | Claude     | Codex      | Evidência |
| -------------------------- | ---------- | ---------- | --------- |
| S2 caixa de correio        | não rodado | n/a        | —         |
| S2 interromper e retomar   | não rodado | não rodado | —         |
