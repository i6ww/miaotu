'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { DashboardBackground } from './dashboard-background';

export function DashboardBackgroundWrapper() {
  const pathname = usePathname();
  // /batch-image keeps the same heavy grid UI as /image & /video, where the
  // animated blobs previously caused full-page flicker (browser compositing
  // cost of several large blur layers animating transforms at once).
  const reducedEffects =
    pathname.startsWith('/create') ||
    pathname.startsWith('/image') ||
    pathname.startsWith('/batch-image') ||
    pathname.startsWith('/video') ||
    pathname.startsWith('/history');

  useEffect(() => {
    document.body.classList.toggle('dashboard-reduced-effects', reducedEffects);

    return () => {
      document.body.classList.remove('dashboard-reduced-effects');
    };
  }, [reducedEffects]);

  return <DashboardBackground reducedEffects={reducedEffects} />;
}
