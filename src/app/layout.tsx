import type { Metadata, Viewport } from 'next'
import { Montserrat } from 'next/font/google'
import './globals.css'
import ServiceWorkerRegister from '@/components/ServiceWorkerRegister'

const montserrat = Montserrat({
  subsets: ['latin'],
  variable: '--font-montserrat',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'TryOut Timer',
  description: 'Chassis tryout session timer and tracking',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'TryOut Timer',
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
    <html lang="en" className={montserrat.variable}>
      <head>
        <link rel="apple-touch-icon" href="/icons/icon-192.png" />
      </head>
      <body>
        <ServiceWorkerRegister />
        {children}
      </body>
    </html>
  )
}
