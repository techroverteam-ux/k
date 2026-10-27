'use client';
import type { ReactNode } from 'react';
import { Shell } from '@/components/Shell';
export default function L({ children }: { children: ReactNode }) {
  return <Shell roles={['SUPER_ADMIN']}>{children}</Shell>;
}
