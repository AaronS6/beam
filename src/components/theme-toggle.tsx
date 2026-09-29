"use client";

import * as React from "react";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";

export function ThemeToggle({ className }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  const isDark = resolvedTheme === "dark";

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      onClick={() => setTheme(isDark ? "light" : "dark")}
      className={`relative h-9 w-9 rounded-full text-muted-foreground hover:text-foreground hover:bg-secondary/60 ${className ?? ""}`}
    >
      {mounted ? (
        isDark ? (
          <Sun className="h-[18px] w-[18px]" strokeWidth={1.75} />
        ) : (
          <Moon className="h-[18px] w-[18px]" strokeWidth={1.75} />
        )
      ) : (
        <span className="h-[18px] w-[18px]" />
      )}
    </Button>
  );
}
