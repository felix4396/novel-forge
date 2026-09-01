import { useState, type FormEvent } from "react";
import { Eye, EyeOff, LoaderCircle, LockKeyhole } from "lucide-react";
import type { ApiHttpError } from "@/api/client";
import DesktopBrandMark from "@/components/layout/DesktopBrandMark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/auth/AuthContext";

export default function LoginPage({ configured }: { configured: boolean }) {
  const { login } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!configured || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      await login(username, password);
    } catch (requestError) {
      const status = (requestError as ApiHttpError).status;
      setError(status === 429 ? "登录尝试过于频繁，请稍后再试。" : "账号或密码错误，请重新输入。");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="relative flex min-h-[100dvh] items-center justify-center overflow-hidden bg-[#f7f7f8] px-5 py-10">
      <div className="absolute inset-x-0 top-0 h-1 bg-[#002fa7]" />
      <section className="w-full max-w-[420px] border border-slate-200 bg-white p-7 shadow-[0_18px_60px_rgba(15,23,42,0.08)] sm:p-9">
        <div className="mb-8 flex items-center gap-3 border-b border-slate-200 pb-6">
          <DesktopBrandMark className="h-11 w-11 shrink-0" />
          <div className="min-w-0">
            <h1 className="text-xl font-semibold text-slate-950">AI 小说创作工作台</h1>
            <p className="mt-1 text-sm text-slate-500">登录后继续你的创作项目</p>
          </div>
        </div>

        {!configured ? (
          <div className="border border-amber-300 bg-amber-50 p-4 text-sm leading-6 text-amber-900" role="alert">
            服务端尚未配置登录账号。请先设置 AUTH_USERNAME、AUTH_PASSWORD_HASH 和 AUTH_SESSION_SECRET。
          </div>
        ) : (
          <form className="space-y-5" onSubmit={submit}>
            <label className="block space-y-2 text-sm font-medium text-slate-800">
              <span>账号</span>
              <Input
                autoComplete="username"
                autoFocus
                maxLength={128}
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                disabled={submitting}
              />
            </label>
            <label className="block space-y-2 text-sm font-medium text-slate-800">
              <span>密码</span>
              <div className="relative">
                <Input
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  maxLength={1024}
                  className="pr-11"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  disabled={submitting}
                />
                <button
                  type="button"
                  className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-slate-500 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-900"
                  onClick={() => setShowPassword((current) => !current)}
                  aria-label={showPassword ? "隐藏密码" : "显示密码"}
                  title={showPassword ? "隐藏密码" : "显示密码"}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </label>
            {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
            <Button className="w-full bg-[#002fa7] hover:bg-[#002780]" type="submit" disabled={!username || !password || submitting}>
              {submitting ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <LockKeyhole className="h-4 w-4" />}
              {submitting ? "正在登录" : "登录"}
            </Button>
          </form>
        )}
      </section>
    </main>
  );
}
