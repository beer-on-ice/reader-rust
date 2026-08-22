import { describe, expect, it } from 'vitest'
import { isNearSearchBottom } from './searchScroll'

describe('search scroll pagination', () => {
  it('loads only inside the bottom threshold', () => {
    expect(isNearSearchBottom(1200, 800, 2200, 240)).toBe(true)
    expect(isNearSearchBottom(1000, 800, 2200, 240)).toBe(false)
  })

  it('handles short pages and rejects non-finite measurements', () => {
    expect(isNearSearchBottom(0, 800, 600)).toBe(true)
    expect(isNearSearchBottom(Number.NaN, 800, 2200)).toBe(false)
    expect(isNearSearchBottom(1200, Number.POSITIVE_INFINITY, 2200)).toBe(false)
  })
})
