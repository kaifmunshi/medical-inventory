import { useEffect } from 'react'

export default function DisableNumberInputScroll() {
  useEffect(() => {
    const handleWheel = (event: WheelEvent) => {
      const target = event.target
      if (!(target instanceof Element)) return

      const numberInput = target.closest('input[type="number"]')
      if (!(numberInput instanceof HTMLInputElement)) return

      // Blur before the browser applies wheel-based value stepping.
      numberInput.blur()
    }

    document.addEventListener('wheel', handleWheel, { capture: true, passive: false })
    return () => {
      document.removeEventListener('wheel', handleWheel, true)
    }
  }, [])

  return null
}
