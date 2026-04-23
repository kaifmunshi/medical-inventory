import axios from 'axios'
import { loadStoredUserSession } from '../lib/userSession'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8000'

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
