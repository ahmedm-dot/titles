import { Container, getContainer } from "@cloudflare/containers";

interface Env {
  RESUME_MATCHER: DurableObjectNamespace<ResumeMatcherContainer>;
  FRONTEND_BASE_URL: string;
  LLM_PROVIDER: string;
  LLM_MODEL: string;
  LOG_LEVEL: string;
  SLEEP_AFTER: string;
  BASIC_AUTH_USER: string;
  // Secrets (wrangler secret put ...)
  LLM_API_KEY?: string;
  LLM_API_BASE?: string;
  DATABASE_URL?: string;
  BASIC_AUTH_PASSWORD?: string;
}

export class ResumeMatcherContainer extends Container<Env> {
  defaultPort = 3000;
  // Backend waits up to 30s for health before the frontend starts.
  pingEndpoint = "localhost/api/v1/health";

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.sleepAfter = env.SLEEP_AFTER || "30m";
    // Only pass values that are set, so the image's own defaults still apply.
    const vars: Record<string, string | undefined> = {
      FRONTEND_BASE_URL: env.FRONTEND_BASE_URL,
      LLM_PROVIDER: env.LLM_PROVIDER,
      LLM_MODEL: env.LLM_MODEL,
      LLM_API_KEY: env.LLM_API_KEY,
      LLM_API_BASE: env.LLM_API_BASE,
      DATABASE_URL: env.DATABASE_URL,
      LOG_LEVEL: env.LOG_LEVEL,
    };
    this.envVars = Object.fromEntries(
      Object.entries(vars).filter((e): e is [string, string] => !!e[1]),
    );
  }

  override onError(error: unknown) {
    console.error("Resume Matcher container error:", error);
    throw error;
  }
}

// Constant-time string compare, so the password can't be guessed byte by byte.
function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  }
  return diff === 0;
}

function authorized(request: Request, env: Env): boolean {
  const header = request.headers.get("Authorization") ?? "";
  if (!header.startsWith("Basic ")) return false;
  let decoded: string;
  try {
    decoded = atob(header.slice(6));
  } catch {
    return false;
  }
  const sep = decoded.indexOf(":");
  if (sep < 0) return false;
  return (
    safeEqual(decoded.slice(0, sep), env.BASIC_AUTH_USER) &&
    safeEqual(decoded.slice(sep + 1), env.BASIC_AUTH_PASSWORD!)
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Resume Matcher has no user accounts: anyone who can reach it can read the
    // stored resumes and spend the LLM key. Gate it unless Cloudflare Access is used.
    if (env.BASIC_AUTH_PASSWORD && !authorized(request, env)) {
      return new Response("Authentication required", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="Resume Matcher", charset="UTF-8"' },
      });
    }

    // One named instance: all traffic shares the same container and database.
    const container = getContainer(env.RESUME_MATCHER, "main");
    return container.fetch(request);
  },
} satisfies ExportedHandler<Env>;
