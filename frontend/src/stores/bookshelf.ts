import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import {
  getBookshelfWithCacheInfo,
  getBookGroups,
  deleteBook as apiDeleteBook,
  deleteBooks as apiDeleteBooks,
  saveBookGroupId as apiSaveBookGroupId,
  saveBookGroup as apiSaveBookGroup,
  deleteBookGroup as apiDeleteBookGroup,
  saveBooks as apiSaveBooks,
} from '../api/bookshelf'
import type { Book, BookGroup, SearchBook } from '../types'
import { deleteBrowserBookCache, listBrowserCacheSummary } from '../utils/browserCache'
import { isLocalBook } from '../utils/localBook'
import { clearRecentReadBooks, getRecentReadBookKey, loadRecentReadBooks, removeRecentReadBook } from '../utils/recentBooks'

const SEARCH_SEPARATORS = new Set('《》〈〉「」『』()（）[]【】·-—_:：,，.。!！?？;；\'"“”‘’/\\|')

function normalizeSearchText(value: string) {
  return Array.from(value.toLowerCase())
    .filter((char) => !/\s/u.test(char) && !SEARCH_SEPARATORS.has(char))
    .join('')
}

function searchResultKey(book: SearchBook) {
  const title = normalizeSearchText(book.name)
  const author = normalizeSearchText(book.author).replace(/^作者/, '')
  return `${title}\u0000${author}`
}

function isSearchBook(value: unknown): value is SearchBook {
  if (!value || typeof value !== 'object') return false
  const book = value as Record<string, unknown>
  return typeof book.name === 'string'
    && typeof book.author === 'string'
    && typeof book.bookUrl === 'string'
    && typeof book.origin === 'string'
}

export const useBookshelfStore = defineStore('bookshelf', () => {
  // ─── Bookshelf ───
  const books = ref<Book[]>([])
  const recentBooks = ref<Book[]>([])
  const loading = ref(false)
  const refreshing = ref(false)
  const sorting = ref(false)

  async function refreshRecentBooks() {
    const browserSummaries = await listBrowserCacheSummary().catch(() => [])
    const browserMap = new Map(browserSummaries.map((item) => [item.bookUrl, item.cachedChapterCount]))
    const shelfMap = new Map(books.value.map((book) => [getRecentReadBookKey(book), book]))
    recentBooks.value = loadRecentReadBooks().map((entry) => {
      const shelfBook = shelfMap.get(getRecentReadBookKey(entry))
      const merged = shelfBook
        ? {
            ...entry,
            ...shelfBook,
            recentReadAt: entry.recentReadAt,
            durChapterTime: entry.recentReadAt,
          }
        : entry
      return {
        ...merged,
        browserCachedChapterCount: isLocalBook(merged) ? 0 : browserMap.get(merged.bookUrl) || merged.browserCachedChapterCount || 0,
      }
    })
  }

  async function removeRecentBook(book: Pick<Book, 'bookUrl' | 'origin'>) {
    removeRecentReadBook(book)
    await refreshRecentBooks()
  }

  async function clearAllRecentBooks() {
    clearRecentReadBooks()
    await refreshRecentBooks()
  }

  async function fetchBooks() {
    loading.value = true
    try {
      const [serverBooks, browserSummaries] = await Promise.all([
        getBookshelfWithCacheInfo(),
        listBrowserCacheSummary().catch(() => []),
      ])
      const browserMap = new Map(browserSummaries.map((item) => [item.bookUrl, item.cachedChapterCount]))
      books.value = serverBooks.map((book) => ({
        ...book,
        browserCachedChapterCount: isLocalBook(book) ? 0 : browserMap.get(book.bookUrl) || 0,
      }))
      await refreshRecentBooks()
    } finally {
      loading.value = false
    }
  }

  async function refreshBooks() {
    refreshing.value = true
    try {
      const [serverBooks, browserSummaries] = await Promise.all([
        getBookshelfWithCacheInfo(),
        listBrowserCacheSummary().catch(() => []),
      ])
      const browserMap = new Map(browserSummaries.map((item) => [item.bookUrl, item.cachedChapterCount]))
      books.value = serverBooks.map((book) => ({
        ...book,
        browserCachedChapterCount: isLocalBook(book) ? 0 : browserMap.get(book.bookUrl) || 0,
      }))
      await refreshRecentBooks()
    } finally {
      refreshing.value = false
    }
  }

  async function removeBook(book: Book) {
    await apiDeleteBook(book)
    await deleteBrowserBookCache(book.bookUrl).catch(() => undefined)
    books.value = books.value.filter((b) => b.bookUrl !== book.bookUrl)
    await refreshRecentBooks()
  }

  // ─── Groups ───
  const groups = ref<BookGroup[]>([])
  const activeGroupId = ref<number>(-1) // -1 = all

  const displayGroups = computed(() => {
    const all: BookGroup = { groupId: -1, groupName: '全部' }
    const ungrouped: BookGroup = { groupId: 0, groupName: '未分组' }
    return [all, ...groups.value, ungrouped]
  })

  const filteredBooks = computed(() => {
    if (activeGroupId.value === -1) return books.value
    if (activeGroupId.value === 0) {
      return books.value.filter((b) => !b.group || b.group === 0)
    }
    return books.value.filter(
      (b) => b.group && (b.group & activeGroupId.value) !== 0
    )
  })

  async function fetchGroups() {
    try {
      groups.value = await getBookGroups()
    } catch {
      groups.value = []
    }
  }

  async function saveGroup(groupName: string, groupId = 0) {
    await apiSaveBookGroup({
      groupId,
      groupName,
      orderNo: groups.value.length,
    })
    await fetchGroups()
    return groups.value.find((group) => group.groupName === groupName)?.groupId || groupId
  }

  async function removeGroup(groupId: number) {
    await apiDeleteBookGroup(groupId)
    groups.value = groups.value.filter((group) => group.groupId !== groupId)
    books.value = books.value.map((book) => {
      if (book.group && (book.group & groupId) !== 0) {
        return { ...book, group: book.group & ~groupId }
      }
      return book
    })
  }

  // ─── Search ───
  const searchResults = ref<SearchBook[]>([])
  const isSearching = ref(false)
  const searchKey = ref('')
  const searchScope = ref<'all' | 'group' | 'source'>('source')
  const searchGroup = ref('')
  const searchSourceUrl = ref('')
  const searchSessionSignature = ref('')
  const searchLastIndex = ref(-1)
  const searchHasMore = ref(true)
  const searchInitialized = ref(false)
  const searchScrollTop = ref(0)
  const searchSessionId = ref(0)

  function currentSearchSignature() {
    return JSON.stringify([
      searchKey.value.trim(),
      searchScope.value,
      searchScope.value === 'group' ? searchGroup.value : '',
      searchScope.value === 'source' ? searchSourceUrl.value : '',
    ])
  }

  function startSearch(key: string, options: {
    scope?: 'all' | 'group' | 'source'
    group?: string
    sourceUrl?: string
  } = {}) {
    const nextKey = key.trim()
    if (!nextKey) {
      clearSearch()
      return
    }

    searchScope.value = options.scope || 'source'
    searchGroup.value = options.group || ''
    searchSourceUrl.value = options.sourceUrl || ''
    searchKey.value = nextKey
  }

  function prepareSearchSession() {
    const signature = currentSearchSignature()
    if (searchInitialized.value && searchSessionSignature.value === signature) {
      return false
    }

    searchResults.value = []
    isSearching.value = false
    searchSessionSignature.value = signature
    searchLastIndex.value = -1
    searchHasMore.value = true
    searchInitialized.value = true
    searchScrollTop.value = 0
    searchSessionId.value += 1
    return true
  }

  function appendSearchResults(books: unknown, sessionId: number) {
    if (sessionId !== searchSessionId.value || !Array.isArray(books)) return 0
    const seen = new Set(searchResults.value.map(searchResultKey))
    const next = searchResults.value.slice()
    let appended = 0
    for (const book of books) {
      if (!isSearchBook(book)) continue
      const key = searchResultKey(book)
      if (!seen.has(key)) {
        seen.add(key)
        next.push(book)
        appended += 1
      }
    }
    searchResults.value = next
    return appended
  }

  function completeSearchPage(
    lastIndex: unknown,
    hasMore: unknown,
    sessionId: number,
  ) {
    if (sessionId !== searchSessionId.value) return false
    if (typeof lastIndex !== 'number' || !Number.isFinite(lastIndex)) return false
    if (typeof hasMore !== 'boolean') return false
    const normalizedLastIndex = Math.max(-1, Math.trunc(lastIndex))
    searchLastIndex.value = Math.max(searchLastIndex.value, normalizedLastIndex)
    searchHasMore.value = hasMore
    isSearching.value = false
    return true
  }

  function canLoadMoreSearch() {
    return searchInitialized.value
      && searchHasMore.value
      && !isSearching.value
      && searchSessionSignature.value === currentSearchSignature()
  }

  function saveSearchScroll(scrollTop: number) {
    searchScrollTop.value = Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0
  }

  function clearSearch() {
    searchResults.value = []
    searchKey.value = ''
    isSearching.value = false
    searchScope.value = 'source'
    searchGroup.value = ''
    searchSourceUrl.value = ''
    searchSessionSignature.value = ''
    searchLastIndex.value = -1
    searchHasMore.value = true
    searchInitialized.value = false
    searchScrollTop.value = 0
    searchSessionId.value += 1
  }

  const isSearchMode = computed(() => searchKey.value.length > 0)

  // ─── Edit mode and Selection ───
  const editMode = ref(false)
  const selectedBookUrls = ref<Set<string>>(new Set())

  function toggleSelection(url: string) {
    if (selectedBookUrls.value.has(url)) {
      selectedBookUrls.value.delete(url)
    } else {
      selectedBookUrls.value.add(url)
    }
  }

  function selectAll() {
    filteredBooks.value.forEach(b => selectedBookUrls.value.add(b.bookUrl))
  }

  function clearSelection() {
    selectedBookUrls.value.clear()
  }

  async function bulkDelete() {
    const toDelete = books.value
      .filter(b => selectedBookUrls.value.has(b.bookUrl))
      .map(b => ({ bookUrl: b.bookUrl, origin: b.origin }))
    
    if (toDelete.length === 0) return
    await apiDeleteBooks(toDelete as Book[])
    await Promise.all(toDelete.map((book) => deleteBrowserBookCache(book.bookUrl).catch(() => undefined)))
    books.value = books.value.filter(b => !selectedBookUrls.value.has(b.bookUrl))
    clearSelection()
  }

  async function bulkSetGroup(groupId: number) {
    const urls = Array.from(selectedBookUrls.value)
    for (const url of urls) {
      await apiSaveBookGroupId(url, groupId)
    }
    // Refresh to get updated groups
    await fetchBooks()
    clearSelection()
  }

  async function reorderBooks(draggedUrl: string, targetUrl: string) {
    if (!draggedUrl || !targetUrl || draggedUrl === targetUrl) return

    const snapshot = books.value.slice()
    const fromIndex = snapshot.findIndex((book) => book.bookUrl === draggedUrl)
    const toIndex = snapshot.findIndex((book) => book.bookUrl === targetUrl)
    if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return

    const next = snapshot.slice()
    const [moved] = next.splice(fromIndex, 1)
    next.splice(toIndex, 0, moved)

    books.value = next
    sorting.value = true
    try {
      await apiSaveBooks(next)
    } catch (error) {
      books.value = snapshot
      throw error
    } finally {
      sorting.value = false
    }
  }

  async function moveBookToFront(bookUrl: string) {
    if (!bookUrl || books.value.length <= 1) return

    const snapshot = books.value.slice()
    const fromIndex = snapshot.findIndex((book) => book.bookUrl === bookUrl)
    if (fromIndex <= 0) return

    const next = snapshot.slice()
    const [moved] = next.splice(fromIndex, 1)
    next.unshift(moved)

    books.value = next
    sorting.value = true
    try {
      await apiSaveBooks(next)
    } catch (error) {
      books.value = snapshot
      throw error
    } finally {
      sorting.value = false
    }
  }

  return {
    books, recentBooks, loading, refreshing, sorting,
    fetchBooks, refreshBooks, removeBook,
    refreshRecentBooks, removeRecentBook, clearAllRecentBooks,
    groups, activeGroupId, displayGroups, filteredBooks,
    fetchGroups, saveGroup, removeGroup,
    searchResults, isSearching, searchKey,
    searchScope, searchGroup, searchSourceUrl, searchSessionSignature,
    searchLastIndex, searchHasMore, searchInitialized, searchScrollTop, searchSessionId,
    startSearch, prepareSearchSession, appendSearchResults, completeSearchPage,
    canLoadMoreSearch, saveSearchScroll, clearSearch, isSearchMode,
    editMode,
    selectedBookUrls, toggleSelection, selectAll, clearSelection,
    bulkDelete, bulkSetGroup, reorderBooks, moveBookToFront,
  }
})
