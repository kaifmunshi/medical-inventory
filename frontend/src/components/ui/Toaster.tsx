import { createContext, useCallback, useContext, useState } from 'react'
import { Alert, Snackbar } from '@mui/material'

type Toast = { id:number; msg:string; severity:'success'|'error'|'info'|'warning' }
const Ctx = createContext<{push:(msg:string,severity?:Toast['severity'])=>void}>({push:()=>{}})

export function useToast(){ return useContext(Ctx) }

export default function Toaster({ children }:{children:any}){
  const [items, setItems] = useState<Toast[]>([])
  const push = useCallback((msg:string, severity:Toast['severity']='success')=>{
    setItems(prev=>[...prev, { id: Date.now()+Math.random(), msg, severity }])
  },[])
  const close = (id:number)=> setItems(prev=>prev.filter(x=>x.id!==id))
  return (
    <Ctx.Provider value={{push}}>
      {children}
      {items.map(t=>(
        <Snackbar key={t.id} open autoHideDuration={2500} onClose={()=>close(t.id)}>
          <Alert onClose={()=>close(t.id)} severity={t.severity} variant="filled">{t.msg}</Alert>
        </Snackbar>
      ))}
    </Ctx.Provider>
  )
}
