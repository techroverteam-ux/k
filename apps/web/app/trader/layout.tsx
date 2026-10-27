'use client';
import type { ReactNode } from 'react';
import { Shell } from '@/components/Shell';
import { TermsGate } from '@/components/TermsGate';
export default function L({ children }: { children: ReactNode }) {
  return (
    <Shell roles={['TRADER']}>
      <TermsGate />
      {children}
    </Shell>
  );
}
