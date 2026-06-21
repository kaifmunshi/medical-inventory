import axios, { AxiosError } from 'axios'
import { loadStoredUserSession } from '../lib/userSession'

function resolveApiBaseUrl() {
const configured = String(import.meta.env.VITE_API_BASE_URL || '').trim()
if (configured) return configured

if (typeof window !== 'undefined') {
const hostname = String(window.location.hostname || '').trim()
if (hostname) {
const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:'
const normalizedHost = hostname.replace(/^\[|\]$/g, '')
if (normalizedHost === 'localhost' || normalizedHost === '::1') return `${protocol}//127.0.0.1:8000`
const apiHost = normalizedHost.includes(':') ? `[${normalizedHost}]` : normalizedHost
return `${protocol}//${apiHost}:8000`
}
}

return 'http://127.0.0.1:8000'
}

const API_BASE_URL = resolveApiBaseUrl()

const api = axios.create({
baseURL: API_BASE_URL,
timeout: 15000
})

api.interceptors.request.use((config) => {
const session = loadStoredUserSession()
if (session?.token) {
config.headers = config.headers || {}
config.headers.Authorization = `Bearer ${session.token}`
}
return config
})

api.interceptors.response.use(
(res) => res,
(err: unknown) => {
const error = err as AxiosError & { message?: string }
const detail = (error?.response?.data as Record<string, unknown>)?.detail
const path = String(error?.config?.url || '')

if (detail) {
const message = Array.isArray(detail)
? detail.map((row: unknown) => {
    const rowObj = row as Record<string, unknown>
    return rowObj?.msg || String(row)
  }).join(', ')
: String(detail)
error.message = message
return Promise.reject(error)
}

if (!error?.response) {
if (error?.code === 'ECONNABORTED') {
error.message = `Request timed out while contacting ${API_BASE_URL}${path}`
} else {
error.message = `Cannot reach backend at ${API_BASE_URL}${path}`
}
return Promise.reject(error)
}

error.message = error?.message || `Request failed with status ${error?.response?.status || 'unknown'}`
return Promise.reject(error)
}
)


export default api
