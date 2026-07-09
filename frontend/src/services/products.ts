import api from './api'
import type { Brand, Category, Product } from '../lib/types'

export interface ProductPayload {
  name: string
  alias?: string
  brand?: string
  category_id?: number
  default_rack_number?: number
  printed_price?: number
  parent_unit_name?: string
  child_unit_name?: string
  loose_sale_enabled?: boolean
  default_conversion_qty?: number
}

export type ProductUpdatePayload = Partial<ProductPayload> & {
  is_active?: boolean
}

export async function fetchBrands(params?: { active_only?: boolean }): Promise<Brand[]> {
  const res = await api.get<Brand[]>('/products/brands', { params })
  return res.data
}

export async function createBrand(name: string): Promise<Brand> {
  const res = await api.post<Brand>('/products/brands', { name })
  return res.data
}

export async function updateBrand(id: number, payload: { name?: string; is_active?: boolean }): Promise<Brand> {
  const res = await api.patch<Brand>(`/products/brands/${id}`, payload)
  return res.data
}

export async function fetchCategories(params?: { active_only?: boolean }): Promise<Category[]> {
  const res = await api.get<Category[]>('/products/categories', { params })
  return res.data
}

export async function createCategory(name: string): Promise<Category> {
  const res = await api.post<Category>('/products/categories', { name })
  return res.data
}

export async function updateCategory(id: number, payload: { name?: string; is_active?: boolean }): Promise<Category> {
  const res = await api.patch<Category>(`/products/categories/${id}`, payload)
  return res.data
}

export async function fetchProducts(params?: {
  q?: string
  brand?: string
  category_id?: number
  uncategorized_only?: boolean
  active_only?: boolean
  inactive_only?: boolean
  limit?: number
  offset?: number
}): Promise<Product[]> {
  const res = await api.get<Product[]>('/products', { params })
  return res.data
}

export async function fetchAllProducts(params?: {
  q?: string
  brand?: string
  category_id?: number
  uncategorized_only?: boolean
  active_only?: boolean
  inactive_only?: boolean
}): Promise<Product[]> {
  const limit = 1000
  let offset = 0
  const rows: Product[] = []

  while (true) {
    const page = await fetchProducts({ ...params, limit, offset })
    rows.push(...page)
    if (page.length < limit) break
    offset += limit
  }

  return rows
}

export interface ProductPage {
  items: Product[]
  total: number
  limit: number
  offset: number
}

export async function fetchProductsPage(params?: {
  q?: string
  brand?: string
  category_id?: number
  uncategorized_only?: boolean
  active_only?: boolean
  inactive_only?: boolean
  limit?: number
  offset?: number
}): Promise<ProductPage> {
  const res = await api.get<ProductPage>('/products/page', { params })
  return res.data
}

export async function createProduct(payload: ProductPayload): Promise<Product> {
  const res = await api.post<Product>('/products', payload)
  return res.data
}

export async function updateProduct(id: number, payload: ProductUpdatePayload): Promise<Product> {
  const res = await api.patch<Product>(`/products/${id}`, payload)
  return res.data
}

export async function deleteProduct(id: number): Promise<Product> {
  const res = await api.delete<Product>(`/products/${id}`)
  return res.data
}

export interface ProductMergeResult {
  product: Product
  deactivated_product_id: number
  moved_items: number
  moved_lots: number
  moved_purchase_items: number
  backup_path?: string | null
}

export async function mergeProduct(sourceId: number, targetId: number): Promise<ProductMergeResult> {
  const res = await api.post<ProductMergeResult>(`/products/${sourceId}/merge-into/${targetId}`)
  return res.data
}
