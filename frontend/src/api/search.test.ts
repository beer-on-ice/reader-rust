import { describe, expect, it } from 'vitest'
import { buildSearchBookMultiSSEUrl } from './search'

const emptyStorage = { getItem: () => null }

describe('multi-source search SSE URL', () => {
  it('uses minus one as the default resume cursor', () => {
    const url = new URL(
      buildSearchBookMultiSSEUrl({ key: 'hello world' }, emptyStorage),
      'http://reader.test',
    )

    expect(url.pathname).toBe('/reader3/searchBookMultiSSE')
    expect(url.searchParams.get('key')).toBe('hello world')
    expect(url.searchParams.get('lastIndex')).toBe('-1')
  })

  it('includes the resume cursor, search controls, and auth values', () => {
    const url = new URL(
      buildSearchBookMultiSSEUrl({
        key: '三体',
        bookSourceGroup: '精品',
        bookSourceUrl: 'https://source.test',
        concurrentCount: 24,
        searchSize: 50,
        lastIndex: 47,
      }, {
        getItem(key: string) {
          if (key === 'accessToken') return 'token-123'
          if (key === 'secureKey') return 'secure-456'
          return null
        },
      }),
      'http://reader.test',
    )

    expect(url.searchParams.get('lastIndex')).toBe('47')
    expect(url.searchParams.get('bookSourceGroup')).toBe('精品')
    expect(url.searchParams.get('bookSourceUrl')).toBe('https://source.test')
    expect(url.searchParams.get('concurrentCount')).toBe('24')
    expect(url.searchParams.get('searchSize')).toBe('50')
    expect(url.searchParams.get('accessToken')).toBe('token-123')
    expect(url.searchParams.get('secureKey')).toBe('secure-456')
  })

  it('preserves an explicit zero resume cursor', () => {
    const url = new URL(
      buildSearchBookMultiSSEUrl({
        key: '三体',
        lastIndex: 0,
        concurrentCount: 0,
        searchSize: 0,
      }, emptyStorage),
      'http://reader.test',
    )

    expect(url.searchParams.get('lastIndex')).toBe('0')
    expect(url.searchParams.get('concurrentCount')).toBe('0')
    expect(url.searchParams.get('searchSize')).toBe('0')
  })
})
