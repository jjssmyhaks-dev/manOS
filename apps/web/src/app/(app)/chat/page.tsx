import { Suspense } from 'react';
import { ChatHome } from '@/components/chat-home';

export default function Page() {
  // Suspense boundary required: ChatHome reads the ?q= deep link via
  // useSearchParams, which cannot be prerendered without one.
  return (
    <Suspense fallback={null}>
      <ChatHome />
    </Suspense>
  );
}
