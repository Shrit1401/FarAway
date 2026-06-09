"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Building2, Eye, EyeOff, Loader2, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";

export default function LoginPage() {
  const { login, register, user, loading } = useAuth();
  const router = useRouter();
  const [tab, setTab] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && user) router.replace("/dashboard");
  }, [loading, user, router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (tab === "login") {
        await login(email, password);
      } else {
        await register(email, password, fullName);
      }
      router.replace("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center px-4">
      {/* background grid from globals.css body */}
      <div className="absolute inset-0 bg-city-grid [background-size:32px_32px] opacity-60" />

      <div className="relative z-10 w-full max-w-md">
        <div className="mb-8 flex flex-col items-center gap-3">
          <div className="grid size-14 place-items-center rounded-2xl bg-city-graphite text-white shadow-polis-md">
            <Building2 className="size-7" />
          </div>
          <div className="text-center">
            <h1 className="text-display-md text-foreground">PolisAI</h1>
            <p className="mt-1 text-body-sm text-muted-foreground">AI-powered societal digital twin</p>
          </div>
          <Badge variant="glass" className="gap-1.5">
            <Sparkles className="size-3.5 text-city-civic" />
            GovCloud verified
          </Badge>
        </div>

        <div className="glass-card rounded-2xl p-6 shadow-polis-lg">
          {/* Tabs */}
          <div className="mb-6 flex rounded-lg border border-border/70 bg-city-mist p-1">
            {(["login", "register"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => { setTab(t); setError(null); }}
                className={cn(
                  "flex-1 rounded-md py-2 text-body-sm font-semibold transition-all duration-200",
                  tab === t
                    ? "bg-white text-foreground shadow-polis-xs"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {t === "login" ? "Sign in" : "Create account"}
              </button>
            ))}
          </div>

          <form onSubmit={handleSubmit} className="grid gap-4">
            {tab === "register" && (
              <div className="grid gap-1.5">
                <Label htmlFor="full-name">Full name</Label>
                <Input
                  id="full-name"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="Ada Lovelace"
                  required
                  autoComplete="name"
                />
              </div>
            )}

            <div className="grid gap-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@polisai.gov"
                required
                autoComplete="email"
              />
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="password">Password</Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPw ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={tab === "register" ? "Min 8 chars, 1 uppercase, 1 digit" : "••••••••"}
                  required
                  minLength={tab === "register" ? 8 : undefined}
                  autoComplete={tab === "login" ? "current-password" : "new-password"}
                  className="pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPw((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label={showPw ? "Hide password" : "Show password"}
                >
                  {showPw ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
            </div>

            {error && (
              <p className="rounded-md border border-city-coral/30 bg-city-coral/10 px-3 py-2 text-body-sm text-city-coral">
                {error}
              </p>
            )}

            <Button type="submit" variant="signal" className="mt-1 w-full" disabled={busy}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              {tab === "login" ? "Sign in to PolisAI" : "Create account"}
            </Button>
          </form>

          <p className="mt-4 text-center text-caption text-muted-foreground">
            {tab === "login" ? "New to PolisAI? " : "Already have an account? "}
            <button
              type="button"
              onClick={() => { setTab(tab === "login" ? "register" : "login"); setError(null); }}
              className="font-semibold text-city-civic hover:underline"
            >
              {tab === "login" ? "Create account" : "Sign in"}
            </button>
          </p>
        </div>

        <p className="mt-6 text-center text-caption text-muted-foreground">
          Policy testing, civic simulation, AI governance analysis
        </p>
      </div>
    </div>
  );
}
