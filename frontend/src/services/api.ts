import axios from 'axios'


const api = axios.create({
baseURL: import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8000',
timeout: 15000
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