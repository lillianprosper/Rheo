import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Rheo Admin',
  description: 'Internal staff portal for Rheo Transport Services',
  robots: { index: false, follow: false },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "'DM Sans', -apple-system, sans-serif" }}>
        {children}
      </body>
    </html>
  )
}
