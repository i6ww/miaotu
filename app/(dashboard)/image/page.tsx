'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ImageGenerationPage } from '@/components/generator/image-generation-page';
import type { Generation } from '@/types';
import {
  buildReusableImageReference,
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

  const handleReuseGeneration = useCallback(
    (generation: Generation, target: 'image' | 'video') => {
      const reusableReference = buildReusableImageReference(generation);
      if (!reusableReference) {
        return;
      }

      if (target === 'image') {
        setReferenceAndRoute(reusableReference);
        return;
      }

      router.push(`/video?referenceId=${encodeURIComponent(reusableReference.generationId)}`);
    },
    [router, setReferenceAndRoute]
  );

  return (
    <ImageGenerationPage
      externalReference={reference}
      onClearExternalReference={() => setReferenceAndRoute(null)}
      onReuseGeneration={handleReuseGeneration}
    />
  );
}
