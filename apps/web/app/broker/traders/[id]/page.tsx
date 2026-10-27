'use client';
import { useParams } from 'next/navigation';
import { AccountDetail } from '@/components/accounts';

export default function TraderDetail() {
  const { id } = useParams<{ id: string }>();
  return <AccountDetail id={id} back={{ href: '/broker/traders', label: 'Traders' }} />;
}
