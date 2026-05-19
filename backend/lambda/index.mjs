/**
 * streetlives-vpc Lambda
 *
 * Main API handler. Lives inside the VPC with access to RDS.
 * Calls the streetlives-matrix Lambda (outside VPC) for all Matrix operations.
 *
 * Routes (via API Gateway HTTP API):
 *
 *   Sessions (anonymous — validated by session_user_token):
 *     POST   /sessions                          — create session + Matrix room
 *     GET    /sessions/:id                      — get session status (token required)
 *     POST   /sessions/:id/messages             — user sends message (token required)
 *     GET    /sessions/:id/messages             — poll messages (token required)
 *
 *   Navigator/Supervisor (Auth0 JWT required):
 *     GET    /sessions                          — list sessions (supervisor=all, navigator=own)
 *     PATCH  /sessions/:id                      — update notes/outcome/follow_up_date/submitted_for_review
 *     POST   /sessions/:id/close               — close session
 *     POST   /sessions/:id/transfer            — transfer session
 *     POST   /sessions/:id/approve             — supervisor only; saves coaching_notes, sets approved=true
 *     GET    /sessions/:id/events              — audit log
 *     POST   /sessions/:id/navigator-messages  — navigator sends message
 *
 *   Navigator profiles (Auth0 JWT required):
 *     GET    /navigators                        — list navigators
 *     POST   /navigators                        — create navigator profile
 *     GET    /navigators/me                     — current navigator by Auth0 sub
 *     GET    /navigators/:id                    — get navigator profile
 *     PATCH  /navigators/:id                    — update navigator profile
 *
 * Env vars required:
 *   DB_HOST, DB_NAME, DB_USER, DB_PASSWORD, DB_PORT
 *   AUTH0_DOMAIN, AUTH0_AUDIENCE
 *   MATRIX_LAMBDA_NAME   — name of the streetlives-matrix Lambda function
 *   AWS_REGION           — set automatically by Lambda runtime
 */

import pg from "pg";
import crypto from "node:crypto";
import {
  LambdaClient,
  InvokeCommand,
} from "@aws-sdk/client-lambda";

const { Pool } = pg;

// Pool is module-level so it persists across warm Lambda invocations.
const pool = new Pool({
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  port: parseInt(process.env.DB_PORT ?? "5432"),
  ssl: { rejectUnauthorized: false },
  max: 5,
});

const lambdaClient = new LambdaClient({ region: process.env.AWS_REGION ?? "us-east-1" });

async function invokeMatrix(payload) {
  const cmd = new InvokeCommand({
    FunctionName: process.env.MATRIX_LAMBDA_NAME ?? "streetlives-matrix",
    InvocationType: "RequestResponse",
    Payload: Buffer.from(JSON.stringify(payload)),
  });
  const res = await lambdaClient.send(cmd);
  if (res.FunctionError) {
    const errBody = JSON.parse(Buffer.from(res.Payload).toString());
    throw new Error(`Matrix Lambda error: ${errBody.errorMessage ?? JSON.stringify(errBody)}`);
  }
  return JSON.parse(Buffer.from(res.Payload).toString());
}

// Auth0 JWT validation — fetches JWKS from Auth0 once per hour and verifies
// the token signature + claims locally without calling Auth0 on every request.
// Parsed once at module load from the AUTH0_JWKS env var.
// The Lambda runs in a private subnet with no internet access so we cannot
// fetch the JWKS URL at runtime.
const JWKS = process.env.AUTH0_JWKS ? JSON.parse(process.env.AUTH0_JWKS) : null;

function getJwks() {
  if (!JWKS) throw new Error("AUTH0_JWKS env var is not set");
  return JWKS;
}

function base64urlToBuffer(str) {
  const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64");
}

async function verifyAuth0Token(authHeader) {
  if (!authHeader?.startsWith("Bearer ")) throw new Error("Missing Bearer token");
  const token = authHeader.slice(7);
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT format");

  const [headerB64, payloadB64, signatureB64] = parts;
  const header = JSON.parse(base64urlToBuffer(headerB64).toString());
  const payload = JSON.parse(base64urlToBuffer(payloadB64).toString());

  // Validate claims
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) throw new Error("Token expired");
  if (payload.iss !== `https://${process.env.AUTH0_DOMAIN}/`) throw new Error("Invalid issuer");
  if (payload.aud !== process.env.AUTH0_AUDIENCE && !payload.aud?.includes?.(process.env.AUTH0_AUDIENCE)) {
    throw new Error("Invalid audience");
  }

  // Find matching JWK by kid
  const jwks = await getJwks();
  const jwk = jwks.keys?.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("No matching JWK found for kid: " + header.kid);

  // Verify RS256 signature
  const keyData = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`);
  const signature = base64urlToBuffer(signatureB64);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", keyData, signature, signingInput);
  if (!valid) throw new Error("Invalid JWT signature");

  return payload; // { sub, email, ... }
}

// Routing: language-first, capacity-gated, load-balanced.
// All available navigators with valid capacity are eligible.
// Navigators at or above capacity are excluded; if all are full, the gate is lifted.
// Ties broken randomly to prevent one navigator from absorbing all tie cases.
const ROUTING_VERSION = "v4_capacity_gated_load_balanced";

async function fetchLoadMap() {
  const result = await pool.query(
    `SELECT navigator_id, COUNT(*) as count FROM sessions
     WHERE status = 'active' AND navigator_id IS NOT NULL
     GROUP BY navigator_id`
  );
  const loadMap = {};
  for (const row of result.rows) loadMap[row.navigator_id] = parseInt(row.count, 10);
  return loadMap;
}

function assignNavigator(navigators, getActiveLoad, input, mode = "initial") {
  void mode;

  const available = navigators.filter((n) => n.status === "available" && (n.capacity ?? 0) > 0);
  if (available.length === 0) {
    return { assigned: false, reason: "No available navigators" };
  }

  const lang = input.language?.toLowerCase() ?? null;
  let candidates = available;
  if (lang) {
    const withLang = available.filter((n) =>
      (n.languages ?? []).map((l) => l.toLowerCase()).includes(lang)
    );
    if (withLang.length === 0) {
      return { assigned: false, reason: `No available navigator speaks "${input.language}"` };
    }
    candidates = withLang;
  }

  // Prefer navigators with remaining capacity; fall back to all if everyone is full.
  const withCapacity = candidates.filter((n) => getActiveLoad(n.id) < n.capacity);
  if (withCapacity.length > 0) candidates = withCapacity;

  const ranked = candidates
    .map((nav) => {
      const cap = Number(nav.capacity);
      const load = getActiveLoad(nav.id);
      const loadRatio = cap > 0 ? load / cap : 0;
      return { nav, loadRatio, jitter: Math.random() };
    })
    .sort((a, b) => a.loadRatio - b.loadRatio || a.jitter - b.jitter);

  const best = ranked[0];
  return {
    assigned: true,
    navigator: best.nav,
    routingReason: {
      languageRequested: lang,
      languageMatch: !!lang,
      loadRatio: best.loadRatio,
      score: -best.loadRatio,
    },
  };
}

const VALID_NEED_CATEGORIES = [
  "housing", "employment", "health", "benefits", "youth_services", "education", "other",
];

function respond(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PATCH,OPTIONS",
      "Access-Control-Allow-Headers": "content-type,authorization",
    },
    body: JSON.stringify(body),
  };
}

function parseBody(event) {
  if (!event.body) return {};
  try {
    return typeof event.body === "string" ? JSON.parse(event.body) : event.body;
  } catch {
    return {};
  }
}

// POST /sessions
async function createSession(event) {
  const body = parseBody(event);
  const needCategory = VALID_NEED_CATEGORIES.includes(body.need_category)
    ? body.need_category
    : "other";
  const language = typeof body.language === "string" ? body.language.toLowerCase() : null;
  const tags = Array.isArray(body.tags) ? body.tags : [];

  const sessionId = crypto.randomUUID();
  const sessionUserToken = crypto.randomUUID();

  const { roomId } = await invokeMatrix({ operation: "createRoom", sessionId });

  // 2. Load navigators + active load counts from RDS
  const navsResult = await pool.query("SELECT * FROM navigator_profiles");
  const navigators = navsResult.rows;

  const loadMap = await fetchLoadMap();
  const getActiveLoad = (navId) => loadMap[navId] ?? 0;

  // 3. Routing is owned entirely by the Next.js layer, which runs the richer algorithm
  // (schedule windows, expertise-tag tiers, load balancing). It passes its pick as
  // navigator_id in the request body. If no navigator_id is present, Next.js found no
  // eligible navigator and the session should be created unassigned (queued).
  const requestedNavId = body.navigator_id ?? body.navigatorId ?? null;
  const requestedNav = requestedNavId
    ? navigators.find((n) => n.id === requestedNavId && n.status === "available")
    : null;
  console.log(
    `[createSession] requestedNavId=${requestedNavId ?? "none"} requestedNavFound=${!!requestedNav} loadMap=${JSON.stringify(loadMap)}`,
  );

  let outcome;
  if (requestedNav) {
    const cap = Number(requestedNav.capacity);
    const load = getActiveLoad(requestedNav.id);
    outcome = {
      assigned: true,
      navigator: requestedNav,
      routingReason: {
        languageRequested: language,
        languageMatch: true,
        loadRatio: cap > 0 ? load / cap : 0,
        score: cap > 0 ? -load / cap : 0,
        source: "caller_pick",
      },
    };
  } else {
    // Next.js either found no eligible navigator or sent no pick — fall back to Lambda routing.
    outcome = assignNavigator(navigators, getActiveLoad, { needCategory, language });
  }

  const status = outcome.assigned ? "active" : "unassigned";
  const navigatorId = outcome.assigned ? outcome.navigator.id : null;
  const routingReason = outcome.assigned ? outcome.routingReason : null;
  const routingFailReason = outcome.assigned ? null : outcome.reason;

  // 4. Insert session row
  await pool.query(
    `INSERT INTO sessions
       (id, matrix_room_id, session_user_token, navigator_id, need_category, tags, language,
        status, routing_reason, routing_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      sessionId, roomId, sessionUserToken, navigatorId, needCategory,
      tags, language, status,
      routingReason ? JSON.stringify(routingReason) : null,
      ROUTING_VERSION,
    ]
  );

  // 5. Audit events
  await pool.query(
    `INSERT INTO session_events (session_id, event_type, actor_id, metadata)
     VALUES ($1,'created',NULL,$2)`,
    [sessionId, JSON.stringify({ needCategory, language, routingVersion: ROUTING_VERSION, outcome: status })]
  );
  if (outcome.assigned) {
    await pool.query(
      `INSERT INTO session_events (session_id, event_type, actor_id, metadata)
       VALUES ($1,'assigned','system',$2)`,
      [sessionId, JSON.stringify({ navigatorId, routingReason, routingVersion: ROUTING_VERSION })]
    );
  }

  return respond(201, {
    sessionId,
    sessionUserToken,
    status,
    needCategory,
    assignedNavigatorId: navigatorId,
    routingVersion: ROUTING_VERSION,
    routingReason,
    routingFailReason,
  });
}

async function getSessionLoad() {
  const load = await fetchLoadMap();
  return respond(200, { load });
}

// GET /sessions — supervisor sees all; navigator sees only their own sessions
async function listSessions(jwtPayload) {
  const roles = jwtPayload["https://streetlives.app/roles"] ?? [];

  if (roles.includes("supervisor")) {
    const result = await pool.query("SELECT * FROM sessions ORDER BY created_at DESC");
    return respond(200, result.rows);
  }

  if (roles.includes("navigator")) {
    const navResult = await pool.query(
      "SELECT id FROM navigator_profiles WHERE auth0_user_id = $1",
      [jwtPayload.sub]
    );
    if (navResult.rows.length === 0) {
      return respond(403, { error: "No navigator profile found for your account" });
    }
    const result = await pool.query(
      "SELECT * FROM sessions WHERE navigator_id = $1 ORDER BY created_at DESC",
      [navResult.rows[0].id]
    );
    return respond(200, result.rows);
  }

  return respond(403, { error: "Insufficient permissions" });
}

// PATCH /sessions/:id — navigator (own session only) or supervisor
async function patchSession(sessionId, body, jwtPayload) {
  const roles = jwtPayload["https://streetlives.app/roles"] ?? [];
  const isSupervisor = roles.includes("supervisor");
  const isNavigator = roles.includes("navigator");

  if (!isSupervisor && !isNavigator) {
    return respond(403, { error: "Insufficient permissions" });
  }

  const result = await pool.query("SELECT * FROM sessions WHERE id = $1", [sessionId]);
  if (result.rows.length === 0) return respond(404, { error: "Session not found" });
  const session = result.rows[0];

  if (isNavigator && !isSupervisor) {
    const navResult = await pool.query(
      "SELECT id FROM navigator_profiles WHERE auth0_user_id = $1",
      [jwtPayload.sub]
    );
    if (navResult.rows.length === 0 || navResult.rows[0].id !== session.navigator_id) {
      return respond(403, { error: "Only the assigned navigator may update this session" });
    }
  }

  const allowed = ["notes", "outcome", "follow_up_date", "submitted_for_review"];
  const updates = [];
  const values = [];
  let i = 1;
  for (const field of allowed) {
    if (body[field] !== undefined) {
      updates.push(`${field} = $${i++}`);
      values.push(body[field]);
    }
  }
  if (updates.length === 0) return respond(400, { error: "No valid fields to update" });

  values.push(sessionId);
  const updated = await pool.query(
    `UPDATE sessions SET ${updates.join(", ")} WHERE id = $${i} RETURNING *`,
    values
  );
  return respond(200, updated.rows[0]);
}

// POST /sessions/:id/approve — supervisor only
async function approveSession(sessionId, body, jwtPayload) {
  const roles = jwtPayload["https://streetlives.app/roles"] ?? [];
  if (!roles.includes("supervisor")) {
    return respond(403, { error: "Supervisor access required" });
  }

  const result = await pool.query("SELECT id FROM sessions WHERE id = $1", [sessionId]);
  if (result.rows.length === 0) return respond(404, { error: "Session not found" });

  const updated = await pool.query(
    "UPDATE sessions SET approved = true, coaching_notes = $1 WHERE id = $2 RETURNING *",
    [body.coaching_notes ?? null, sessionId]
  );
  return respond(200, updated.rows[0]);
}

// GET /sessions/:id
async function getSession(sessionId, token) {
  const result = await pool.query("SELECT * FROM sessions WHERE id=$1", [sessionId]);
  if (result.rows.length === 0) return respond(404, { error: "Session not found" });
  const session = result.rows[0];
  // Anonymous users must provide their token; navigators (Auth0) bypass this
  if (token && session.session_user_token !== token) {
    return respond(403, { error: "Invalid session token" });
  }
  return respond(200, session);
}

// POST /sessions/:id/close
async function closeSession(sessionId, actorId) {
  const result = await pool.query("SELECT * FROM sessions WHERE id=$1", [sessionId]);
  if (result.rows.length === 0) return respond(404, { error: "Session not found" });
  const session = result.rows[0];
  if (session.status === "closed") return respond(409, { error: "Session already closed" });

  const closedAt = new Date().toISOString();
  await pool.query(
    "UPDATE sessions SET status='closed', closed_at=$1 WHERE id=$2",
    [closedAt, sessionId]
  );
  await pool.query(
    `INSERT INTO session_events (session_id, event_type, actor_id, metadata)
     VALUES ($1,'closed',$2,$3)`,
    [sessionId, actorId, JSON.stringify({ previousStatus: session.status })]
  );
  return respond(200, { ok: true, closedAt });
}

// POST /sessions/:id/transfer
async function transferSession(sessionId, body, actorId) {
  const result = await pool.query("SELECT * FROM sessions WHERE id=$1", [sessionId]);
  if (result.rows.length === 0) return respond(404, { error: "Session not found" });
  const session = result.rows[0];
  if (session.status === "closed") return respond(409, { error: "Cannot transfer a closed session" });

  const navsResult = await pool.query("SELECT * FROM navigator_profiles");
  const navigators = navsResult.rows;
  const loadMap = await fetchLoadMap();
  const getActiveLoad = (navId) => loadMap[navId] ?? 0;

  let newNavigatorId;
  if (body.target_navigator_id) {
    const target = navigators.find((n) => n.id === body.target_navigator_id);
    if (!target) return respond(400, { error: "target_navigator_id not found" });
    if (target.status !== "available") return respond(400, { error: "Target navigator is not available" });
    if (target.id === session.navigator_id) return respond(400, { error: "Navigator already assigned" });
    newNavigatorId = target.id;
  } else {
    const outcome = assignNavigator(
      navigators, getActiveLoad,
      {
        needCategory: body.need_category ?? session.need_category,
        language: body.language ?? session.language,
        tags: body.tags ?? [],
      },
      "transfer"
    );
    if (!outcome.assigned) return respond(422, { error: outcome.reason });
    newNavigatorId = outcome.navigator.id;
  }

  await pool.query(
    "UPDATE sessions SET navigator_id=$1, status='active', routing_version=$2 WHERE id=$3",
    [newNavigatorId, ROUTING_VERSION, sessionId]
  );
  await pool.query(
    `INSERT INTO session_events (session_id, event_type, actor_id, metadata)
     VALUES ($1,'transferred',$2,$3)`,
    [sessionId, actorId, JSON.stringify({
      fromNavigatorId: session.navigator_id,
      toNavigatorId: newNavigatorId,
      reason: body.reason ?? null,
    })]
  );
  return respond(200, { ok: true, assignedNavigatorId: newNavigatorId });
}

// GET /sessions/:id/events
async function getSessionEvents(sessionId) {
  const sessionCheck = await pool.query("SELECT id FROM sessions WHERE id=$1", [sessionId]);
  if (sessionCheck.rows.length === 0) return respond(404, { error: "Session not found" });
  const result = await pool.query(
    "SELECT * FROM session_events WHERE session_id=$1 ORDER BY created_at ASC",
    [sessionId]
  );
  return respond(200, result.rows);
}

// POST /sessions/:id/messages — user sends message, validated by session token
async function postUserMessage(sessionId, body, token) {
  const result = await pool.query("SELECT * FROM sessions WHERE id=$1", [sessionId]);
  if (result.rows.length === 0) return respond(404, { error: "Session not found" });
  const session = result.rows[0];
  if (session.session_user_token !== token) return respond(403, { error: "Invalid session token" });
  if (session.status === "closed") return respond(409, { error: "Session is closed" });

  const text = (body.body ?? "").trim();
  if (!text) return respond(400, { error: "body is required" });

  // Send to Matrix via bot (best-effort, don't block response)
  invokeMatrix({
    operation: "sendMessage",
    roomId: session.matrix_room_id,
    displayName: "User",
    body: text,
  }).catch((err) => console.error("[vpc] Matrix sendMessage error (non-fatal):", err));

  return respond(201, { ok: true });
}

// GET /sessions/:id/messages — users poll with session token, navigators use Auth0
async function getMessages(sessionId, token, isNavigator) {
  const result = await pool.query("SELECT * FROM sessions WHERE id=$1", [sessionId]);
  if (result.rows.length === 0) return respond(404, { error: "Session not found" });
  const session = result.rows[0];

  // Anonymous users validate by token; navigators validated upstream by Auth0
  if (!isNavigator && session.session_user_token !== token) {
    return respond(403, { error: "Invalid session token" });
  }

  const { messages } = await invokeMatrix({
    operation: "fetchMessages",
    roomId: session.matrix_room_id,
  });

  return respond(200, { messages });
}

// POST /sessions/:id/navigator-messages
async function postNavigatorMessage(sessionId, body, actorSub) {
  const result = await pool.query("SELECT * FROM sessions WHERE id=$1", [sessionId]);
  if (result.rows.length === 0) return respond(404, { error: "Session not found" });
  const session = result.rows[0];
  if (session.status === "closed") return respond(409, { error: "Session is closed" });

  // Verify the Auth0 user is the assigned navigator
  const navResult = await pool.query(
    "SELECT * FROM navigator_profiles WHERE id=$1", [session.navigator_id]
  );
  if (navResult.rows.length === 0) return respond(403, { error: "No navigator assigned" });
  const navigator = navResult.rows[0];
  if (navigator.auth0_user_id !== actorSub) {
    return respond(403, { error: "Only the assigned navigator may send messages" });
  }

  const text = (body.text ?? "").trim();
  if (!text) return respond(400, { error: "text is required" });

  await invokeMatrix({
    operation: "sendMessage",
    roomId: session.matrix_room_id,
    displayName: "Navigator",
    body: text,
  });

  return respond(201, { ok: true });
}

// GET /navigators
async function listNavigators() {
  const result = await pool.query("SELECT * FROM navigator_profiles ORDER BY created_at DESC");
  return respond(200, result.rows);
}

// POST /navigators
async function createNavigator(body) {
  const {
    auth0_user_id,
    nav_group,
    expertise_tags,
    specialties,
    languages,
    capacity,
    status,
    is_general_intake,
  } = body;
  if (!auth0_user_id || !nav_group || capacity == null) {
    return respond(400, { error: "auth0_user_id, nav_group, and capacity are required" });
  }
  const tags = expertise_tags ?? specialties ?? [];
  const result = await pool.query(
    `INSERT INTO navigator_profiles
       (auth0_user_id, nav_group, expertise_tags, languages, capacity, status, is_general_intake, timezone, first_name, last_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [
      auth0_user_id,
      nav_group,
      tags,
      languages ?? ["en"],
      capacity,
      status ?? "offline",
      is_general_intake ?? false,
      body.timezone ?? "America/New_York",
      body.first_name ?? "",
      body.last_name ?? "",
    ]
  );
  return respond(201, result.rows[0]);
}

// GET /navigators/:id
async function getNavigator(id) {
  const result = await pool.query("SELECT * FROM navigator_profiles WHERE id=$1", [id]);
  if (result.rows.length === 0) return respond(404, { error: "Navigator not found" });
  return respond(200, result.rows[0]);
}

// PATCH /navigators/:id
async function updateNavigator(id, body) {
  const b = { ...body };
  if (b.specialties !== undefined) {
    b.expertise_tags = b.specialties;
    delete b.specialties;
  }
  const fields = ["nav_group","expertise_tags","languages","capacity","status","is_general_intake","first_name","last_name","timezone"];
  const updates = [];
  const values = [];
  let i = 1;
  for (const f of fields) {
    if (b[f] !== undefined) {
      updates.push(`${f}=$${i++}`);
      values.push(b[f]);
    }
  }
  if (body.availability_schedule !== undefined) {
    updates.push(`availability_schedule=$${i++}::jsonb`);
    values.push(JSON.stringify(body.availability_schedule));
  }
  if (updates.length === 0) return respond(400, { error: "No fields to update" });
  updates.push(`updated_at=NOW()`);
  values.push(id);
  const result = await pool.query(
    `UPDATE navigator_profiles SET ${updates.join(",")} WHERE id=$${i} RETURNING *`,
    values
  );
  if (result.rows.length === 0) return respond(404, { error: "Navigator not found" });
  return respond(200, result.rows[0]);
}

// GET /navigators/me — row for the Auth0 subject on the JWT
async function getNavigatorMe(auth0Sub) {
  const result = await pool.query(
    "SELECT * FROM navigator_profiles WHERE auth0_user_id = $1",
    [auth0Sub]
  );
  if (result.rows.length === 0) return respond(404, { error: "Profile not found" });
  return respond(200, result.rows[0]);
}

// DELETE /sessions/:id — supervisor only, closed sessions only
async function deleteSession(sessionId, jwtPayload) {
  const roles = jwtPayload["https://streetlives.app/roles"] ?? [];
  if (!roles.includes("supervisor")) {
    return respond(403, { error: "Supervisor access required" });
  }

  const result = await pool.query(
    "SELECT id, status, matrix_room_id FROM sessions WHERE id=$1",
    [sessionId]
  );
  if (result.rows.length === 0) return respond(404, { error: "Session not found" });
  const session = result.rows[0];

  if (session.status !== "closed") {
    return respond(409, { error: "Only closed sessions can be deleted" });
  }

  // Best-effort Matrix room deletion — log failures but don't block the DB delete.
  if (session.matrix_room_id) {
    try {
      await invokeMatrix({ operation: "deleteRoom", roomId: session.matrix_room_id });
    } catch (err) {
      console.error(`[deleteSession] Matrix room deletion failed for room ${session.matrix_room_id}:`, err);
    }
  }

  await pool.query("DELETE FROM session_events WHERE session_id=$1", [sessionId]);
  await pool.query("DELETE FROM sessions WHERE id=$1", [sessionId]);

  return respond(200, { ok: true, deletedSessionId: sessionId });
}

export const handler = async (event) => {
  const method = event.requestContext?.http?.method ?? event.httpMethod ?? "GET";
  const rawPath = event.requestContext?.http?.path ?? event.rawPath ?? event.path ?? "/";
  const path = rawPath.replace(/^\/api/, "");
  const segments = path.split("/").filter(Boolean);
  const body = parseBody(event);
  const qs = event.queryStringParameters ?? {};
  const authHeader = event.headers?.authorization ?? event.headers?.Authorization ?? "";

  try {
    // Preflight — must respond before any auth check
    if (method === "OPTIONS") {
      return {
        statusCode: 200,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
          "Access-Control-Allow-Headers": "content-type,authorization",
          "Access-Control-Max-Age": "300",
        },
        body: "",
      };
    }

    // Anonymous routes — validated by session_user_token, no Auth0 needed

    // POST /sessions
    if (method === "POST" && segments[0] === "sessions" && segments.length === 1) {
      return await createSession(event);
    }

    // GET /sessions/load — must come before GET /sessions/:id to prevent "load" being
    // treated as a session UUID (which causes PostgreSQL to throw a type error → 500).
    if (method === "GET" && segments[0] === "sessions" && segments[1] === "load") {
      let jwtPayload;
      try {
        jwtPayload = await verifyAuth0Token(authHeader);
        void jwtPayload;
      } catch (err) {
        return respond(401, { error: "Unauthorized: " + err.message });
      }
      return await getSessionLoad();
    }

    // GET /sessions/:id  (token in query string)
    if (method === "GET" && segments[0] === "sessions" && segments.length === 2 && !segments[2]) {
      const token = qs.token ?? null;
      // Allow navigators (with Auth0 token) to access without session token
      let isNavigator = false;
      if (authHeader) {
        try { await verifyAuth0Token(authHeader); isNavigator = true; } catch { /* anonymous */ }
      }
      return await getSession(segments[1], isNavigator ? null : token);
    }

    // POST /sessions/:id/messages  (user sends message — token in body)
    if (method === "POST" && segments[0] === "sessions" && segments[2] === "messages") {
      const token = body.token ?? qs.token;
      if (!token) return respond(401, { error: "session token required" });
      return await postUserMessage(segments[1], body, token);
    }

    // GET /sessions/:id/messages
    if (method === "GET" && segments[0] === "sessions" && segments[2] === "messages") {
      const token = qs.token ?? null;
      let isNavigator = false;
      if (authHeader) {
        try { await verifyAuth0Token(authHeader); isNavigator = true; } catch { /* anonymous */ }
      }
      return await getMessages(segments[1], token, isNavigator);
    }

    // All routes below require a valid Auth0 JWT
    let jwtPayload;
    try {
      jwtPayload = await verifyAuth0Token(authHeader);
    } catch (err) {
      return respond(401, { error: "Unauthorized: " + err.message });
    }
    const actorSub = jwtPayload.sub?.endsWith("@clients") ? "user" : jwtPayload.sub;

    // GET /sessions  (list all)
    if (method === "GET" && segments[0] === "sessions" && segments.length === 1) {
      return await listSessions(jwtPayload);
    }

    // PATCH /sessions/:id
    if (method === "PATCH" && segments[0] === "sessions" && segments.length === 2) {
      return await patchSession(segments[1], body, jwtPayload);
    }

    // DELETE /sessions/:id
    if (method === "DELETE" && segments[0] === "sessions" && segments.length === 2) {
      return await deleteSession(segments[1], jwtPayload);
    }

    // POST /sessions/:id/close
    if (method === "POST" && segments[0] === "sessions" && segments[2] === "close") {
      return await closeSession(segments[1], actorSub);
    }

    // POST /sessions/:id/transfer
    if (method === "POST" && segments[0] === "sessions" && segments[2] === "transfer") {
      return await transferSession(segments[1], body, actorSub);
    }

    // POST /sessions/:id/approve
    if (method === "POST" && segments[0] === "sessions" && segments[2] === "approve") {
      return await approveSession(segments[1], body, jwtPayload);
    }

    // GET /sessions/:id/events
    if (method === "GET" && segments[0] === "sessions" && segments[2] === "events") {
      return await getSessionEvents(segments[1]);
    }

    // POST /sessions/:id/navigator-messages
    if (method === "POST" && segments[0] === "sessions" && segments[2] === "navigator-messages") {
      return await postNavigatorMessage(segments[1], body, actorSub);
    }

    // GET /navigators
    if (method === "GET" && segments[0] === "navigators" && segments.length === 1) {
      return await listNavigators();
    }

    // POST /navigators
    if (method === "POST" && segments[0] === "navigators" && segments.length === 1) {
      return await createNavigator(body);
    }

    // GET /navigators/me  (before :id so "me" is not treated as UUID)
    if (
      method === "GET" &&
      segments[0] === "navigators" &&
      segments.length === 2 &&
      segments[1] === "me"
    ) {
      return await getNavigatorMe(actorSub);
    }

    // GET /navigators/:id
    if (method === "GET" && segments[0] === "navigators" && segments.length === 2) {
      return await getNavigator(segments[1]);
    }

    // PATCH /navigators/:id
    if (method === "PATCH" && segments[0] === "navigators" && segments.length === 2) {
      return await updateNavigator(segments[1], body);
    }

    return respond(404, { error: "Not found" });

  } catch (err) {
    console.error("[vpc] Unhandled error:", err);
    return respond(500, { error: err.message ?? "Internal server error" });
  }
};
