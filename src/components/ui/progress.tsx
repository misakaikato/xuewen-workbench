import * as React from "react"
import * as ProgressPrimitive from "@radix-ui/react-progress"

import { cn } from "@/lib/utils"

// value 为空（无法计量）时用 indeterminate：40% 宽度循环滑动，不显示假百分比
function Progress({
  className,
  value,
  indeterminate = false,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root> & {
  indeterminate?: boolean
}) {
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      className={cn("bg-primary/20 relative h-2 w-full overflow-hidden rounded-full", className)}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className={cn(
          "bg-primary h-full w-full flex-1 transition-all",
          indeterminate && "wb-progress-indeterminate"
        )}
        style={indeterminate ? undefined : { transform: `translateX(-${100 - (value || 0)}%)` }}
      />
    </ProgressPrimitive.Root>
  )
}

export { Progress }
