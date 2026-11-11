'use client';

import { DirectionProvider } from '@qarabic/ui/components/direction';
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

export function Providers({ dir, children }: { dir: 'rtl' | 'ltr'; children: ReactNode }) {
  const [queryClient] = useState(makeQueryClient);
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <DirectionProvider dir={dir}>
        <TooltipProvider>
          <MockGate>
            <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
          </MockGate>
        </TooltipProvider>
      </DirectionProvider>
    </ThemeProvider>
  );
}
