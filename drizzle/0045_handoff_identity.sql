-- A handoff is identified by its head and its event (`coordinator/exceptions.ts`), as a failure is. A decision
-- recorded on the bare head of a handoff moves to the last handoff of its task recorded before it, which is the
-- one it was decided for: those handoffs stay decided, and a later handoff on the same head gets a decision.
UPDATE "coordinator_action" AS ca
SET "head_sha" = ca."head_sha" || '@' || (
  SELECT max(se."id") FROM "stage_event" AS se
  WHERE se."task_id" = ca."task_id" AND se."stage" = 'handoff' AND se."at" <= ca."at"
)
WHERE ca."exception_kind" IN ('review_plateau', 'review_unusable', 'checks_unchanged', 'handoff')
  AND ca."head_sha" NOT LIKE '%@%'
  AND ca."head_sha" <> 'none'
  AND EXISTS (
    SELECT 1 FROM "stage_event" AS se
    WHERE se."task_id" = ca."task_id" AND se."stage" = 'handoff' AND se."at" <= ca."at"
  );
