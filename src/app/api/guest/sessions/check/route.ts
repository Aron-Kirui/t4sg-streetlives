import { NextResponse } from "next/server";
import { pickNavigator, LambdaNavigator, ISO_TO_FULL } from "@/lib/routing";

const LAMBDA = process.env.NEXT_PUBLIC_API_URL!;
const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN!;
const AUTH0_CLIENT_ID = process.env.AUTH0_CLIENT_ID!;
const AUTH0_CLIENT_SECRET = process.env.AUTH0_CLIENT_SECRET!;
const AUTH0_AUDIENCE = process.env.AUTH0_AUDIENCE!;

async function getM2MToken(): Promise<string> {
  const res = await fetch(`https://${AUTH0_DOMAIN}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: AUTH0_CLIENT_ID,
      client_secret: AUTH0_CLIENT_SECRET,
      audience: AUTH0_AUDIENCE,
    }),
  });
  if (!res.ok) throw new Error(`M2M token failed: ${res.status}`);
  const data = await res.json();
  return data.access_token as string;
}

async function lambdaM2M(token: string, path: string): Promise<Response> {
  return fetch(`${LAMBDA}${path}`, {
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  });
}

// GET /api/guest/sessions/check?needCategory=X&language=Y
// Runs routing only (no session created) and returns immediately.
// Used by the frontend to show the queue screen before the slow Lambda call.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const needCategory = url.searchParams.get("needCategory") ?? "other";
  const language = url.searchParams.get("language") ?? undefined;
  const languageNormalized = language
    ? (ISO_TO_FULL[language.toLowerCase()] ?? language)
    : undefined;

  let m2mToken: string;
  try {
    m2mToken = await getM2MToken();
  } catch {
    return NextResponse.json({ hasNavigator: true });
  }

  const [navsRes, loadRes] = await Promise.all([
    lambdaM2M(m2mToken, "/navigators"),
    lambdaM2M(m2mToken, "/sessions/load"),
  ]);

  const navsBody = navsRes.ok ? await navsRes.json().catch(() => []) : [];
  const navList: LambdaNavigator[] = Array.isArray(navsBody) ? navsBody : (navsBody.navigators ?? []);

  let loadMap: Record<string, number> | null = null;
  if (loadRes.ok) {
    const loadBody = await loadRes.json().catch(() => null);
    loadMap = (loadBody?.load ?? {}) as Record<string, number>;
  }

  const pick = pickNavigator(navList, loadMap, { needCategory, language: languageNormalized }, new Date());

  return NextResponse.json({ hasNavigator: pick !== null });
}
