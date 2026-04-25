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
  active_only?: boolean
  limit?: number
  offset?: number
}): Promise<Product[]> {
  const res = await api.get<Product[]>('/products', { params })
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
