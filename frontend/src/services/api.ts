import axios from 'axios'

function readActor() {
  try {
    const raw = localStorage.getItem('current_operator')
    if (!raw) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

const api = axios.create({
baseURL: import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8000',
timeout: 15000
})

api.interceptors.request.use((config) => {
const actor = readActor()
if (actor?.name) {
config.headers = config.headers || {}
config.headers['X-Actor-Name'] = actor.name
config.headers['X-Actor-Role'] = actor.role
}
return config
})


api.interceptors.response.use(
res => res,
err => {
// simple normalization
const message = err?.response?.data?.detail || err.message || 'Request failed'
return Promise.reject(new Error(message))
}
)


export default api
