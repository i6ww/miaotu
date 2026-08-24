'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { VideoGenerationView } from '@/components/generator/video-generation-page';
import {
  buildReusableImageReferenceFromId,
  type ReusableImageReference,
} from '@/lib/generation-client';

function buildReferenceFromQuery(referenceId: string | null): ReusableImageReference | null {
  if (!referenceId) return null;
  return buildReusableImageReferenceFromId(referenceId);
}

export default function Page() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const searchParamsString = searchParams.toString();
  const [reference, setReference] = useState<ReusableImageReference | null>(() =>
    buildReferenceFromQuery(searchParams.get('referenceId'))
  );

  const updateReferenceRoute = useCallback(
    (nextReferenceId: string | null) => {
      const params = new URLSearchParams(searchParamsString);

      if (nextReferenceId) {
        params.set('referenceId', nextReferenceId);
      } else {
        params.delete('referenceId');
      }

      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [pathname, router, searchParamsString]
  );

  const setReferenceAndRoute = useCallback(
    (nextReference: ReusableImageReference | null) => {
      setReference(nextReference);
      updateReferenceRoute(nextReference?.generationId ?? null);
    },
    [updateReferenceRoute]
  );

  useEffect(() => {
    const nextReferenceId = searchParams.get('referenceId');
    setReference((current) => {
      if (!nextReferenceId) {
        return current ? null : current;
      }

      return current?.generationId === nextReferenceId
        ? current
        : buildReusableImageReferenceFromId(nextReferenceId);
    });
  }, [searchParams]);

  return (
    <VideoGenerationView
      externalReference={reference}
      onExternalReferenceChange={setReferenceAndRoute}
    />
  );
}
