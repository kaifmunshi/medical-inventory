import axios from 'axios'
import { loadStoredUserSession } from '../lib/userSession'

function resolveApiBaseUrl() {
const configured = String(import.meta.env.VITE_API_BASE_URL || '').trim()
if (configured) return configured

if (typeof window !== 'undefined') {
const hostname = String(window.location.hostname || '').trim()
if (hostname) {
const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:'
return `${protocol}//${hostname}:8000`
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
res => res,
err => {
const detail = err?.response?.data?.detail
const path = String(err?.config?.url || '')

if (detail) {
err.message = Array.isArray(detail) ? detail.map((row: any) => row?.msg || String(row)).join(', ') : String(detail)
return Promise.reject(err)
}

if (!err?.response) {
if (err?.code === 'ECONNABORTED') {
err.message = `Request timed out while contacting ${API_BASE_URL}${path}`
} else {
err.message = `Cannot reach backend at ${API_BASE_URL}${path}`
}
return Promise.reject(err)
}

err.message = err?.message || `Request failed with status ${err?.response?.status || 'unknown'}`
return Promise.reject(err)
}
)


export default api
