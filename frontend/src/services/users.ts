import api from './api'
import type { AppUser, UserSession } from '../lib/types'

export async function fetchUsers(params?: { active_only?: boolean }): Promise<AppUser[]> {
  const { data } = await api.get<AppUser[]>('/users', { params })
  return data
}

export async function createUser(payload: {
  name: string
  role: 'OWNER' | 'MANAGER' | 'STAFF'
  pin?: string
}): Promise<AppUser> {
  const { data } = await api.post<AppUser>('/users', payload)
  return data
}

export async function updateUser(
  userId: number,
  payload: Partial<{ name: string; role: 'OWNER' | 'MANAGER' | 'STAFF'; pin: string; is_active: boolean }>,
): Promise<AppUser> {
  const { data } = await api.patch<AppUser>(`/users/${userId}`, payload)
  return data
}

export async function loginUserSession(payload: { user_id: number; pin?: string }): Promise<UserSession> {
  const { data } = await api.post<UserSession>('/users/session/login', payload)
  return data
}
