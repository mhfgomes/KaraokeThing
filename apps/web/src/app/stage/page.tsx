import type { Metadata } from 'next';
import { StageDisplay } from '@/components/stage-display';

export const metadata: Metadata = { title: 'KaraokeThing Stage' };

export default function StagePage() {
  return <StageDisplay />;
}
