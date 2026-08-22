# Search Infinite Scroll and Session Restoration Design

## Goal

Extend multi-source book search so scrolling near the bottom searches the next unvisited book sources. When a user opens a search result and returns from the reader, restore the previous results, source progress, and scroll position without automatically starting another request.

## Scope

This change applies to the home-page `SearchResults` flow backed by `/reader3/searchBookMultiSSE`.

It does not add persistent search history, preserve search state across a full browser reload, or change the reader's available-source search flow.

## Search Session State

The bookshelf Pinia store owns the search session because it already survives the route change from the home page to the reader. The session adds:

- a signature derived from the keyword and selected scope, group, or source;
- `lastIndex`, the last safely completed source index;
- `hasMore`, indicating whether unvisited sources remain;
- `initialized`, distinguishing an empty completed search from a search that has never run;
- `scrollTop`, the document scroll position to restore after returning.

Changing the keyword or any search scope input resets results, pagination state, and scroll position. Returning from the reader with the same signature reuses the existing session.

## Backend Cursor Contract

`searchBookMultiSSE` continues to start at `lastIndex + 1` and run at most `concurrentCount` source searches at once.

When the result limit is reached, it stops starting new source tasks but drains every task already started. Because all source indices from the requested start through `nextIndex - 1` have then completed, the safe final cursor is `nextIndex - 1`, independent of task completion order.

The `end` event for this endpoint returns:

```json
{
  "lastIndex": 47,
  "hasMore": true
}
```

`hasMore` is true only when the safe cursor is before the final selected source. Empty keywords, missing source selections, and other early exits return the request cursor with `hasMore: false`.

The shared legacy `json_end` payload used by other SSE endpoints is not changed; the multi-source search endpoint gets a dedicated end-payload helper so its pagination contract cannot accidentally alter other features.

## Frontend Request and Result Flow

The frontend API accepts and transmits `lastIndex`.

`SearchResults` has two request modes:

1. Initial search resets the session and requests from `-1`.
2. Load-more search preserves results and requests from the stored cursor.

Data events append only new results. Deduplication uses the same normalized title-and-author identity across both the current SSE connection and earlier pages, so pagination cannot display the same book twice merely because a later source also returned it.

The end event updates `lastIndex`, `hasMore`, `initialized`, and the loading state. An error closes the connection and clears the loading state while retaining the current cursor and results, allowing a later bottom reach to retry.

## Infinite Scroll

`SearchResults` listens to document scrolling while mounted. When the viewport is within a small threshold of the document bottom, it requests the next page only if:

- the session is initialized;
- `hasMore` is true;
- no request is active; and
- the active keyword and scope still match the session signature.

The loading guard prevents repeated scroll events from opening concurrent SSE connections. A small status row communicates loading and when all selected sources have been searched.

## Reader Navigation and Restoration

Before navigating to the reader, the component records the document scroll position. Unmounting closes any active SSE connection and marks the session as not loading without clearing results or cursor state.

When `SearchResults` mounts again with a matching initialized session, it does not call the initial-search path. After the saved result grid renders, it restores the saved scroll position. It does not resume a request automatically; the next bottom reach triggers continuation.

If the prior request was interrupted before receiving an end event, the last committed safe cursor remains unchanged. A later continuation may repeat part of that page, but frontend deduplication prevents duplicate display and no source is skipped.

## Testing

Backend tests cover:

- a safe final cursor when concurrent source tasks finish out of order;
- `hasMore: true` when unvisited sources remain;
- `hasMore: false` after the final source;
- the 50-result limit remaining intact.

Frontend tests cover:

- `lastIndex` serialization in the SSE URL;
- session reset only when the search signature changes;
- result deduplication across pages;
- load-more guards preventing duplicate requests;
- a remounted search view reusing initialized state instead of starting a new search;
- scroll position save and restoration helpers.

The implementation will be verified with focused red-green tests, the complete Rust and frontend test suites, formatting/type checks, a production frontend build, and a local Docker smoke test.
