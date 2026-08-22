import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useBookshelfStore } from './bookshelf'
import { getBookshelfWithCacheInfo } from '../api/bookshelf'
import { listBrowserCacheSummary } from '../utils/browserCache'

vi.mock('../api/bookshelf', () => ({
  getBookshelfWithCacheInfo: vi.fn(),
  getBookGroups: vi.fn(),
  deleteBook: vi.fn(),
  deleteBooks: vi.fn(),
  saveBookGroupId: vi.fn(),
  saveBookGroup: vi.fn(),
  deleteBookGroup: vi.fn(),
  saveBooks: vi.fn(),
}))

vi.mock('../utils/browserCache', () => ({
  deleteBrowserBookCache: vi.fn(),
  listBrowserCacheSummary: vi.fn(),
}))

vi.mock('../utils/recentBooks', () => ({
  clearRecentReadBooks: vi.fn(),
  getRecentReadBookKey: vi.fn((book) => `${book.origin || ''}::${book.bookUrl}`),
  loadRecentReadBooks: vi.fn(() => []),
  removeRecentReadBook: vi.fn(),
}))

describe('bookshelf search state', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(getBookshelfWithCacheInfo).mockResolvedValue([])
    vi.mocked(listBrowserCacheSummary).mockResolvedValue([])
  })

  it('starts searches in single-source scope by default', () => {
    const store = useBookshelfStore()

    store.startSearch('星门')

    expect(store.searchKey).toBe('星门')
    expect(store.searchScope).toBe('source')
    expect(store.searchSourceUrl).toBe('')
    expect(store.searchGroup).toBe('')
  })

  it('reuses an initialized session with the same search signature', () => {
    const store = useBookshelfStore()
    store.startSearch('三体', { scope: 'all' })

    expect(store.prepareSearchSession()).toBe(true)
    store.completeSearchPage(47, true, store.searchSessionId)

    expect(store.prepareSearchSession()).toBe(false)
    expect(store.searchLastIndex).toBe(47)
    expect(store.searchHasMore).toBe(true)
  })

  it('resets pagination when the search signature changes', () => {
    const store = useBookshelfStore()
    store.startSearch('三体', { scope: 'all' })
    store.prepareSearchSession()
    store.completeSearchPage(47, true, store.searchSessionId)

    store.startSearch('球状闪电', { scope: 'all' })

    expect(store.prepareSearchSession()).toBe(true)
    expect(store.searchResults).toEqual([])
    expect(store.searchLastIndex).toBe(-1)
    expect(store.searchScrollTop).toBe(0)
  })

  it('deduplicates normalized title and author across pages', () => {
    const store = useBookshelfStore()
    store.startSearch('三体', { scope: 'all' })
    store.prepareSearchSession()
    const sessionId = store.searchSessionId

    store.appendSearchResults([
      { name: '三 体', author: '作者：刘慈欣', origin: 'one', bookUrl: 'one/1' },
    ], sessionId)
    store.appendSearchResults([
      { name: '《三体》', author: '刘慈欣', origin: 'two', bookUrl: 'two/1' },
      { name: '三体全集', author: '刘慈欣', origin: 'two', bookUrl: 'two/2' },
    ], sessionId)

    expect(store.searchResults.map((book) => book.name)).toEqual(['三 体', '三体全集'])
  })

  it('guards load more and preserves the saved scroll position', () => {
    const store = useBookshelfStore()
    store.startSearch('三体', { scope: 'all' })

    expect(store.canLoadMoreSearch()).toBe(false)
    store.prepareSearchSession()
    store.completeSearchPage(23, true, store.searchSessionId)
    store.saveSearchScroll(960)

    expect(store.canLoadMoreSearch()).toBe(true)
    expect(store.searchScrollTop).toBe(960)
    store.isSearching = true
    expect(store.canLoadMoreSearch()).toBe(false)
    store.saveSearchScroll(-50)
    expect(store.searchScrollTop).toBe(0)
  })

  it('ignores results and completion from an older search session', () => {
    const store = useBookshelfStore()
    store.startSearch('三体', { scope: 'all' })
    store.prepareSearchSession()
    const oldSessionId = store.searchSessionId

    store.startSearch('球状闪电', { scope: 'all' })
    store.prepareSearchSession()

    expect(store.appendSearchResults([
      { name: '三体', author: '刘慈欣', origin: 'one', bookUrl: 'one/1' },
    ], oldSessionId)).toBe(0)
    expect(store.completeSearchPage(47, false, oldSessionId)).toBe(false)
    expect(store.searchResults).toEqual([])
    expect(store.searchLastIndex).toBe(-1)
    expect(store.searchHasMore).toBe(true)
  })

  it('rejects malformed runtime pagination values', () => {
    const store = useBookshelfStore()
    store.startSearch('三体', { scope: 'all' })
    store.prepareSearchSession()

    store.isSearching = true
    expect(store.completeSearchPage(Number.NaN, 'no' as never, store.searchSessionId)).toBe(false)
    expect(store.isSearching).toBe(true)
    expect(store.searchLastIndex).toBe(-1)
    expect(store.searchHasMore).toBe(true)
    store.saveSearchScroll(Number.NaN)
    expect(store.searchScrollTop).toBe(0)
    expect(store.appendSearchResults([
      { name: null, author: '刘慈欣' } as never,
    ], store.searchSessionId)).toBe(0)
    expect(store.searchResults).toEqual([])
  })

  it('does not display browser cache counts for uploaded local txt books', async () => {
    vi.mocked(getBookshelfWithCacheInfo).mockResolvedValue([
      {
        name: '本地书',
        author: '本地导入',
        origin: 'local-txt',
        bookUrl: 'local-txt:abc',
        cachedChapterCount: 12,
      },
      {
        name: '远程书',
        author: '作者',
        origin: 'https://source.example',
        bookUrl: 'https://book.example/1',
      },
    ] as never)
    vi.mocked(listBrowserCacheSummary).mockResolvedValue([
      { bookUrl: 'local-txt:abc', cachedChapterCount: 12, bytes: 100, updatedAt: 1 },
      { bookUrl: 'https://book.example/1', cachedChapterCount: 3, bytes: 200, updatedAt: 2 },
    ])
    const store = useBookshelfStore()

    await store.fetchBooks()

    expect(store.books.find((book) => book.bookUrl === 'local-txt:abc')?.browserCachedChapterCount).toBe(0)
    expect(store.books.find((book) => book.bookUrl === 'https://book.example/1')?.browserCachedChapterCount).toBe(3)
  })

  it('can start a search with the active explore source selected', () => {
    const store = useBookshelfStore()

    store.startSearch('星门', { sourceUrl: 'https://m.cuoceng.com' })

    expect(store.searchKey).toBe('星门')
    expect(store.searchScope).toBe('source')
    expect(store.searchSourceUrl).toBe('https://m.cuoceng.com')
  })
})
