'use client';

import { DirectionProvider } from '@qarabic/ui/components/direction';
import { Toaster } from '@qarabic/ui/components/sonner';
import { TooltipProvider } from '@qarabic/ui/components/tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';
import { useState, type ReactNode } from 'react';
import { MockGate } from '@/components/mock-gate';

export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { refetchOnWindowFocus: false, retry: 1 },
    },
  });
}

export function Providers({
  dir,
  nonce,
  children,
}: {
  dir: 'rtl' | 'ltr';
  /** This request's CSP nonce, for next-themes' inline theme script (docs/39 P0-2). */
  nonce?: string;
  children: ReactNode;
}) {
  const [queryClient] = useState(makeQueryClient);
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      nonce={nonce}
    >
      <DirectionProvider dir={dir}>
        <TooltipProvider>
          <MockGate>
            <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
            {/* docs/15 §5.9: bottom-start (bottom-right in Arabic), never over the primary action. */}
            <Toaster
              dir={dir}
              position={dir === 'rtl' ? 'bottom-right' : 'bottom-left'}
              closeButton
              richColors={false}
            />
          </MockGate>
        </TooltipProvider>
      </DirectionProvider>
    </ThemeProvider>
  );
}
