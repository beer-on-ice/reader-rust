# Search Relevance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Filter clearly unrelated remote book-source results, rank title/author matches consistently, normalize deduplication, and enforce a hard 50-result limit.

**Architecture:** Add a pure relevance module under `src/model` so handlers and services share normalization, scoring, stable sorting, and limits. Apply it after each source is parsed, again after ordinary multi-source merging, and use a small pure helper to cap/deduplicate SSE batches without buffering the stream.

**Tech Stack:** Rust 2021, Axum handlers, Tokio/Futures SSE, built-in Rust test framework.

---

## File map

- Create `src/model/search_relevance.rs`: normalization, relevance scoring, stable filtering/sorting/truncation, and unit tests.
- Modify `src/model/mod.rs`: export the relevance module.
- Modify `src/model/search.rs`: make `SearchBook::merge_key` use shared normalization.
- Modify `src/service/book_service.rs`: rank/filter every parsed single-source result page.
- Modify `src/api/handlers/book.rs`: stable normalized merging, global ranking/limit, and hard-capped SSE batches.

### Task 1: Pure relevance behavior

**Files:**
- Create: `src/model/search_relevance.rs`
- Modify: `src/model/mod.rs`

- [ ] **Step 1: Export an empty relevance module and write failing behavior tests**

Add `pub mod search_relevance;` to `src/model/mod.rs`. Create tests in `src/model/search_relevance.rs` that call the currently missing public API:

```rust
#[cfg(test)]
mod tests {
    use super::{normalize_search_author, normalize_search_text, rank_search_results};
    use crate::model::search::SearchBook;

    fn book(name: &str, author: &str) -> SearchBook {
        SearchBook { name: name.into(), author: author.into(), ..Default::default() }
    }

    #[test]
    fn normalization_ignores_case_whitespace_book_marks_and_author_prefix() {
        assert_eq!(normalize_search_text(" 《The 三 体：II》 "), "the三体ii");
        assert_eq!(normalize_search_author("作者： 刘 慈 欣"), "刘慈欣");
    }

    #[test]
    fn regular_query_filters_noise_and_orders_title_before_author_matches() {
        let results = rank_search_results(
            "三体",
            vec![
                book("无关作品", "其他作者"),
                book("三体全集", "刘慈欣"),
                book("三体", "刘慈欣"),
                book("刘慈欣作品集", "三体"),
                book("流浪地球", "三体研究者"),
            ],
            50,
        );
        assert_eq!(results.iter().map(|b| b.name.as_str()).collect::<Vec<_>>(),
                   vec!["三体", "三体全集", "刘慈欣作品集", "流浪地球"]);
    }

    #[test]
    fn short_query_keeps_noise_but_ranks_matches_first_and_is_stable() {
        let results = rank_search_results(
            "A",
            vec![book("noise one", "x"), book("A book", "x"), book("noise two", "x")],
            50,
        );
        assert_eq!(results.iter().map(|b| b.name.as_str()).collect::<Vec<_>>(),
                   vec!["A book", "noise one", "noise two"]);
    }

    #[test]
    fn result_limit_is_a_hard_cap() {
        let books = (0..60).map(|i| book(&format!("三体 {i}"), "刘慈欣")).collect();
        assert_eq!(rank_search_results("三体", books, 50).len(), 50);
    }

    #[test]
    fn punctuation_only_query_returns_no_results() {
        assert!(rank_search_results("《 》", vec![book("三体", "刘慈欣")], 50).is_empty());
    }
}
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `cargo test model::search_relevance::tests --lib`

Expected: compilation fails because `normalize_search_author`, `normalize_search_text`, and `rank_search_results` do not exist.

- [ ] **Step 3: Implement the minimal pure relevance module**

Implement the complete module:

```rust
use crate::model::search::SearchBook;

pub const MAX_SEARCH_RESULTS: usize = 50;

fn is_search_separator(ch: char) -> bool {
    ch.is_whitespace()
        || matches!(
            ch,
            '《' | '》' | '〈' | '〉' | '「' | '」' | '『' | '』'
                | '(' | ')' | '（' | '）' | '[' | ']' | '【' | '】'
                | '·' | '-' | '—' | '_' | ':' | '：' | ',' | '，'
                | '.' | '。' | '!' | '！' | '?' | '？' | ';' | '；'
                | '\'' | '"' | '“' | '”' | '‘' | '’' | '/' | '\\' | '|'
        )
}

pub fn normalize_search_text(value: &str) -> String {
    value
        .chars()
        .flat_map(char::to_lowercase)
        .filter(|ch| !is_search_separator(*ch))
        .collect()
}

pub fn normalize_search_author(value: &str) -> String {
    let normalized = normalize_search_text(value);
    normalized
        .strip_prefix("作者")
        .unwrap_or(&normalized)
        .to_string()
}

fn relevance_score(query: &str, book: &SearchBook) -> u8 {
    let title = normalize_search_text(&book.name);
    let author = normalize_search_author(&book.author);
    if title == query {
        5
    } else if title.starts_with(query) {
        4
    } else if title.contains(query) {
        3
    } else if author == query {
        2
    } else if author.contains(query) {
        1
    } else {
        0
    }
}

fn is_short_query(query: &str) -> bool {
    let length = query.chars().count();
    length < 2
        || (query.is_ascii()
            && query.chars().all(|ch| ch.is_ascii_alphanumeric())
            && length < 3)
}

pub fn rank_search_results(query: &str, books: Vec<SearchBook>, limit: usize) -> Vec<SearchBook> {
    let query = normalize_search_text(query);
    if query.is_empty() || limit == 0 {
        return Vec::new();
    }
    let keep_unmatched = is_short_query(&query);
    let mut ranked: Vec<(u8, SearchBook)> = books
        .into_iter()
        .filter_map(|book| {
            let score = relevance_score(&query, &book);
            (score > 0 || keep_unmatched).then_some((score, book))
        })
        .collect();
    ranked.sort_by(|(left, _), (right, _)| right.cmp(left));
    ranked.truncate(limit);
    ranked.into_iter().map(|(_, book)| book).collect()
}
```

Use score values `5, 4, 3, 2, 1, 0`. Define short queries as fewer than two normalized characters, or fewer than three ASCII-alphanumeric characters. Do not add a Unicode dependency; use `char::is_whitespace`, `char::to_lowercase`, and an explicit punctuation matcher matching the approved design.

- [ ] **Step 4: Run the tests and verify GREEN**

Run: `cargo test model::search_relevance::tests --lib`

Expected: all relevance tests pass.

- [ ] **Step 5: Commit the pure module**

```bash
git add src/model/mod.rs src/model/search_relevance.rs
git commit -m "feat: add book search relevance ranking"
```

### Task 2: Single-source and ordinary multi-source integration

**Files:**
- Modify: `src/model/search.rs`
- Modify: `src/service/book_service.rs:231-267`
- Modify: `src/api/handlers/book.rs:271-376`
- Test: `src/api/handlers/book.rs` inline test module

- [ ] **Step 1: Write failing merge tests**

Import `merge_search_results` into the handler test module and add:

```rust
#[test]
fn search_merge_normalizes_duplicates_and_preserves_relevance_order() {
    let results = merge_search_results(
        vec![
            SearchBook { name: "三 体".into(), author: "作者：刘慈欣".into(), origin: "one".into(), ..Default::default() },
            SearchBook { name: "《三体》".into(), author: "刘慈欣".into(), origin: "two".into(), ..Default::default() },
            SearchBook { name: "三体全集".into(), author: "刘慈欣".into(), origin: "three".into(), ..Default::default() },
        ],
        "三体",
        50,
    );
    assert_eq!(results.len(), 2);
    assert_eq!(results[0].name, "三 体");
    assert_eq!(results[0].book_source_urls.as_ref().unwrap(), &vec!["one".to_string(), "two".to_string()]);
    assert_eq!(results[1].name, "三体全集");
}
```

- [ ] **Step 2: Run the merge test and verify RED**

Run: `cargo test search_merge_normalizes_duplicates_and_preserves_relevance_order --lib`

Expected: compilation fails because `merge_search_results` still accepts one argument and `merge_key` does not normalize punctuation/internal whitespace/author prefixes.

- [ ] **Step 3: Integrate shared ranking and normalized merging**

Make `SearchBook::merge_key` call the shared normalizers:

```rust
use super::search_relevance::{normalize_search_author, normalize_search_text};

impl SearchBook {
    pub fn merge_key(&self) -> String {
        let name = normalize_search_text(&self.name);
        let author = normalize_search_author(&self.author);
        format!("{}|{}", name, author)
    }
}
```

Import `rank_search_results` and `MAX_SEARCH_RESULTS` in `book_service.rs`. In `BookService::search_book`, replace the direct parsed return with:

```rust
let books = self.parser.search_books(source, &res.body, &res.url);
let books = rank_search_results(key, books, MAX_SEARCH_RESULTS);
tracing::info!("found {} relevant books", books.len());
Ok(books)
```

Import `rank_search_results` and `MAX_SEARCH_RESULTS` in `book.rs`. Change `merge_search_results` to accept `(results, query, limit)`, preserve first-seen order, merge source metadata, and rank globally:

```rust
fn merge_search_results(
    results: Vec<SearchBook>,
    query: &str,
    limit: usize,
) -> Vec<SearchBook> {
    use std::collections::HashMap;

    let mut indexes: HashMap<String, usize> = HashMap::new();
    let mut merged: Vec<SearchBook> = Vec::new();
    for book in results {
        let merge_key = book.merge_key();
        if let Some(&index) = indexes.get(&merge_key) {
            let existing = &mut merged[index];
            let urls = existing
                .book_source_urls
                .get_or_insert_with(|| vec![existing.origin.clone()]);
            if !urls.contains(&book.origin) {
                urls.push(book.origin.clone());
            }
            if existing.cover_url.is_none() { existing.cover_url = book.cover_url; }
            if existing.intro.is_none() { existing.intro = book.intro; }
            if existing.kind.is_none() { existing.kind = book.kind; }
            if existing.last_chapter.is_none() { existing.last_chapter = book.last_chapter; }
            if existing.update_time.is_none() { existing.update_time = book.update_time; }
        } else {
            indexes.insert(merge_key, merged.len());
            merged.push(book);
        }
    }
    rank_search_results(query, merged, limit)
}
```

Call it from `search_book_multi` as `merge_search_results(results, &key, MAX_SEARCH_RESULTS)`.

- [ ] **Step 4: Run focused and module tests**

Run: `cargo test search_merge_normalizes_duplicates_and_preserves_relevance_order --lib && cargo test model::search_relevance::tests --lib`

Expected: all selected tests pass.

- [ ] **Step 5: Commit the service and ordinary handler integration**

```bash
git add src/model/search.rs src/service/book_service.rs src/api/handlers/book.rs
git commit -m "fix: filter unrelated book search results"
```

### Task 3: SSE normalized deduplication and hard limit

**Files:**
- Modify: `src/api/handlers/book.rs:1837-1960`
- Test: `src/api/handlers/book.rs` inline test module

- [ ] **Step 1: Write a failing pure SSE-batch test**

Import `take_search_sse_batch` and add:

```rust
#[test]
fn search_sse_batch_deduplicates_normalized_books_and_respects_remaining_limit() {
    let mut seen = HashSet::new();
    let batch = take_search_sse_batch(
        vec![
            SearchBook { name: "三 体".into(), author: "刘慈欣".into(), ..Default::default() },
            SearchBook { name: "《三体》".into(), author: "作者：刘慈欣".into(), ..Default::default() },
            SearchBook { name: "三体全集".into(), author: "刘慈欣".into(), ..Default::default() },
        ],
        &mut seen,
        1,
    );
    assert_eq!(batch.len(), 1);
    assert_eq!(batch[0].name, "三 体");
}
```

- [ ] **Step 2: Run the SSE helper test and verify RED**

Run: `cargo test search_sse_batch_deduplicates_normalized_books_and_respects_remaining_limit --lib`

Expected: compilation fails because `take_search_sse_batch` does not exist.

- [ ] **Step 3: Implement and use the SSE helper**

Add:

```rust
fn take_search_sse_batch(
    books: Vec<SearchBook>,
    seen: &mut HashSet<String>,
    remaining: usize,
) -> Vec<SearchBook> {
    let mut batch = Vec::new();
    for book in books {
        if batch.len() >= remaining { break; }
        if seen.insert(book.merge_key()) { batch.push(book); }
    }
    batch
}
```

Clamp requested SSE `searchSize` to `1..=MAX_SEARCH_RESULTS`. In the stream loop, calculate `remaining = search_size.saturating_sub(total)` and use the helper before sending. Keep draining already-started tasks but never emit after `remaining` reaches zero.

- [ ] **Step 4: Run handler tests and verify GREEN**

Run: `cargo test api::handlers::book::tests --lib`

Expected: all handler tests pass.

- [ ] **Step 5: Commit the SSE fix**

```bash
git add src/api/handlers/book.rs
git commit -m "fix: cap streamed book search results"
```

### Task 4: Final verification

**Files:**
- Verify all modified Rust and frontend integration files.

- [ ] **Step 1: Format and check the diff**

Run: `cargo fmt --all -- --check && git diff --check`

Expected: exit code 0 and no whitespace errors. If formatting fails, run `cargo fmt --all`, inspect the diff, and rerun the check.

- [ ] **Step 2: Run all Rust tests**

Run: `cargo test`

Expected: exit code 0 with zero failed tests.

- [ ] **Step 3: Build the frontend**

Run: `npm run build`

Working directory: `frontend`

Expected: Vite build exits 0.

- [ ] **Step 4: Inspect final scope**

Run: `git status --short && git log --oneline -5`

Expected: only the implementation plan remains uncommitted if it was not committed earlier; code changes are represented by focused commits.
