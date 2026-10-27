import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { AuthProvider } from '@/lib/auth';
import { PrefsProvider } from '@/lib/prefs';
import { StepUpProvider, ToastProvider } from '@/components/ui';
import './globals.css';

export const metadata: Metadata = {
  title: 'The K',
  description: 'Paper-trading workspace for traders, brokers and administrators.',
  robots: { index: false, follow: false },
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#08a77b' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-IN" suppressHydrationWarning>
      <body>
        <PrefsProvider>
          <AuthProvider>
            <ToastProvider>
              <StepUpProvider>{children}</StepUpProvider>
            </ToastProvider>
          </AuthProvider>
        </PrefsProvider>
      </body>
    </html>
  );
}
