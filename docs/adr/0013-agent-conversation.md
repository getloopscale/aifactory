# ADR 0013 — Conversa com os agentes (M13): spikes S2 e S3

## Status

**Aberto.** Os spikes S2 e S3 do `docs/PLAN.md` (M13) **não foram executados**. Este ADR registra o que
se sabe sem credenciais e o que falta provar. Nenhum mecanismo foi escolhido e nada de M13 foi implementado
(a implementação é o #494, depois dos spikes).

## Por que não foram executados

A passada que escreveu este ADR rodou sem `ANTHROPIC_API_KEY`, sem credencial da OpenAI/Codex e sem a
capacidade de parar e recriar um sandbox (só havia o sandbox em que o agente rodava). Os dois spikes exigem
modelo real e sandbox real. Registrar um resultado sem essa evidência seria inventá-lo.

## O que foi verificado (só a superfície dos CLIs, 2026-11-24)

Claude Code 2.1.319 e `codex-cli` 0.166.0, `--help`, sem chamar o modelo:

- Claude: `--input-format stream-json` existe e só vale com `--print`; `--replay-user-messages` existe;
  `--resume <id>`, `--session-id <uuid>`, `--fork-session`, `--no-session-persistence`; `--permission-mode`
  aceita `plan`.
- Codex: `codex exec resume [SESSION_ID] [PROMPT]` existe e lê o prompt do stdin com `-`; `--sandbox <modo>`
  existe. **Não há** opção de entrada em fluxo para um `codex exec` já iniciado.

Isto só diz que os caminhos existem. Não diz que funcionam.

## O que cada spike precisa provar

### S2: alcançar um processo em execução

Rodar, no sandbox real, com Claude e com Codex:

1. Claude com `--input-format stream-json`: enviar uma segunda mensagem no stdin com o agente no meio de uma
   ferramenta. Esperado: aparece no transcript e é tratada na virada seguinte sem perder o passo.
2. Caixa de correio lida por hook (`PostToolUse` / `UserPromptSubmit`) dentro do sandbox.
3. Interromper e `--resume` com a mensagem (referência: sempre funciona, perde o passo).
4. Codex: se `codex exec` aceita algo depois de iniciado; se não, interromper e retomar.
5. Modo "perguntar": com `--permission-mode plan` (Claude) e `--sandbox read-only` (Codex), pedir uma escrita
   por todos os meios (editor, `sed -i`, redirecionamento, `git`), e comparar o SHA e `git status` antes e
   depois. Se algo escrever, a garantia vira a checagem do SHA da branch depois da resposta.

### S3: retomar uma sessão em sandbox novo

1. Fim de uma execução: copiar o arquivo de sessão (Claude: `~/.claude/projects/<cwd>/<id>.jsonl`; Codex: a
   pasta de sessões em `~/.codex/sessions`) para o banco (`agent_session`).
2. Novo sandbox clonado da branch, restaurar o arquivo no mesmo caminho (o Claude deriva o diretório do
   `cwd`, que precisa ser idêntico), `claude --resume <id>` / `codex exec resume <id>`.
3. Prova: perguntar sobre algo dito antes da restauração. Medir o tamanho do arquivo e checar se contém
   segredo ou credencial antes de guardá-lo.

## Decisão

Nenhuma ainda. O padrão do plano (stdin onde existir, interromper e retomar como alternativa; sessão no
banco em vez de snapshot) continua como hipótese, não como decisão.

## Consequências

- O M13 segue "Não iniciado". A tabela de resultados abaixo é preenchida por quem rodar os spikes com
  credenciais; se algum falhar, o desenho é reescrito antes de qualquer código, como o plano diz.

| Spike                      | Claude     | Codex      | Evidência |
| -------------------------- | ---------- | ---------- | --------- |
| S2 stdin                   | não rodado | não rodado | —         |
| S2 caixa de correio        | não rodado | n/a        | —         |
| S2 interromper e retomar   | não rodado | não rodado | —         |
| S2 "perguntar" não escreve | não rodado | não rodado | —         |
| S3 restauração             | não rodado | não rodado | —         |
