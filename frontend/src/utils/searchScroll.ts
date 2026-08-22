export function isNearSearchBottom(
  scrollTop: number,
  viewportHeight: number,
  documentHeight: number,
  threshold = 240,
) {
  if (![scrollTop, viewportHeight, documentHeight, threshold].every(Number.isFinite)) {
    return false
  }
  return scrollTop + viewportHeight >= documentHeight - Math.max(0, threshold)
}

export function clampSearchScrollTop(
  savedScrollTop: number,
  viewportHeight: number,
  documentHeight: number,
) {
  if (![savedScrollTop, viewportHeight, documentHeight].every(Number.isFinite)) return 0
  const maxScrollTop = Math.max(0, documentHeight - viewportHeight)
  return Math.min(Math.max(0, savedScrollTop), maxScrollTop)
}
