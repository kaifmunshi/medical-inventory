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

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
      const target = event.target
      if (!(target instanceof HTMLInputElement)) return
      if (target.type !== 'number') return

      event.preventDefault()
    }

    document.addEventListener('wheel', handleWheel, { capture: true, passive: false })
    document.addEventListener('keydown', handleKeyDown, true)
    return () => {
      document.removeEventListener('wheel', handleWheel, true)
      document.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [])

  return null
}
