/**
 * What a Code Mode turn in mode `plan` is told, and what an accepted plan turns into. The agent reads the code,
 * changes nothing, and its final answer is the plan the owner accepts, revises or rejects (`code/turn.ts`).
 */
const PLAN_RULES = `You are in Plan mode. Do not change any file and do not run a command that changes the checkout. Read the code you need, then answer with a plan in Markdown. Your final message is the plan and nothing else: no preamble, no question, no sign-off.

The plan has these three sections, with these headings. Write the whole plan, headings included, in the language of the owner's message: a message in Portuguese gets Portuguese headings, translated from the English ones below.

## What exists
What the code does today that matters for this request, naming the files and symbols.

## What changes
The steps you will take, in order, with the file each one touches and the tests that prove it.

## What I will not do
What you leave out on purpose, so the owner can see the edge of the work.`

/** The prompt of a plan turn: the rules, then what the owner asked or answered. */
export const planPrompt = (message: string): string =>
  `${PLAN_RULES}\n\nThe owner's message:\n\n${message}`

/** The message an accepted plan becomes: the plan itself and the instruction to carry it out. */
export const acceptedPlanMessage = (plan: string): string =>
  `${plan}\n\nThe plan above is accepted. Carry it out now: make the changes it lists, in order, and nothing it lists under what you will not do. Run the tests it names.`
