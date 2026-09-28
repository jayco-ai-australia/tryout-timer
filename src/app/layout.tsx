import type { Metadata, Viewport } from 'next'
import { Inter, Montserrat } from 'next/font/google'
import './globals.css'
import ServiceWorkerRegister from '@/components/ServiceWorkerRegister'

const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-inter',
  display: 'swap',
})

/** The Jayco UI system's body face (--j-font-body is 'Montserrat', 'Inter', system-ui) — this
 * app renders in Inter everywhere else, so for now the variable is only picked up by the
 * roadmap timeline's month labels. */
const montserrat = Montserrat({
  subsets: ['latin'],
  weight: ['400', '600', '700'],
  variable: '--font-montserrat',
  display: 'swap',
})

/**
 * next.config.mjs sets basePath: '/jmotion'. That prefix is applied automatically to next/link,
 * next/image and static imports — but NOT to metadata URLs or to a hand-written <link href>,
 * which are emitted verbatim. So `/manifest.json` was requested at the server root and 404'd,
 * taking the PWA install prompt with it. Both references below carry the prefix explicitly.
 *
 * Kept as a constant rather than repeated, so the two can't drift from each other; it still has
 * to be changed alongside next.config.mjs if the mount point ever moves.
 */
const BASE_PATH = '/jmotion'

export const metadata: Metadata = {
  title: 'J-Motion',
  description: 'Production line operations time study',
  manifest: `${BASE_PATH}/manifest.json`,
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'J-Motion',
  },
}

export const viewport: Viewport = {
  themeColor: '#0079c1',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className={`${inter.variable} ${montserrat.variable}`}>
      <head>
        <link rel="apple-touch-icon" href={`${BASE_PATH}/icons/icon-192.png`} />
      </head>
      <body>
        <ServiceWorkerRegister />
        {children}
      </body>
    </html>
  )
}
