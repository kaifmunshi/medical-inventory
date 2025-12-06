import { useMutation } from '@tanstack/react-query'
import { createBill } from '../services/billing'


export function useCreateBill(){
return useMutation({ mutationFn: createBill })
}