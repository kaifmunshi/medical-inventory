import type { Product } from './types'

export const PRODUCT_NAME_SIMILARITY_WARNING_THRESHOLD = 0.99

export type SimilarProductMatch = {
  product: Product
  score: number
}

export type NewProductNameCandidate = {
  product_id?: number | string | null
  product_name?: string | null
  name?: string | null
  brand?: string | null
}

export function normalizeProductNameForSimilarity(value?: string | null) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\b(\d+)\s+(g|gm|ml|tab|tabs|tablet|tablets|cap|caps|n)\b/g, '$1$2')
    .replace(/[^a-z0-9]+/g, '')
}

export function normalizeProductBrandForSimilarity(value?: string | null) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
}

function levenshteinDistance(a: string, b: string) {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length

  const previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  const current = Array.from({ length: b.length + 1 }, () => 0)

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i
    for (let j = 1; j <= b.length; j += 1) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + substitutionCost,
      )
    }
    for (let j = 0; j <= b.length; j += 1) previous[j] = current[j]
  }

  return previous[b.length]
}

export function productNameSimilarity(a?: string | null, b?: string | null) {
  const left = normalizeProductNameForSimilarity(a)
  const right = normalizeProductNameForSimilarity(b)
  if (!left || !right) return 0
  if (left === right) return 1
  return 1 - levenshteinDistance(left, right) / Math.max(left.length, right.length)
}

export function findSimilarProductName(
  products: Product[],
  name: string,
  threshold = PRODUCT_NAME_SIMILARITY_WARNING_THRESHOLD,
  excludeProductId?: number | null,
): SimilarProductMatch | null {
  let best: SimilarProductMatch | null = null

  for (const product of products) {
    if (excludeProductId && Number(product.id) === Number(excludeProductId)) continue
    const score = productNameSimilarity(name, product.name)
    if (score < threshold) continue
    if (!best || score > best.score) best = { product, score }
  }

  return best
}

export function similarProductWarningMessage(name: string, match: SimilarProductMatch) {
  const product = match.product
  const parts = [`"${product.name}"`]
  if (product.brand) parts.push(`brand: ${product.brand}`)
  parts.push(`match: ${Math.round(match.score * 100)}%`)

  return [
    `A very similar product already exists: ${parts.join(', ')}.`,
    `Do you still want to add "${name}" as a new product?`,
  ].join('\n\n')
}

export function findSimilarNewProductCandidate(
  products: Product[],
  candidates: NewProductNameCandidate[],
  threshold = PRODUCT_NAME_SIMILARITY_WARNING_THRESHOLD,
): { name: string; match: SimilarProductMatch } | null {
  for (const candidate of candidates) {
    if (candidate.product_id) continue

    const name = String(candidate.product_name ?? candidate.name ?? '').trim()
    if (!name) continue

    const nameKey = normalizeProductNameForSimilarity(name)
    const brandKey = normalizeProductBrandForSimilarity(candidate.brand)
    const exactNameAndBrand = products.some((product) => (
      normalizeProductNameForSimilarity(product.name) === nameKey &&
      normalizeProductBrandForSimilarity(product.brand) === brandKey
    ))
    if (exactNameAndBrand) continue

    const match = findSimilarProductName(products, name, threshold)
    if (match) return { name, match }
  }

  return null
}
