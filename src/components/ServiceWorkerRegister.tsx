'use client'

import { useEffect } from 'react'

/**
 * Same basePath trap as the manifest link in app/layout: next.config.mjs mounts the app at
 * /jmotion, and that prefix is NOT applied to a runtime string like this one. '/sw.js' was
 * requested at the server root and 404'd — silently, because the .catch() swallows it, so the
 * app has had no service worker and no offline page for as long as the basePath has existed.
 *
 * Registering at /jmotion/sw.js also gives the worker a /jmotion/ scope, which is the right
 * scope for an app mounted there.
 */
const BASE_PATH = '/jmotion'

export default function ServiceWorkerRegister() {
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register(`${BASE_PATH}/sw.js`).catch(() => {})
    }
  }, [])
  return null
}
