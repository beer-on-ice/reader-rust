# Search Infinite Scroll and Session Restoration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Continue multi-source searches when the result page reaches the bottom and restore the previous search session without another request after returning from the reader.

**Architecture:** The Rust SSE endpoint will return a cursor for the contiguous set of source tasks that actually finished, plus an explicit `hasMore` flag. The bookshelf Pinia store will own the in-memory search session across route changes, while `SearchResults.vue` will remain responsible for EventSource lifecycle and document scroll wiring.

**Tech Stack:** Rust/Axum/Tokio, Vue 3, Pinia, TypeScript, Vitest, Docker amd64

---

## File Structure

- Modify `src/api/handlers/book.rs`: calculate and serialize the safe multi-source search cursor.
- Modify `frontend/src/api/search.ts`: expose the multi-source SSE URL builder and send `lastIndex`.
- Create `frontend/src/api/search.test.ts`: verify the SSE pagination URL contract.
- Modify `frontend/src/stores/bookshelf.ts`: own search signature, cursor, pagination, result merge, loading, and scroll state.
- Modify `frontend/src/stores/bookshelf.test.ts`: verify session reuse, reset, pagination completion, and cross-page deduplication.
- Create `frontend/src/utils/searchScroll.ts`: isolate the page-bottom threshold calculation.
- Create `frontend/src/utils/searchScroll.test.ts`: verify the bottom threshold boundary.
- Modify `frontend/src/components/SearchResults.vue`: connect store session state to SSE events, scroll loading, unmount cleanup, and scroll restoration.

### Task 1: Make the Backend Search Cursor Safe

**Files:**
- Modify: `src/api/handlers/book.rs:1830-1995`
- Test: `src/api/handlers/book.rs:3010-3080`

- [ ] **Step 1: Write failing unit tests for progress and payload semantics**

Add the helper imports and these focused tests to the existing `tests` module:

```rust
#[test]
fn search_sse_progress_uses_the_last_started_source_after_tasks_are_drained() {
    assert_eq!(search_sse_progress(24, 100), (23, true));
    assert_eq!(search_sse_progress(100, 100), (99, false));
}

#[test]
fn search_sse_end_payload_includes_cursor_and_has_more() {
    let value: serde_json::Value =
        serde_json::from_str(&json_search_end(47, true)).expect("valid search end JSON");

    assert_eq!(value["lastIndex"], 47);
    assert_eq!(value["hasMore"], true);
}
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
PATH=/opt/homebrew/opt/rustup/bin:$PATH cargo test search_sse_ --lib
```

Expected: compilation fails because `search_sse_progress` and `json_search_end` do not exist.

- [ ] **Step 3: Implement the progress helpers**

Add focused helpers beside the existing SSE JSON helpers:

```rust
fn search_sse_progress(next_index: i32, source_count: usize) -> (i32, bool) {
    let last_index = next_index - 1;
    let has_more = usize::try_from(next_index)
        .map(|index| index < source_count)
        .unwrap_or(false);
    (last_index, has_more)
}

fn json_search_end(last_index: i32, has_more: bool) -> String {
    serde_json::json!({"lastIndex": last_index, "hasMore": has_more}).to_string()
}
```

In `search_book_multi_sse`, keep draining all already-started tasks after the result cap, remove the completion-order `last_idx` cursor, and finish with:

```rust
let (last_index, has_more) = search_sse_progress(idx, sources.len());
let _ = tx
    .send(Event::default().event("end").data(json_search_end(last_index, has_more)))
    .await;
```

Use `json_search_end(last_index, false)` for this endpoint's early error exits. Do not change the shared `json_end` helper used by other SSE endpoints.

- [ ] **Step 4: Run focused and complete Rust tests**

Run:

```bash
PATH=/opt/homebrew/opt/rustup/bin:$PATH cargo test search_sse_ --lib
PATH=/opt/homebrew/opt/rustup/bin:$PATH cargo test
```

Expected: both commands exit 0; the focused tests pass and the existing search-result cap tests remain green.

- [ ] **Step 5: Commit the backend cursor contract**

```bash
git add src/api/handlers/book.rs
git commit -m "fix: return safe multi-source search cursor"
```

### Task 2: Send the Pagination Cursor from the Frontend API

**Files:**
- Create: `frontend/src/api/search.test.ts`
- Modify: `frontend/src/api/search.ts:12-35`

- [ ] **Step 1: Write a failing URL contract test**

Create `frontend/src/api/search.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { buildSearchBookMultiSSEUrl } from './search'

const emptyStorage = { getItem: () => null }

describe('multi-source search SSE URL', () => {
  it('includes the resume cursor and search controls', () => {
    const url = new URL(buildSearchBookMultiSSEUrl({
      key: '三体',
      bookSourceGroup: '精品',
      concurrentCount: 24,
      searchSize: 50,
      lastIndex: 47,
    }, emptyStorage), 'http://reader.test')

    expect(url.searchParams.get('key')).toBe('三体')
    expect(url.searchParams.get('bookSourceGroup')).toBe('精品')
    expect(url.searchParams.get('lastIndex')).toBe('47')
    expect(url.searchParams.get('concurrentCount')).toBe('24')
    expect(url.searchParams.get('searchSize')).toBe('50')
  })
})
```

- [ ] **Step 2: Run the API test and verify RED**

Run:

```bash
cd frontend && npm test -- src/api/search.test.ts
```

Expected: compilation fails because `buildSearchBookMultiSSEUrl` is not exported.

- [ ] **Step 3: Extract the URL builder and add `lastIndex`**

Define a shared parameter type with `lastIndex?: number`, then implement:

```typescript
type StorageLike = Pick<Storage, 'getItem'>

export function buildSearchBookMultiSSEUrl(
  params: SearchBookMultiSSEParams,
  storage: StorageLike = localStorage,
) {
  const query = new URLSearchParams()
  query.set('key', params.key)
  query.set('lastIndex', String(params.lastIndex ?? -1))
  if (params.bookSourceGroup) query.set('bookSourceGroup', params.bookSourceGroup)
  if (params.bookSourceUrl) query.set('bookSourceUrl', params.bookSourceUrl)
  if (params.concurrentCount) query.set('concurrentCount', String(params.concurrentCount))
  if (params.searchSize) query.set('searchSize', String(params.searchSize))
  appendAuthQueryParams(query, storage)
  return `/reader3/searchBookMultiSSE?${query.toString()}`
}
```

Make `searchBookMultiSSE` construct `EventSource` from this builder.

- [ ] **Step 4: Run the focused API test**

Run:

```bash
cd frontend && npm test -- src/api/search.test.ts
```

Expected: 1 test passes.

- [ ] **Step 5: Commit the frontend API contract**

```bash
git add frontend/src/api/search.ts frontend/src/api/search.test.ts
git commit -m "feat: send multi-source search cursor"
```

### Task 3: Store and Reuse the Search Session

**Files:**
- Modify: `frontend/src/stores/bookshelf.ts:149-181,274-285`
- Modify: `frontend/src/stores/bookshelf.test.ts:1-75`

- [ ] **Step 1: Write failing session-state tests**

Extend the existing `bookshelf search state` suite:

```typescript
it('reuses an initialized session with the same search signature', () => {
  const store = useBookshelfStore()
  store.startSearch('三体', { scope: 'all' })

  expect(store.prepareSearchSession()).toBe(true)
  store.completeSearchPage(47, true)

  expect(store.prepareSearchSession()).toBe(false)
  expect(store.searchLastIndex).toBe(47)
  expect(store.searchHasMore).toBe(true)
})

it('resets pagination when the search signature changes', () => {
  const store = useBookshelfStore()
  store.startSearch('三体', { scope: 'all' })
  store.prepareSearchSession()
  store.completeSearchPage(47, true)

  store.startSearch('球状闪电', { scope: 'all' })

  expect(store.prepareSearchSession()).toBe(true)
  expect(store.searchResults).toEqual([])
  expect(store.searchLastIndex).toBe(-1)
  expect(store.searchScrollTop).toBe(0)
})

it('deduplicates normalized title and author across pages', () => {
  const store = useBookshelfStore()

  store.appendSearchResults([
    { name: '三 体', author: '作者：刘慈欣', origin: 'one', bookUrl: 'one/1' },
  ])
  store.appendSearchResults([
    { name: '《三体》', author: '刘慈欣', origin: 'two', bookUrl: 'two/1' },
    { name: '三体全集', author: '刘慈欣', origin: 'two', bookUrl: 'two/2' },
  ])

  expect(store.searchResults.map((book) => book.name)).toEqual(['三 体', '三体全集'])
})

it('guards load more and preserves the saved scroll position', () => {
  const store = useBookshelfStore()
  store.startSearch('三体', { scope: 'all' })

  expect(store.canLoadMoreSearch()).toBe(false)
  store.prepareSearchSession()
  store.completeSearchPage(23, true)
  store.saveSearchScroll(960)

  expect(store.canLoadMoreSearch()).toBe(true)
  expect(store.searchScrollTop).toBe(960)
  store.isSearching = true
  expect(store.canLoadMoreSearch()).toBe(false)
})
```

- [ ] **Step 2: Run the store tests and verify RED**

Run:

```bash
cd frontend && npm test -- src/stores/bookshelf.test.ts
```

Expected: the new methods and state fields are missing.

- [ ] **Step 3: Implement the Pinia search session**

Add these refs and actions to the search section and expose them from the store:

```typescript
const searchSessionSignature = ref('')
const searchLastIndex = ref(-1)
const searchHasMore = ref(true)
const searchInitialized = ref(false)
const searchScrollTop = ref(0)

function currentSearchSignature() {
  return JSON.stringify([
    searchKey.value.trim(),
    searchScope.value,
    searchScope.value === 'group' ? searchGroup.value : '',
    searchScope.value === 'source' ? searchSourceUrl.value : '',
  ])
}

function prepareSearchSession() {
  const signature = currentSearchSignature()
  if (searchInitialized.value && searchSessionSignature.value === signature) return false
  searchResults.value = []
  searchSessionSignature.value = signature
  searchLastIndex.value = -1
  searchHasMore.value = true
  searchInitialized.value = true
  searchScrollTop.value = 0
  return true
}

function completeSearchPage(lastIndex: number, hasMore: boolean) {
  searchLastIndex.value = Math.max(searchLastIndex.value, lastIndex)
  searchHasMore.value = hasMore
  isSearching.value = false
}

function canLoadMoreSearch() {
  return searchInitialized.value
    && searchHasMore.value
    && !isSearching.value
    && searchSessionSignature.value === currentSearchSignature()
}

function saveSearchScroll(scrollTop: number) {
  searchScrollTop.value = Math.max(0, scrollTop)
}
```

Implement `appendSearchResults` with a normalized title-and-author key matching the Rust relevance normalization: lowercase, remove whitespace and common book-title punctuation, and strip a leading `作者` label from authors. Preserve the first result for each key and append only unseen keys.

Make `clearSearch` reset every new session field. `startSearch` continues to update user-selected conditions but does not discard the prior results until `prepareSearchSession` sees a different signature.

- [ ] **Step 4: Run the store test suite**

Run:

```bash
cd frontend && npm test -- src/stores/bookshelf.test.ts
```

Expected: all bookshelf tests pass.

- [ ] **Step 5: Commit the reusable search session**

```bash
git add frontend/src/stores/bookshelf.ts frontend/src/stores/bookshelf.test.ts
git commit -m "feat: preserve paginated search sessions"
```

### Task 4: Add Bottom-Reach Loading and Route Restoration

**Files:**
- Create: `frontend/src/utils/searchScroll.ts`
- Create: `frontend/src/utils/searchScroll.test.ts`
- Modify: `frontend/src/components/SearchResults.vue:1-270`

- [ ] **Step 1: Write a failing boundary test for bottom detection**

Create `frontend/src/utils/searchScroll.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { isNearSearchBottom } from './searchScroll'

describe('search scroll pagination', () => {
  it('loads only inside the bottom threshold', () => {
    expect(isNearSearchBottom(1200, 800, 2200, 240)).toBe(true)
    expect(isNearSearchBottom(1000, 800, 2200, 240)).toBe(false)
  })
})
```

- [ ] **Step 2: Run the scroll test and verify RED**

Run:

```bash
cd frontend && npm test -- src/utils/searchScroll.test.ts
```

Expected: the module cannot be resolved.

- [ ] **Step 3: Implement the threshold helper**

Create:

```typescript
export function isNearSearchBottom(
  scrollTop: number,
  viewportHeight: number,
  documentHeight: number,
  threshold = 240,
) {
  return scrollTop + viewportHeight >= documentHeight - threshold
}
```

- [ ] **Step 4: Rework `SearchResults` around initial and load-more modes**

Replace the unconditional `doSearch` behavior with `openSearch(mode: 'initial' | 'loadMore')`:

```typescript
function openSearch(mode: 'initial' | 'loadMore') {
  if (shelfStore.isSearching) return
  if (mode === 'loadMore' && !shelfStore.canLoadMoreSearch()) return

  shelfStore.isSearching = true
  eventSource = searchBookMultiSSE({
    key: searchKey.value,
    concurrentCount: 24,
    lastIndex: mode === 'loadMore' ? shelfStore.searchLastIndex : -1,
    bookSourceGroup: searchScope.value === 'group' ? selectedGroup.value : undefined,
    bookSourceUrl: searchScope.value === 'source' ? selectedSourceUrl.value : undefined,
  })
}
```

Data events call `shelfStore.appendSearchResults(data.data)`. The `end` listener parses `{ lastIndex, hasMore }`, calls `completeSearchPage`, and closes the connection. Error handlers keep results and cursor, set `isSearching = false`, and close the connection.

The immediate search watcher calls `prepareSearchSession()`. When it returns true, close any old EventSource and clear its loading flag before opening the replacement initial request. A remount with an initialized matching session renders existing results without a request.

Add a passive window scroll listener:

```typescript
function handleWindowScroll() {
  if (restoringScroll || shelfStore.isSearching || !shelfStore.searchHasMore) return
  const root = document.scrollingElement || document.documentElement
  if (isNearSearchBottom(root.scrollTop, window.innerHeight, root.scrollHeight)) {
    openSearch('loadMore')
  }
}
```

Before routing to `/reader`, save the current document scroll position. On mount, add the listener and restore the stored position after `nextTick` plus one animation frame while `restoringScroll` is true. On unmount, remove the listener, close the SSE connection, save the current position, and clear only `isSearching`.

Add a compact footer below `BookGrid` that shows `继续搜索书源中...` during a load-more request and `已搜索全部选定书源` when `searchInitialized && !searchHasMore`.

- [ ] **Step 5: Run the focused frontend tests and type/build checks**

Run:

```bash
cd frontend && npm test -- src/api/search.test.ts src/stores/bookshelf.test.ts src/utils/searchScroll.test.ts
cd frontend && npm run build
```

Expected: all focused tests pass and the production build exits 0 with no TypeScript errors.

- [ ] **Step 6: Commit the page integration**

```bash
git add frontend/src/components/SearchResults.vue frontend/src/utils/searchScroll.ts frontend/src/utils/searchScroll.test.ts
git commit -m "feat: continue search on result scroll"
```

### Task 5: Full Verification and Local amd64 Deployment

**Files:**
- Verify all modified files
- Replace local container: `reader-rust-local-search-fix`

- [ ] **Step 1: Run formatting and all automated tests**

Run:

```bash
PATH=/opt/homebrew/opt/rustup/bin:$PATH cargo fmt --all -- --check
PATH=/opt/homebrew/opt/rustup/bin:$PATH cargo test
cd frontend && npm test
cd frontend && npm run build
```

Expected: every command exits 0; the known Rust dead-code warnings may remain, but there are no test failures or type errors.

- [ ] **Step 2: Review the final diff and session requirements**

Run:

```bash
git diff HEAD~4 --check
git status --short --branch
git log -6 --oneline
```

Confirm the diff contains only the cursor contract, API parameter, session store, scroll integration, tests, and plan/spec documentation.

- [ ] **Step 3: Build the amd64 application and image**

Run:

```bash
DOCKER_DEFAULT_PLATFORM=linux/amd64 PATH=/opt/homebrew/opt/rustup/bin:/Users/doubao/.cargo/bin:$PATH cross build --release --target x86_64-unknown-linux-musl
docker build --platform linux/amd64 -f Dockerfile.x86 -t li99876654/reader-rust:latest -t li99876654/reader-rust:search-scroll-20260822 .
```

Expected: the Rust release binary and both Docker tags build successfully for `linux/amd64`.

- [ ] **Step 4: Replace the exact local test container and smoke test it**

Run:

```bash
docker rm -f reader-rust-local-search-fix
docker run -d --name reader-rust-local-search-fix --platform linux/amd64 -p 127.0.0.1:8080:8080 -v reader-rust-local-data:/app/storage --restart unless-stopped li99876654/reader-rust:latest
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/
```

Expected: the named container is recreated against the existing data volume and the local root returns HTTP 200.

- [ ] **Step 5: Manually verify the two user-visible scenarios**

At `http://127.0.0.1:8080/#/`:

1. Search all sources, record the visible result count, scroll near the bottom, and confirm a new SSE request includes the prior `lastIndex` and appends results without clearing the grid.
2. Open a result, return from the reader, and confirm the same results and scroll position reappear without a new SSE request; then scroll to the bottom and confirm continuation starts.

- [ ] **Step 6: Commit any verification-only formatting changes if present**

If `cargo fmt` changed tracked files during the implementation cycle, stage only those exact files and commit:

```bash
git add src/api/handlers/book.rs
git commit -m "style: format search pagination changes"
```

If there are no formatting changes, do not create an empty commit.
