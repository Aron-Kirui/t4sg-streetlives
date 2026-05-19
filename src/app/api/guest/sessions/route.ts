import { NextResponse } from "next/server";
import { pickNavigator, isWithinSchedule, LambdaNavigator, ISO_TO_FULL } from "@/lib/routing";
import { setSessionNeedCategory } from "@/lib/transferRequestStore";

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

async function lambdaM2M(token: string, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${LAMBDA}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers as Record<string, string> | undefined),
      Authorization: `Bearer ${token}`,
    },
  });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const needCategory: string = body.needCategory ?? body.need_category ?? "other";
  const language: string | undefined = body.language;
  // Normalize ISO code → full name so Lambda's routing can match navigator language profiles.
  // e.g. "en" → "english", "es" → "spanish". Unknown codes pass through unchanged.
  const languageNormalized: string | undefined = language
    ? (ISO_TO_FULL[language.toLowerCase()] ?? language)
    : undefined;

  console.log("[session:create] →", `needCategory=${needCategory} language=${language ?? "(none)"} → ${languageNormalized ?? "(none)"}`);

  // Get M2M token — without it we can't fetch navigator/session data for routing
  let m2mToken: string;
  try {
    m2mToken = await getM2MToken();
  } catch (err) {
    console.error("[session:create] M2M token failed, routing skipped:", err);
    // Fallback: create session without pre-routing
    const res = await fetch(`${LAMBDA}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, need_category: needCategory }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) console.error("[session:create] ← error", res.status, JSON.stringify(data));
    else {
      console.log("[session:create] ← (no routing) full response:", JSON.stringify(data, null, 2));
      const sid: string | undefined = data.sessionId ?? data.id;
      if (sid) setSessionNeedCategory(sid, needCategory);
    }
    return NextResponse.json(data, { status: res.status });
  }

  // Fetch navigators and active load counts in parallel for routing
  const [navsRes, loadRes] = await Promise.all([
    lambdaM2M(m2mToken, "/navigators"),
    lambdaM2M(m2mToken, "/sessions/load"),
  ]);

  const navsBody = navsRes.ok ? await navsRes.json().catch(() => []) : [];
  const navList: LambdaNavigator[] = Array.isArray(navsBody) ? navsBody : (navsBody.navigators ?? []);

  // null means load data unavailable; {} means available but no active sessions.
  // Keeping these distinct prevents treating every navigator as load=0 when data is missing.
  let loadMap: Record<string, number> | null = null;

  if (loadRes.status === 403) {
    console.warn("[session:create] /sessions/load returned 403 — load balancing disabled");
  } else if (loadRes.ok) {
    const loadBody = await loadRes.json().catch(() => null);
    loadMap = (loadBody?.load ?? {}) as Record<string, number>;
    console.log(
      `[session:create] routing pool: ${navList.length} navigators, loadMap=${JSON.stringify(loadMap)}`,
    );
  } else {
    console.warn(`[session:create] /sessions/load failed: status=${loadRes.status} — load balancing disabled`);
  }

  if (loadMap === null) {
    console.log(`[session:create] routing pool: ${navList.length} navigators, load data unavailable`);
  }

  // Per-navigator eligibility diagnostic
  const now = new Date();
  for (const n of navList) {
    const load = loadMap !== null ? (loadMap[n.id] ?? 0) : null;
    const reasons: string[] = [];
    if (n.status !== "available") reasons.push(`status=${n.status}`);
    if ((n.capacity ?? 0) <= 0) reasons.push(`capacity=${n.capacity}`);
    if (!isWithinSchedule(n.availability_schedule, now, n.timezone)) reasons.push("outside-schedule");
    if (load !== null && (n.capacity ?? 0) > 0 && load >= (n.capacity ?? 0)) reasons.push(`overload=${load}/${n.capacity}`);
    if (language) {
      const langFull = (ISO_TO_FULL[language.toLowerCase()] ?? language).toLowerCase().replace(/[\s_-]/g, "");
      const speaks = n.languages?.some((l) => l.toLowerCase().replace(/[\s_-]/g, "") === langFull);
      if (!speaks) reasons.push(`no-lang:${language}`);
    }
    console.log(
      `[session:create]   nav=${n.id.slice(0, 8)} status=${n.status} cap=${n.capacity} load=${load} ` +
      `sched=${JSON.stringify(n.availability_schedule)} ` +
      `tags=${JSON.stringify(n.expertise_tags)} langs=${JSON.stringify(n.languages)} ` +
      (reasons.length ? `SKIP:${reasons.join(",")}` : "ELIGIBLE"),
    );
  }

  const pick = pickNavigator(navList, loadMap, { needCategory, language }, now);

  if (pick) {
    console.log(
      `[session:create] routing pick: navigator=${pick.navigatorId} tier=${pick.tier} loadRatio=${pick.loadRatio.toFixed(2)}`,
    );
  } else {
    console.log("[session:create] routing pick: null (no eligible navigator → will queue)");
  }

  // Create session, passing our pick so Lambda can try to honor it.
  // language is normalized to full name so Lambda's routing can match navigator profiles.
  const createBody: Record<string, unknown> = {
    ...body,
    need_category: needCategory,
    needCategory,
    ...(languageNormalized !== undefined ? { language: languageNormalized } : {}),
    ...(pick
      ? { navigator_id: pick.navigatorId, navigatorId: pick.navigatorId }
      : {}),
  };

  const createRes = await lambdaM2M(m2mToken, "/sessions", {
    method: "POST",
    body: JSON.stringify(createBody),
  });

  const data = await createRes.json().catch(() => ({}));

  if (!createRes.ok) {
    console.error("[session:create] ← error", createRes.status, JSON.stringify(data));
    return NextResponse.json(data, { status: createRes.status });
  }

  console.log("[session:create] ← full response:", JSON.stringify(data, null, 2));

  const sessionId: string | undefined = data.sessionId ?? data.id;
  if (sessionId) setSessionNeedCategory(sessionId, needCategory);
  const lambdaNav: string | null = data.assignedNavigatorId ?? data.navigator_id ?? null;

  // Helper: resolve a navigator's display name from navList
  const resolveNavName = (navId: string | null): string | null => {
    if (!navId) return null;
    const nav = navList.find((n) => n.id === navId);
    if (!nav) return null;
    return [nav.first_name, nav.last_name].filter(Boolean).join(" ") ||
      (nav.nav_group ?? "").replace(/_/g, " ") || null;
  };

  // If Lambda assigned someone different from our pick, override via transfer
  if (pick && sessionId && lambdaNav !== pick.navigatorId) {
    console.log(
      `[session:create] Lambda assigned ${lambdaNav ?? "none"}, transferring to ${pick.navigatorId}`,
    );
    const xferRes = await lambdaM2M(m2mToken, `/sessions/${sessionId}/transfer`, {
      method: "POST",
      body: JSON.stringify({
        target_navigator_id: pick.navigatorId,
      }),
    });
    if (xferRes.ok) {
      const xferData = await xferRes.json().catch(() => ({}));
      console.log("[session:create] transfer ← ok", JSON.stringify(xferData));
      const assignedNavigatorName = resolveNavName(pick.navigatorId);
      return NextResponse.json(
        { ...data, assignedNavigatorId: pick.navigatorId, navigator_id: pick.navigatorId, assignedNavigatorName },
        { status: createRes.status },
      );
    } else {
      const xferErr = await xferRes.json().catch(() => ({}));
      console.warn(
        "[session:create] transfer failed:", xferRes.status, JSON.stringify(xferErr),
      );
    }
  }

  const assignedNavigatorName = resolveNavName(lambdaNav);
  return NextResponse.json({ ...data, assignedNavigatorName }, { status: createRes.status });
}
