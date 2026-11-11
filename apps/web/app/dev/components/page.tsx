import { notFound } from 'next/navigation';
import { ComponentsPreview } from './components-preview';

/**
 * RTL spike page (N0): every shadcn component used so far, rendered in the current locale.
 * Development only: production builds answer 404 (see apps/web/RTL.md).
 */
export default function DevComponentsPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <ComponentsPreview />;
}
