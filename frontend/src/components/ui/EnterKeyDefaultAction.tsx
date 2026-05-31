import { useEffect } from 'react'

function isVisible(el: HTMLElement) {
  const style = window.getComputedStyle(el)
  return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null
}

function isEditableSingleLine(target: EventTarget | null): target is HTMLInputElement {
  if (!(target instanceof HTMLInputElement)) return false
  if (target.disabled || target.readOnly) return false
  if (target.closest('.MuiAutocomplete-root')) return false
  if (target.getAttribute('role') === 'combobox') return false

  const type = String(target.type || 'text').toLowerCase()
  return !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(type)
}

function hasOpenPicker() {
  const pickers = Array.from(document.querySelectorAll<HTMLElement>('[role="listbox"], [role="menu"]'))
  return pickers.some(isVisible)
}

function candidateButtons(scope: ParentNode, target: HTMLElement) {
  const buttons = Array.from(scope.querySelectorAll<HTMLButtonElement>('button'))
  return buttons
    .filter((button) => {
      if (button.disabled || button.getAttribute('aria-disabled') === 'true') return false
      if (!isVisible(button)) return false
      if (button.classList.contains('MuiButton-colorError')) return false
      if (button.matches('[data-enter-ignore="true"]')) return false

      const label = String(button.textContent || button.getAttribute('aria-label') || '').trim().toLowerCase()
      if (/^(cancel|close|back|delete|remove|reset)$/i.test(label)) return false

      return (
        button.matches('[data-enter-default="true"]') ||
        (button.getAttribute('type') === 'submit' && Boolean(button.closest('form'))) ||
        button.classList.contains('MuiButton-contained')
      )
    })
    .sort((a, b) => {
      const aDefault = a.matches('[data-enter-default="true"]') ? 0 : 1
      const bDefault = b.matches('[data-enter-default="true"]') ? 0 : 1
      if (aDefault !== bDefault) return aDefault - bDefault

      const aAfter = target.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING ? 0 : 1
      const bAfter = target.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? 0 : 1
      if (aAfter !== bAfter) return aAfter - bAfter

      return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
    })
}

export default function EnterKeyDefaultAction() {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Enter') return
      if (event.defaultPrevented || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return
      if (hasOpenPicker()) return
      if (!isEditableSingleLine(event.target)) return

      const target = event.target
      const scope =
        target.closest('[role="dialog"]') ||
        target.closest('form') ||
        target.closest('.MuiPaper-root') ||
        target.closest('main') ||
        document.body

      const [button] = candidateButtons(scope, target)
      if (!button) return

      event.preventDefault()
      button.click()
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [])

  return null
}
