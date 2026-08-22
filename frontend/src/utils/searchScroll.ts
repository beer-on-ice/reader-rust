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
