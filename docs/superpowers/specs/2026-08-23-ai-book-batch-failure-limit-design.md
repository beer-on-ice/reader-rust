# AI Book Batch Failure Limit Design

## Goal

Stop “更新到当前进度” from calling a broken AI model once for every unread chapter. The batch must stop after three consecutive chapter-update failures and tell the user to check the model endpoint, model name, and API key.

## Scope

This change applies only to the manual AI资料 batch update started from `AiBookView`.

It does not change the backend AI proxy, AI memory persistence schema, the number of tool-call rounds within a single model request, or the reader's background single-chapter auto-update policy.

## Current Failure Cause

`AiBookView.updateToCurrent` loops from the first unprocessed chapter through the reader's current chapter. Each iteration awaits `aiStore.runChapterUpdate`.

`runChapterUpdate` currently catches model errors, saves the message to `memory.lastError`, and resolves with the failed memory instead of rejecting. The batch therefore cannot distinguish success from failure, continues with the next chapter, and can eventually display a success toast even though every model call failed.

## Error Propagation Boundary

`runChapterUpdate` will accept an explicit manual-batch option that asks it to propagate an error after saving the existing failure state. The default remains non-throwing so reader background auto-updates retain their current behavior and cannot create unhandled promise rejections.

The failure path keeps the current guarantees before propagating the error:

- preserve the last successfully generated AI memory;
- save the original model error in `lastError`;
- clear the in-flight chapter key in `finally`;
- leave the existing temporary error phase and status behavior intact.

Only the manual batch passes the propagation option.

## Batch Execution

The chapter loop will move into a small domain-specific batch helper so the stopping policy can be tested without mounting the full view.

The helper processes chapter attempts in order and owns a consecutive-failure counter:

1. A successful chapter update replaces the current memory and resets the counter to zero.
2. A failed chapter update preserves the last successful memory, records the error, increments the counter, and continues to the next chapter while the counter is below three.
3. The third consecutive failure throws a batch error immediately. No later chapter is resolved or sent to the model.
4. Missing chapter entries are skipped and do not count as either success or failure.

The limit is a fixed product rule of three, not a user setting. The approved counting unit is consecutive failed chapter updates; it is not three retries of the same chapter.

If the range ends with one or two consecutive failures, the batch reports a partial failure instead of claiming full success. If a later chapter succeeds, the earlier failure count is reset as approved, and the batch may finish normally.

## User Feedback

When the threshold is reached, the existing outer error handler displays:

```text
AI 模型连续调用失败 3 次，已停止更新。请检查接口地址、模型名称和密钥。最后错误：<模型错误>
```

The original model error remains persisted in `memory.lastError` for the existing status panel and detail view. Successfully generated memory before the stop is retained.

When the chapter range ends with fewer than three trailing failures, the view displays a partial-failure warning containing the last model error and does not display `AI资料已更新`.

## Components

- `frontend/src/stores/aiBook.ts`: optionally propagate a single-chapter failure after persisting it; preserve the default background-update behavior.
- A focused frontend batch utility: run ordered chapter updates, track consecutive failures, return a completion outcome, and throw the threshold error.
- `frontend/src/views/AiBookView.vue`: delegate the loop to the utility, enable error propagation for manual updates, and map the result to success, warning, or error toast messages.

No Rust code or backend API contract changes are required.

## Testing

Focused frontend tests will verify:

- three consecutive failures stop after the third attempt and do not call later chapters;
- a successful update resets the consecutive-failure count;
- one or two trailing failures return a partial-failure outcome rather than success;
- manual-batch mode rethrows only after saving `lastError`;
- default single-chapter mode still resolves failed memory for reader background updates;
- successful batches retain their existing success outcome.

Implementation follows red-green-refactor: each behavior test must fail for the expected missing behavior before production code is changed. Final verification includes the focused tests, the full frontend suite, TypeScript/Vite production build, Rust formatting, and the complete Rust test suite.
