"use client"

import * as React from "react"
import { cn } from "@qarabic/ui/lib/utils"
import { Progress as ProgressPrimitive } from "radix-ui"

/**
 * Qarabic: Radix needs `value` for aria-valuenow (shadcn's version dropped it), and the bar grows
 * from the inline-start (width, not translateX), so it fills from the right in Arabic.
 */
function Progress({
  className,
  value,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root>) {
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      className={cn(
        "relative flex h-1 w-full items-center overflow-x-hidden rounded-full bg-muted",
        className
      )}
      value={value}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className="h-full bg-primary transition-all"
        style={{ width: `${Math.min(100, Math.max(0, value ?? 0))}%` }}
      />
    </ProgressPrimitive.Root>
  )
}

export { Progress }
