import { useQuery } from '@tanstack/react-query'
import { listItems } from '../services/inventory'


export function useItems(q: string){
return useQuery({ queryKey: ['items', q], queryFn: () => listItems(q) })
}