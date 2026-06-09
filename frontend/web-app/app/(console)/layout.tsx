"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { SimSelector } from "@/components/polisai/sim-selector";
import { useAuth } from "@/lib/auth-context";
import { useSim } from "@/lib/sim-context";

export default function ConsoleLayout({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const { simId } = useSim();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="size-5 animate-spin text-city-civic" />
      </div>
    );
  }

  if (!user) return null;

  if (!simId) {
    return (
      <div className="relative flex min-h-screen items-center justify-center px-4">
        <div className="absolute inset-0 bg-city-grid [background-size:32px_32px] opacity-60" />
        <div className="relative z-10 w-full max-w-lg">
          <div className="mb-6 text-center">
            <p className="text-title-md font-bold text-foreground">Welcome, {user.full_name ?? user.email}</p>
            <p className="mt-1 text-body-sm text-muted-foreground">Select or create a simulation to begin</p>
          </div>
          <SimSelector />
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
