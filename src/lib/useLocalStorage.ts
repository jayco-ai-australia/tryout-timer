'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * A string filter value backed by localStorage. Reads the stored value once on
 * mount and writes on every subsequent change. The first write is skipped so a
 * restored value doesn't get clobbered by the default before the read effect runs.
 */
export function usePersistedFilter(key: string, initial = ''): [string, (value: string) => void] {
  const [value, setValue] = useState(initial)
  const skipNextWrite = useRef(true)

  useEffect(() => {
    const stored = window.localStorage.getItem(key)
    if (stored != null) setValue(stored)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  useEffect(() => {
    if (skipNextWrite.current) { skipNextWrite.current = false; return }
    window.localStorage.setItem(key, value)
  }, [key, value])

  return [value, setValue]
}

/**
 * A JSON-serializable value backed by localStorage — for state richer than the single string
 * usePersistedFilter handles (e.g. /collect's array of active timers, so an accidental tablet
 * refresh recovers running timers instead of losing them). Same skip-first-write mount/read
 * pattern as usePersistedFilter, just generic and JSON-encoded.
 */
export function usePersistedState<T>(key: string, initial: T): [T, (value: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(initial)
  const skipNextWrite = useRef(true)

  useEffect(() => {
    const stored = window.localStorage.getItem(key)
    if (stored != null) {
      try {
        setValue(JSON.parse(stored) as T)
      } catch {
        // Corrupt/incompatible stored value — ignore and keep the default.
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  useEffect(() => {
    if (skipNextWrite.current) { skipNextWrite.current = false; return }
    window.localStorage.setItem(key, JSON.stringify(value))
  }, [key, value])

  return [value, setValue]
}
