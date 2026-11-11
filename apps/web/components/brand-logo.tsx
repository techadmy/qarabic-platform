import { cn } from '@qarabic/ui/lib/utils';
import Image from 'next/image';

/**
 * Qarabic logo (maroon on light, white in dark mode). Both images are rendered and CSS picks one,
 * so the server and the client agree whatever the theme is.
 */
export function BrandLogo({ className, priority }: { className?: string; priority?: boolean }) {
  return (
    <>
      <Image
        src="/brand/logo.png"
        width={394}
        height={112}
        alt="Qarabic"
        priority={priority}
        className={cn('h-auto dark:hidden', className)}
      />
      <Image
        src="/brand/logo-white.png"
        width={210}
        height={56}
        alt="Qarabic"
        priority={priority}
        className={cn('hidden h-auto dark:block', className)}
      />
    </>
  );
}

/** The square Qarabic mark (app icon), for the collapsed sidebar rail. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <Image
      src="/brand/mark.png"
      width={100}
      height={100}
      alt="Qarabic"
      className={cn('size-8', className)}
    />
  );
}
