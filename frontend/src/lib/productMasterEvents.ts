const PRODUCT_MASTER_CHANGED = 'medical-inventory:product-master-changed'
const PRODUCT_MASTER_CHANNEL = 'medical-inventory-product-master'

export function notifyProductMasterChanged() {
  if (typeof window === 'undefined') return

  window.dispatchEvent(new Event(PRODUCT_MASTER_CHANGED))

  if ('BroadcastChannel' in window) {
    const channel = new BroadcastChannel(PRODUCT_MASTER_CHANNEL)
    channel.postMessage({ type: PRODUCT_MASTER_CHANGED, at: Date.now() })
    channel.close()
  }

  try {
    window.localStorage.setItem(PRODUCT_MASTER_CHANGED, String(Date.now()))
  } catch {
    // Some browser privacy modes block localStorage; same-tab and BroadcastChannel still work.
  }
}

export function subscribeProductMasterChanged(handler: () => void) {
  if (typeof window === 'undefined') return () => {}

  let channel: BroadcastChannel | null = null
  const onLocal = () => handler()
  const onStorage = (event: StorageEvent) => {
    if (event.key === PRODUCT_MASTER_CHANGED) handler()
  }

  window.addEventListener(PRODUCT_MASTER_CHANGED, onLocal)
  window.addEventListener('storage', onStorage)

  if ('BroadcastChannel' in window) {
    channel = new BroadcastChannel(PRODUCT_MASTER_CHANNEL)
    channel.onmessage = (event) => {
      if (event.data?.type === PRODUCT_MASTER_CHANGED) handler()
    }
  }

  return () => {
    window.removeEventListener(PRODUCT_MASTER_CHANGED, onLocal)
    window.removeEventListener('storage', onStorage)
    channel?.close()
  }
}
