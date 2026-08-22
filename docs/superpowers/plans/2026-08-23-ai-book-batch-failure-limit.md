# AI Book Batch Failure Limit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the manual AI资料 catch-up batch after three consecutive chapter-update failures and show a model-configuration warning without changing reader background auto-updates.

**Architecture:** Add a focused batch runner that owns ordered iteration and the consecutive-failure policy. Make `runChapterUpdate` propagate its already-persisted error only when the manual batch opts in, then let `AiBookView` map the batch result to success, partial-failure, or threshold-error feedback.

**Tech Stack:** Vue 3, Pinia, TypeScript, Vitest, Vite, Rust/Cargo regression suite

---

## File Map

- Create `frontend/src/utils/aiBookBatchUpdate.ts`: domain-specific ordered batch runner, result type, fixed threshold, and threshold error.
- Create `frontend/src/utils/aiBookBatchUpdate.test.ts`: red-green coverage for stop, reset, partial completion, and success.
- Modify `frontend/src/stores/aiBook.ts`: add opt-in `throwOnError` behavior after persisting `lastError`.
- Create `frontend/src/stores/aiBookChapterUpdate.test.ts`: prove manual propagation and unchanged default behavior.
- Modify `frontend/src/views/AiBookView.vue`: delegate the manual loop and show the correct toast outcome.

### Task 1: Consecutive-Failure Batch Runner

**Files:**
- Create: `frontend/src/utils/aiBookBatchUpdate.test.ts`
- Create: `frontend/src/utils/aiBookBatchUpdate.ts`

- [ ] **Step 1: Write the failing batch-runner tests**

Create `frontend/src/utils/aiBookBatchUpdate.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import type { AiBookMemory, BookChapter } from '../types'
import {
  AiBookBatchFailureLimitError,
  runAiBookBatchUpdate,
} from './aiBookBatchUpdate'

const chapters: BookChapter[] = Array.from({ length: 5 }, (_, index) => ({
  title: `第 ${index + 1} 章`,
  url: `chapter-${index + 1}`,
  index,
}))

function memory(processedChapterIndex = -1): AiBookMemory {
  return {
    bookUrl: 'book-1',
    enabled: true,
    processedChapterIndex,
    updatedAt: 0,
    worldview: [],
    characters: [],
    relationships: [],
    locations: [],
  }
}

describe('runAiBookBatchUpdate', () => {
  it('stops after three consecutive failures without starting later chapters', async () => {
    const updateChapter = vi.fn(async ({ index }: { index: number }) => {
      throw new Error(`model failure ${index + 1}`)
    })

    await expect(runAiBookBatchUpdate({
      chapters,
      startIndex: 0,
      targetIndex: 4,
      initialMemory: memory(),
      updateChapter,
    })).rejects.toMatchObject({
      name: 'AiBookBatchFailureLimitError',
      lastError: 'model failure 3',
    } satisfies Partial<AiBookBatchFailureLimitError>)

    expect(updateChapter).toHaveBeenCalledTimes(3)
    expect(updateChapter.mock.calls.map(([params]) => params.index)).toEqual([0, 1, 2])
  })

  it('resets the consecutive failure count after a success', async () => {
    const updateChapter = vi.fn(async ({ index, current }: {
      index: number
      current: AiBookMemory
    }) => {
      if (index === 2) return { ...current, processedChapterIndex: index }
      throw new Error(`model failure ${index + 1}`)
    })

    const result = await runAiBookBatchUpdate({
      chapters,
      startIndex: 0,
      targetIndex: 4,
      initialMemory: memory(),
      updateChapter,
    })

    expect(updateChapter).toHaveBeenCalledTimes(5)
    expect(result.memory.processedChapterIndex).toBe(2)
    expect(result.trailingFailures).toBe(2)
    expect(result.lastError).toBe('model failure 5')
  })

  it('returns a clean completion result when every chapter succeeds', async () => {
    const updateChapter = vi.fn(async ({ index, current }: {
      index: number
      current: AiBookMemory
    }) => ({ ...current, processedChapterIndex: index }))

    const result = await runAiBookBatchUpdate({
      chapters,
      startIndex: 0,
      targetIndex: 4,
      initialMemory: memory(),
      updateChapter,
    })

    expect(result.memory.processedChapterIndex).toBe(4)
    expect(result.trailingFailures).toBe(0)
    expect(result.lastError).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
cd frontend
npm test -- src/utils/aiBookBatchUpdate.test.ts
```

Expected: FAIL because `./aiBookBatchUpdate` does not exist.

- [ ] **Step 3: Implement the minimal batch runner**

Create `frontend/src/utils/aiBookBatchUpdate.ts`:

```ts
import type { AiBookMemory, BookChapter } from '../types'

export const AI_BOOK_BATCH_FAILURE_LIMIT = 3

export interface AiBookBatchUpdateResult {
  memory: AiBookMemory
  trailingFailures: number
  lastError?: string
}

interface AiBookBatchUpdateParams {
  chapters: BookChapter[]
  startIndex: number
  targetIndex: number
  initialMemory: AiBookMemory
  updateChapter: (params: {
    index: number
    chapter: BookChapter
    current: AiBookMemory
  }) => Promise<AiBookMemory>
}

export class AiBookBatchFailureLimitError extends Error {
  readonly lastError: string

  constructor(lastError: string) {
    super(`AI 模型连续调用失败 ${AI_BOOK_BATCH_FAILURE_LIMIT} 次，已停止更新。请检查接口地址、模型名称和密钥。最后错误：${lastError}`)
    this.name = 'AiBookBatchFailureLimitError'
    this.lastError = lastError
  }
}

export async function runAiBookBatchUpdate({
  chapters,
  startIndex,
  targetIndex,
  initialMemory,
  updateChapter,
}: AiBookBatchUpdateParams): Promise<AiBookBatchUpdateResult> {
  let current = initialMemory
  let trailingFailures = 0
  let lastError: string | undefined

  for (let index = startIndex; index <= targetIndex; index += 1) {
    const chapter = chapters[index]
    if (!chapter) continue

    try {
      current = await updateChapter({ index, chapter, current })
      trailingFailures = 0
      lastError = undefined
    } catch (error) {
      trailingFailures += 1
      lastError = errorMessage(error)
      if (trailingFailures >= AI_BOOK_BATCH_FAILURE_LIMIT) {
        throw new AiBookBatchFailureLimitError(lastError)
      }
    }
  }

  return { memory: current, trailingFailures, lastError }
}

function errorMessage(error: unknown) {
  return error instanceof Error && error.message
    ? error.message
    : 'AI 资料更新失败'
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
cd frontend
npm test -- src/utils/aiBookBatchUpdate.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit the batch runner**

```bash
git add frontend/src/utils/aiBookBatchUpdate.ts frontend/src/utils/aiBookBatchUpdate.test.ts
git commit -m "feat: limit consecutive AI book batch failures"
```

### Task 2: Opt-In Single-Chapter Error Propagation

**Files:**
- Create: `frontend/src/stores/aiBookChapterUpdate.test.ts`
- Modify: `frontend/src/stores/aiBook.ts:139-205`

- [ ] **Step 1: Write failing store tests**

Create `frontend/src/stores/aiBookChapterUpdate.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { AiBookMemory, Book, BookChapter } from '../types'
import { saveAiBookMemory } from '../api/aiBook'
import { requestAiBookMemoryUpdate } from '../utils/aiBookGeneration'
import { useAiBookStore } from './aiBook'

vi.mock('../api/aiModel', () => ({
  getAiModelConfig: vi.fn(),
}))

vi.mock('../api/aiBook', () => ({
  getAiBookMemory: vi.fn(),
  saveAiBookMemory: vi.fn(),
  deleteAiBookMemory: vi.fn(),
}))

vi.mock('../utils/aiBookGeneration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/aiBookGeneration')>()
  return {
    ...actual,
    requestAiBookMemoryUpdate: vi.fn(),
  }
})

const requestUpdateMock = vi.mocked(requestAiBookMemoryUpdate)
const saveMemoryMock = vi.mocked(saveAiBookMemory)
const book: Book = {
  name: '测试小说',
  author: '测试作者',
  bookUrl: 'book-1',
  origin: 'source-1',
}
const chapter: BookChapter = {
  title: '第一章 开端',
  url: 'chapter-1',
  index: 0,
}

function currentMemory(): AiBookMemory {
  return {
    bookUrl: book.bookUrl,
    bookName: book.name,
    author: book.author,
    enabled: true,
    updatedAt: 0,
    worldview: [],
    characters: [],
    relationships: [],
    locations: [],
  }
}

describe('aiBook store chapter update failures', () => {
  beforeEach(() => {
    installLocalStorage()
    setActivePinia(createPinia())
    vi.stubGlobal('window', { setTimeout: vi.fn() })
    requestUpdateMock.mockReset()
    saveMemoryMock.mockReset()
    saveMemoryMock.mockImplementation(async (memory) => memory)
  })

  it('propagates a manual batch failure after persisting lastError', async () => {
    requestUpdateMock.mockRejectedValue(new Error('401 invalid API key'))
    const store = useAiBookStore()

    await expect(store.runChapterUpdate({
      book,
      chapter,
      chapterContent: '正文',
      current: currentMemory(),
      chapters: [chapter],
      throwOnError: true,
    })).rejects.toThrow('401 invalid API key')

    expect(saveMemoryMock).toHaveBeenCalledWith(expect.objectContaining({
      lastError: '401 invalid API key',
    }))
    expect(store.memory?.lastError).toBe('401 invalid API key')
  })

  it('keeps background updates non-throwing by default', async () => {
    requestUpdateMock.mockRejectedValue(new Error('model unavailable'))
    const store = useAiBookStore()

    await expect(store.runChapterUpdate({
      book,
      chapter,
      chapterContent: '正文',
      current: currentMemory(),
      chapters: [chapter],
    })).resolves.toMatchObject({ lastError: 'model unavailable' })
  })
})

function installLocalStorage() {
  const values = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key: string) => values.get(key) || null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    },
    configurable: true,
  })
}
```

- [ ] **Step 2: Run the store test and verify RED**

Run:

```bash
cd frontend
npm test -- src/stores/aiBookChapterUpdate.test.ts
```

Expected: the first test fails because `runChapterUpdate` resolves instead of rejecting and `throwOnError` is not accepted by the parameter type.

- [ ] **Step 3: Add opt-in propagation after persistence**

In `frontend/src/stores/aiBook.ts`, extend the parameter type:

```ts
  async function runChapterUpdate(params: {
    book: Book
    chapter: BookChapter
    chapterContent: string
    current?: AiBookMemory
    allowSkip?: boolean
    chapters?: BookChapter[]
    throwOnError?: boolean
  }) {
```

Replace the end of the catch block with:

```ts
      memory.value = await saveAiBookMemory(failed).catch(() => failed)
      if (params.throwOnError) {
        throw error instanceof Error ? error : new Error(message)
      }
      return memory.value
```

- [ ] **Step 4: Run the store test and verify GREEN**

Run:

```bash
cd frontend
npm test -- src/stores/aiBookChapterUpdate.test.ts
```

Expected: 2 tests pass.

- [ ] **Step 5: Commit the store behavior**

```bash
git add frontend/src/stores/aiBook.ts frontend/src/stores/aiBookChapterUpdate.test.ts
git commit -m "fix: expose manual AI chapter update failures"
```

### Task 3: Integrate the Manual Update View

**Files:**
- Modify: `frontend/src/views/AiBookView.vue:509-526,694-725`

- [ ] **Step 1: Import the batch runner**

Add beside the other utility imports in `frontend/src/views/AiBookView.vue`:

```ts
import { runAiBookBatchUpdate } from '../utils/aiBookBatchUpdate'
```

- [ ] **Step 2: Replace the inline loop with the tested runner**

Replace `updateToCurrent` with:

```ts
async function updateToCurrent() {
  const activeBook = book.value
  const initialMemory = memory.value
  if (!activeBook || !initialMemory) return

  const targetIndex = resolveCurrentIndex()
  if (!chapters.value.length) {
    appStore.showToast('目录未加载，无法更新', 'warning')
    return
  }
  const startIndex = Math.max(0, (initialMemory.processedChapterIndex ?? -1) + 1)
  if (startIndex > targetIndex) {
    appStore.showToast('当前进度已更新', 'success')
    return
  }

  try {
    const result = await runAiBookBatchUpdate({
      chapters: chapters.value,
      startIndex,
      targetIndex,
      initialMemory,
      updateChapter: async ({ index, chapter, current }) => {
        const chapterContent = await resolveChapterContent(index, chapter)
        return aiStore.runChapterUpdate({
          book: activeBook,
          chapter,
          chapterContent,
          current,
          chapters: chapters.value,
          throwOnError: true,
        })
      },
    })

    if (result.trailingFailures > 0) {
      appStore.showToast(
        `AI资料未完全更新，最后连续失败 ${result.trailingFailures} 次。最后错误：${result.lastError || 'AI 资料更新失败'}`,
        'warning',
      )
      return
    }
    appStore.showToast('AI资料已更新', 'success')
  } catch (error) {
    appStore.showToast((error as Error).message || 'AI资料更新失败', 'error')
  }
}
```

- [ ] **Step 3: Run the focused frontend tests**

Run:

```bash
cd frontend
npm test -- src/utils/aiBookBatchUpdate.test.ts src/stores/aiBookChapterUpdate.test.ts
```

Expected: 5 tests pass.

- [ ] **Step 4: Run the TypeScript and production build gate**

Run:

```bash
cd frontend
npm run build
```

Expected: `vue-tsc -b` and `vite build` exit 0.

- [ ] **Step 5: Commit the view integration**

```bash
git add frontend/src/views/AiBookView.vue
git commit -m "feat: stop repeated AI book batch failures"
```

### Task 4: Full Regression Verification

**Files:**
- Verify only; no planned production changes.

- [ ] **Step 1: Run the complete frontend test suite**

Run:

```bash
cd frontend
npm test
```

Expected: all test files pass with zero failures.

- [ ] **Step 2: Run the frontend production build again from the final tree**

Run:

```bash
cd frontend
npm run build
```

Expected: exit 0 with production assets emitted to `frontend/dist`.

- [ ] **Step 3: Check Rust formatting**

Run:

```bash
cargo fmt --all -- --check
```

Expected: exit 0 and no formatting diff.

- [ ] **Step 4: Run the complete Rust suite**

Run:

```bash
cargo test
```

Expected: all non-network tests pass; the existing live YCKCeo test remains ignored.

- [ ] **Step 5: Inspect the final diff and branch state**

Run:

```bash
git diff --check master...HEAD
git status --short --branch
git log --oneline master..HEAD
```

Expected: no whitespace errors, a clean worktree, and only the design, plan, tests, batch runner, store option, and view integration commits on the feature branch.
