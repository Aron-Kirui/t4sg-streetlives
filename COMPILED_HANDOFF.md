# StreetLives — Compiled Handoff Documentation

> **Compiled:** May 2026  
> **Project:** Tech for Social Good (T4SG) — StreetLives  
> **Sources:** HANDOFF.md · KIRUI HANDOFF.md · AUTH_README.md · RBAC_README.md · DASHBOARDS.md · DOCUMENTATION_KA.md · DELIVERABLE_7.md · DELIVERABLE_8.md · matrix-chat/README.md · matrix-chat/backend/docs/api.md

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [System Architecture](#2-system-architecture)
3. [AWS Infrastructure](#3-aws-infrastructure)
4. [Database](#4-database)
5. [Authentication & RBAC](#5-authentication--rbac)
6. [Backend Lambdas](#6-backend-lambdas)
7. [Next.js API Layer](#7-nextjs-api-layer)
8. [Matrix Chat](#8-matrix-chat)
9. [Frontend File Structure](#9-frontend-file-structure)
10. [Setup & Local Development](#10-setup--local-development)
11. [Navigator & Supervisor Dashboards](#11-navigator--supervisor-dashboards)
12. [Usage Guide](#12-usage-guide)
13. [Session Management — Deliverable Notes](#13-session-management--deliverable-notes)
14. [Known Bugs & Issues](#14-known-bugs--issues)
15. [Performance & Limitations](#15-performance--limitations)
16. [Next Steps / Roadmap](#16-next-steps--roadmap)
17. [Developer Tips & Gotchas](#17-developer-tips--gotchas)
18. [Backend API Reference](#18-backend-api-reference)

---

## 1. Project Overview

*Source: HANDOFF.md*

StreetLives is a web platform that connects unhoused individuals with human navigators who can help them access social services (housing, food, legal aid, healthcare, etc.).

### Problem it solves

Unhoused individuals often struggle to identify and access services. StreetLives provides a chat-based intake flow where a user describes their need, gets matched to a trained navigator, and receives real-time help. Supervisors oversee navigators, review closed sessions, and manage quality.

### Key features

- Anonymous chat for users (no login required) — starts a session, matched to a navigator automatically
- Navigator dashboard — view active/unassigned/closed sessions, chat with users, transfer sessions, submit for review
- Supervisor dashboard — review submissions, approve or return sessions with coaching notes, monitor navigator capacity
- Role-based access — Auth0 roles (`navigator`, `supervisor`) control which dashboard is accessible
- Session timeline — every state change (assigned, transferred, closed) is logged as an event
- Overdue detection — flags sessions where a navigator hasn't responded in 24+ hours

### Tech stack

| Layer | Technology |
|---|---|
| Framework | Next.js 15 (App Router) |
| Language | TypeScript |
| UI | React 19 + Tailwind CSS |
| State | Zustand (localStorage persistence) |
| Auth | Auth0 (`@auth0/nextjs-auth0` v4) |
| Backend | AWS Lambda (REST API, accessed via proxy) |
| Chat | Matrix (hosted externally, accessed via Lambda) |
| Icons | Lucide React |
| Toasts | Sonner |
| Date formatting | Moment.js |
| Animations | Framer Motion |

---

## 2. System Architecture

*Source: HANDOFF.md · KIRUI HANDOFF.md · DOCUMENTATION_KA.md*

### High-level overview

```
Browser (anonymous user)
  └─ Next.js App (Vercel / local)
       ├─ /api/guest/*         ← no auth, session token-based
       └─ /api/*               ← Auth0 JWT required
            └─ API Gateway (HTTP API)
                 └─ streetlives-vpc Lambda (private subnet, VPC)
                      ├─ RDS PostgreSQL (private subnet)
                      └─ streetlives-matrix Lambda (outside VPC)
                           └─ Matrix Homeserver (external)
```

All browser traffic hits Next.js API routes. These are the only components that hold Auth0 credentials. The Lambda functions never see the browser directly.

### API proxy pattern

The frontend **never calls Lambda directly** from client components. All calls go through Next.js API routes in `src/app/api/`. Those routes use `lambdaFetch()` (server-only) which:

1. Gets the Auth0 access token for the current user
2. Injects `Authorization: Bearer {token}` into the request
3. Forwards the request to `NEXT_PUBLIC_API_URL` (Lambda)

This keeps credentials server-side and gives a single point to add logging, retries, or caching.

### Auth & role enforcement

Auth0 stores roles in a custom claim: `https://streetlives.app/roles`. The Next.js middleware (`src/middleware.ts`) reads this claim on every request to `/dashboard/*` and returns 403 if the role doesn't match the route.

Roles:
- `navigator` → can access `/dashboard/navigator`
- `supervisor` → can access `/dashboard/supervisor`
- No special role → `/dashboard/user` (end-users, includes logged-out anonymous sessions)

### Real-time updates

There is no WebSocket. Two polling mechanisms keep data fresh:

1. **`DashboardPoller`** — calls `router.refresh()` every 30 seconds to re-run server components and pull fresh session lists.
2. **Message polling** — when a navigator or supervisor opens a session detail page, the browser calls `/api/sessions/{id}/messages` every 7 seconds to check for new chat messages. This is how the chat feels "live" — there is no WebSocket. The interval is cleared automatically once the session is closed or the user navigates away, so only the currently open session page polls.
3. **Note:** sent messages appear instantly for the sender via optimistic UI, but the other person only sees them when their next poll fires — meaning up to 7 seconds of lag before a new message appears on the recipient's screen.

### Chat (Matrix)

User ↔ Navigator messages are stored in a Matrix room managed by the Lambda backend. The frontend never talks to Matrix directly — it calls `/api/sessions/{id}/messages` which proxies to Lambda which talks to Matrix.

Message bodies from Matrix are formatted as `"Role: message text"` (e.g., `"User: Hello"`, `"Navigator: Hi there"`). The frontend parses this with `parseMessage()`.

### Navigator matching

When a user starts a chat, the Lambda backend runs a matching algorithm to assign a navigator. The algorithm considers navigator availability, capacity, language, and expertise. **Known issue:** the algorithm can assign sessions beyond a navigator's declared capacity.

---

## 3. AWS Infrastructure

*Source: KIRUI HANDOFF.md*

Everything was provisioned in the client's AWS account. All resources are in `us-east-1`.

### VPC & Networking

- Custom VPC with **public and private subnets** across two AZs (for RDS multi-AZ requirement).
- **Public subnet:** EC2 bastion host (for terminal access to the private RDS instance during migrations).
- **Private subnets:** RDS PostgreSQL, `streetlives-vpc` Lambda.
- **VPC Endpoint** (Lambda ↔ Lambda): allows the VPC Lambda to invoke `streetlives-matrix` without going to the public internet. Without this, Lambda-to-Lambda calls from inside a private subnet silently fail.
- **Security groups:** RDS allows inbound 5432 only from the VPC Lambda's SG and the EC2 bastion's SG.

### Lambda Functions

| Function | Location | Purpose |
|---|---|---|
| `streetlives-vpc` | Inside VPC (private subnet) | Main API — reads/writes RDS, invokes Matrix Lambda |
| `streetlives-matrix` | Outside VPC | All Matrix homeserver operations (create room, send, fetch, delete) |

The VPC Lambda cannot reach the public internet since we don't have NAT gateway, so **the Auth0 JWKS is stored as a Lambda environment variable** (`AUTH0_JWKS`) rather than fetched at runtime.

### API Gateway

HTTP API fronts `streetlives-vpc`. All routes are `/{proxy+}`. CORS is handled in the Lambda response headers, not in API Gateway itself.

### EC2 Bastion

A small EC2 instance in the public subnet. Used only for:
- Running `psql` against RDS to apply migrations
- Debugging RDS directly

**If this instance is stopped/terminated, you lose the only direct path into RDS.**

---

## 4. Database

*Source: KIRUI HANDOFF.md · DELIVERABLE_8.md*

**Engine:** PostgreSQL on RDS (private subnet, SSL required)  
**Source of truth for schema:** [`migration.sql`](migration.sql)

### Tables

#### `navigator_profiles`

Stores one row per navigator. The `auth0_user_id` column is the link between Auth0 identity and the database row.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID | PK |
| `auth0_user_id` | VARCHAR UNIQUE | Auth0 `sub` claim |
| `first_name` / `last_name` | VARCHAR | Set during onboarding |
| `nav_group` | VARCHAR | Organization affiliation |
| `capacity` | INT | Max concurrent sessions |
| `status` | VARCHAR | `available`, `away`, `offline` |
| `languages` | TEXT[] | e.g. `{english, spanish}` |
| `expertise_tags` | TEXT[] | Matches `need_category` values |
| `availability_schedule` | JSONB | `{ "Mon": { "start": "09:00", "end": "17:00" }, ... }` |
| `is_general_intake` | BOOLEAN | Whether to include in general routing |

#### `sessions`

One row per chat session. Anonymous users are identified only by `session_user_token` (stored in their browser localStorage), never by a user ID.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID | PK |
| `matrix_room_id` | VARCHAR | Matrix room created at session start |
| `session_user_token` | VARCHAR | Random UUID given to the user; required for all guest API calls |
| `navigator_id` | UUID | FK → `navigator_profiles.id`; NULL if unassigned |
| `need_category` | VARCHAR | `housing`, `employment`, `health`, `benefits`, `youth_services`, `education`, `other` |
| `language` | VARCHAR | ISO 639-1 code (e.g. `es`) |
| `status` | VARCHAR | `unassigned`, `active`, `transferred`, `closed` |
| `routing_reason` | JSONB | Algorithm output at time of routing |
| `notes` | TEXT | Filled by navigator at close |
| `outcome` | TEXT[] | Filled by navigator at close |
| `follow_up_date` | DATE | Filled by navigator at close |
| `submitted_for_review` | BOOLEAN | Navigator marks session ready for supervisor |
| `approved` | BOOLEAN | Supervisor approval |
| `coaching_notes` | TEXT | Supervisor feedback |

#### `session_events`

Immutable audit log. Every state change writes a new row — never updates.

| `event_type` | Triggered by |
|---|---|
| `created` | Session starts |
| `assigned` | Routing algorithm or supervisor assigns navigator |
| `transferred` | Navigator or supervisor transfers session |
| `closed` | Navigator closes session |

### Running Migrations

There is no direct public access to RDS — you must go through the EC2 bastion first.

**Step 1 — SSH into the bastion:**
```bash
ssh -i "/path/to/streetlives-bastion-key.pem" ec2-user@<BASTION_PUBLIC_IP>
```

**Step 2 — Connect to RDS from inside the bastion:**
```bash
psql -h <RDS_ENDPOINT> -U postgres -d streetlives
# Enter the DB password when prompted
# RDS endpoint and DB password will be shared separately
```

**Step 3 — Make schema changes as needed:**
```sql
-- The schema is already live in RDS. Run incremental ALTER TABLE statements for any future changes.
-- Do NOT re-run migration.sql — it will fail on already-existing tables.
```

> `migration.sql` in the repo is for reference only — it documents the full schema as it currently stands.

**What needs to be transferred to the StreetLives team:**
All these will be shared securely.
- `streetlives-bastion-key.pem`
- DB password
- Bastion public IP — an Elastic IP has been assigned, so the IP is static and will not change on restart.

---

## 5. Authentication & RBAC

*Source: AUTH_README.md · RBAC_README.md · KIRUI HANDOFF.md*

### Overview

Role-Based Access Control (RBAC) is implemented using Auth0 as the identity provider and Next.js middleware for route enforcement. Roles are attached to users in Auth0 and passed through the session as a custom claim.

### Roles

| Role | Dashboard URL | Access |
|---|---|---|
| `user` | `/dashboard/user` | Open — no auth required |
| `navigator` | `/dashboard/navigator` | Auth required + `navigator` role |
| `supervisor` | `/dashboard/supervisor` | Auth required + `supervisor` role |

### Current State — Tenant Transfer Required

The Auth0 tenant is **fully configured and working** but is currently owned by the T4SG SWE's personal account. Before go-live, ownership must be transferred to a StreetLives/YourPeer account.

**To transfer tenant ownership:**
1. Have the StreetLives team create (or provide) an Auth0 account under their org email.
2. In the Auth0 dashboard → Tenant Settings → Tenant Members, add that account as an **Admin**.
3. Log in as the new admin and go to Tenant Settings → Danger Zone → Transfer Ownership.
4. The original owner can then be removed or kept as a member.

Everything below is already in place — no recreation needed, just the ownership transfer.

### What Is Already Configured

1. **Regular Web Application** — callback and logout URLs are set for the current deployment domain.

2. **Roles** under User Management → Roles:
   - `navigator` → Dashboard link points to `/dashboard/navigator`
   - `supervisor` → Dashboard link points to `/dashboard/supervisor`
   - Logged in but no role assigned → Dashboard link points to `/dashboard/user`
   - **Completely unauthenticated visitors** → No Dashboard link shown; they access the app via the home page and `/chat` directly.

3. **Post-Login Action** (deployed to the Login flow — do not remove):

```js
exports.onExecutePostLogin = async (event, api) => {
  const roles = event.authorization?.roles ?? [];
  api.idToken.setCustomClaim("https://streetlives.app/roles", roles);
  api.accessToken.setCustomClaim("https://streetlives.app/roles", roles);
};
```

This injects roles into both the ID token (for the Next.js session) and the access token (for the Lambda to read). Removing or disabling this Action will break all role-based routing.

4. **Auth0 API** — already created with audience `https://api.streetlives.app`. This value is set in both the Next.js `.env` (`AUTH0_AUDIENCE`) and the Lambda environment (`AUTH0_AUDIENCE`). Do not change the audience string without updating both.

### How RBAC is Enforced

| Layer | Mechanism |
|---|---|
| Next.js middleware (`src/middleware.ts`) | Reads roles from Auth0 session cookie; returns 403 if role doesn't match route |
| Lambda (`backend/lambda/index.mjs`) | Reads `https://streetlives.app/roles` from the JWT access token; `GET /sessions` returns all for supervisor, own for navigator |

**Enforcement logic:**
- Unauthenticated users hitting a protected route are redirected to `/auth/login` with a `returnTo` parameter so they land on the correct page after signing in.
- Authenticated users without the required role receive a `403 Forbidden` response.
- `/chat` and `/dashboard/user` are explicitly left public — no auth required.

### Navbar State

| State | Shown |
|---|---|
| Not logged in | Dashboard (user), Sign In, Sign Up |
| Logged in as user | Dashboard → `/dashboard/user`, Log out |
| Logged in as navigator | Dashboard → `/dashboard/navigator`, Log out |
| Logged in as supervisor | Dashboard → `/dashboard/supervisor`, Log out |

### Key Files

| File | What it does |
|---|---|
| `src/lib/auth0.ts` | Auth0 client config; `beforeSessionSaved` hook preserves the roles claim in the session cookie |
| `src/middleware.ts` | Route guard for `/dashboard/navigator/*` and `/dashboard/supervisor/*` |
| `src/app/auth/` | Sign-in and sign-up pages (both redirect to Auth0 hosted login) |
| `src/components/Navbar.tsx` | Shows correct dashboard link based on role |

### Assigning Roles in Auth0

Roles must be assigned to users in the Auth0 dashboard under **User Management → Users → Roles**. The role names must match exactly:

- `navigator`
- `supervisor`

Users with no assigned role are treated as regular users and routed to `/dashboard/user`.

### What Was Removed and Why

The `RoleSwitcher` component (previously rendered globally in `layout.tsx`) allowed anyone — including unauthenticated users — to switch between User, Navigator, and Supervisor views via a footer bar. This completely bypassed RBAC.

### Auth0 Setup (for a fresh tenant)

1. Create a Regular Web Application in Auth0. Set callback URL to `http://localhost:3000/auth/callback` and logout URL to `http://localhost:3000`.
2. Create roles `navigator` and `supervisor` under User Management → Roles and assign them to users.
3. Create a post-login Action with the code above and add it to the Login flow.
4. Add to `.env.local`:

```env
AUTH0_DOMAIN='your-tenant.us.auth0.com'
AUTH0_CLIENT_ID='your-client-id'
AUTH0_CLIENT_SECRET='your-client-secret'
AUTH0_SECRET='your-32-byte-hex-secret'   # openssl rand -hex 32
APP_BASE_URL='http://localhost:3000'
```

---

## 6. Backend Lambdas

*Source: KIRUI HANDOFF.md*

### `streetlives-vpc` — `backend/lambda/index.mjs`

The main API handler. Lives in the private subnet with access to RDS.

#### Endpoints

**Guest (no auth — validated by `session_user_token`):**

| Method | Path | What it does |
|---|---|---|
| `POST` | `/sessions` | Create session + Matrix room, run routing algorithm, insert to RDS |
| `GET` | `/sessions/:id` | Get session status (token required as query param) |
| `POST` | `/sessions/:id/messages` | User sends a message to Matrix room |
| `GET` | `/sessions/:id/messages` | Poll Matrix room messages |

**Navigator / Supervisor (Auth0 JWT required in `Authorization: Bearer` header):**

| Method | Path | What it does |
|---|---|---|
| `GET` | `/sessions` | List sessions (supervisor = all; navigator = their own) |
| `PATCH` | `/sessions/:id` | Update notes, outcome, submitted_for_review |
| `POST` | `/sessions/:id/close` | Close session, set closed_at |
| `POST` | `/sessions/:id/transfer` | Transfer session to another navigator |
| `POST` | `/sessions/:id/approve` | Supervisor only; save coaching_notes, set approved=true |
| `GET` | `/sessions/:id/events` | Fetch session audit log |
| `POST` | `/sessions/:id/navigator-messages` | Navigator sends a message |
| `GET` | `/navigators` | List all navigator profiles |
| `POST` | `/navigators` | Create a navigator profile |
| `GET` | `/navigators/:id` | Get a single navigator profile |
| `PATCH` | `/navigators/:id` | Update a navigator profile |

#### JWT Validation

The VPC Lambda has **no internet access**, so it cannot fetch Auth0's JWKS endpoint at runtime. The JWKS is already fetched and stored as the `AUTH0_JWKS` Lambda environment variable. The Lambda parses it at cold-start and caches it for the lifetime of the container.

**If Auth0 rotates its signing keys, the Lambda will reject all tokens until `AUTH0_JWKS` is updated.** To refresh it, fetch `https://<AUTH0_DOMAIN>/.well-known/jwks.json`, paste the full JSON into the `AUTH0_JWKS` env var in the Lambda console, and deploy.

#### Routing Algorithm (Lambda side)

When a session is created, `assignNavigator()` runs:

1. Filter to navigators with `status = available` and `capacity > 0`.
2. If a language was requested, filter to navigators who speak it. If none do, return `assigned: false`.
3. Prefer navigators under their capacity limit. If everyone is over capacity, route anyway.
4. Rank remaining candidates by load ratio (`active_sessions / capacity`), break ties randomly.
5. Pick the lowest-ratio navigator.

---

### `streetlives-matrix` — `backend/matrix-lambda/index.mjs`

Handles all Matrix homeserver calls. Invoked by the VPC Lambda via `InvokeCommand` (not via HTTP).

| Operation | What it does |
|---|---|
| `createRoom` | Creates a private Matrix room for the session; returns `{ roomId }` |
| `sendMessage` | Sends a message to a room on behalf of the bot |
| `fetchMessages` | Fetches up to 200 messages from a room |
| `deleteRoom` | Purges the room via Synapse Admin API; falls back to bot leaving the room |

The Matrix bot token is cached in module-level memory. On `M_UNKNOWN_TOKEN`, it re-authenticates automatically and retries once.

### Deploying Lambda

Each Lambda is deployed as a `.zip` from its directory:

```bash
# VPC Lambda
cd backend/lambda
zip -r function.zip .

# Matrix Lambda
cd backend/matrix-lambda
zip -r function.zip .
```

### Lambda Environment Variables

**`streetlives-vpc` — required keys:**

```env
DB_HOST=
DB_NAME=
DB_USER=
DB_PASSWORD=
DB_PORT=
AUTH0_DOMAIN=
AUTH0_AUDIENCE=
AUTH0_JWKS=       # full JWKS JSON — see JWT Validation section above for how to refresh
MATRIX_LAMBDA_NAME=streetlives-matrix
```

> `AWS_REGION` is set automatically by the Lambda runtime — no need to configure it.

**`streetlives-matrix` — required keys:**

```env
MATRIX_BASE_URL=
MATRIX_BOT_USER_ID=
MATRIX_BOT_PASSWORD=
```

---

## 7. Next.js API Layer

*Source: KIRUI HANDOFF.md*

The Next.js API routes act as a proxy between the browser and the Lambda. They handle three concerns:
- Attaching the Auth0 access token (authenticated routes)
- Hiding Lambda credentials from the client
- Providing guest routes that use session tokens instead of auth

### Authenticated Proxy Routes (`src/app/api/`)

These all forward to Lambda with `Authorization: Bearer <Auth0 access token>`.

| File | Forwards to |
|---|---|
| `api/navigators/me/route.ts` | `GET /navigators` + filter by `auth0_user_id`; `PATCH /navigators/:id` |
| `api/navigators/route.ts` | `GET /navigators` |
| `api/sessions/[sessionId]/route.ts` | `GET`, `PATCH /sessions/:id` |
| `api/sessions/[sessionId]/transfer/route.ts` | `POST /sessions/:id/transfer` |

### Guest API Routes (`src/app/api/guest/`)

No auth. The session token from localStorage is passed as a query param or in the request body. The Lambda validates it against the `session_user_token` column.

| File | Forwards to |
|---|---|
| `api/guest/sessions/route.ts` | `POST /sessions` (create) |
| `api/guest/sessions/[sessionId]/route.ts` | `GET /sessions/:id` |
| `api/guest/sessions/[sessionId]/messages/route.ts` | `GET` / `POST /sessions/:id/messages` |
| `api/guest/sessions/[sessionId]/request-transfer/route.ts` | Records transfer request in-process |
| `api/guest/navigators/[id]/route.ts` | `GET /navigators/:id` (returns navigator name only) |

### Client-Side Routing Mirror

`src/lib/routing.ts` is a TypeScript port of the Lambda routing logic. It is used by the guest `POST /sessions` API route to run routing before calling the Lambda, and by the Matrix chat integration for scheduling decisions. Keep it in sync with the Lambda's `assignNavigator()` function — they can drift.

---

## 8. Matrix Chat

*Source: DOCUMENTATION_KA.md · matrix-chat/README.md*

### Overview

When a guest starts a chat, three things happen in sequence: a **chat session** is created in the backend, the **routing algorithm** picks the best available navigator, and a private **Matrix room** is created to carry the messages between the guest and navigator. Matrix is a real-time messaging protocol — think of it as the infrastructure that moves messages back and forth, similar to how email servers move email.

The application is the source of truth for all session and navigator data. Matrix is only used to carry the actual chat messages — if Matrix goes down, sessions and routing still work; only live messaging is affected.

### Matrix Service Account Bot

A dedicated "bot" account logs into the Matrix homeserver on behalf of the whole application. This means navigators don't need to be registered as Matrix users in the backend — the bot handles all room creation, messaging, and membership changes for every session.

**Files:**

| File | Role |
|------|------|
| `matrix-chat/backend/src/services/matrixAuth.ts` | Handles bot login, keeps the session alive, and automatically refreshes credentials before they expire |
| `matrix-chat/backend/src/services/matrixService.ts` | All Matrix actions: `createRoom`, `sendMessage`, `fetchRoomMessages`, `inviteToRoom`, `kickFromRoom` |
| `matrix-chat/backend/src/server.ts` | Starts the bot session when the server boots |

**How it works:**

When the server starts, the bot logs into Matrix using a username and password stored in the environment config. The login token is saved to a local file (`.matrix-session.json`) so the bot doesn't need to log in again after a restart. The bot automatically refreshes its token before it expires, and if a token is ever rejected mid-request, it re-logs in and retries transparently.

Every time a guest session is assigned to a navigator, the bot invites that navigator's Matrix account to the private room. On transfer, it removes the old navigator and invites the new one. If any of these Matrix calls fail (e.g., the homeserver is temporarily unreachable), the session assignment still goes through — Matrix failures are treated as non-fatal.

**Key requirement:** Each navigator needs a pre-registered account on the Matrix homeserver. Their Matrix user ID (formatted like `@name:matrix.org`) is stored on their navigator profile and used for room invites.

### How Messaging Works

Every message — whether from the guest or navigator — is stored in the application and also sent to the Matrix room. Guest messages get a `[Guest]:` prefix in Matrix; navigator messages get a `[Name (Navigator)]:` prefix. This way, anyone viewing the Matrix room directly (e.g., via the Element app) sees clearly labeled messages. The app periodically checks the Matrix room for any new messages (throttled to once every 5 seconds per session) and imports them if they came from outside the dashboard.

### Encryption

**Transport encryption (in place):** All messages are protected in transit by HTTPS/TLS. Every request between the guest's browser, the Next.js app, the Lambda backend, and the Matrix homeserver travels over an encrypted connection.

**End-to-end encryption (intentionally not enabled):** Matrix supports E2E encryption, but it is deliberately not used. Supervisors need to be able to read message history for oversight, coaching, and quality assurance. E2E encryption would make messages unreadable to anyone except the two participants, which is incompatible with that requirement. Disabling it is not a gap — it is a product decision.

**Who can read messages:** The bot account, any Matrix homeserver admin, navigators assigned to the room, and supervisors via the dashboard. Guests can only read their own session's messages.

### Routing Algorithm (Full Detail)

*Source: DOCUMENTATION_KA.md*

The algorithm filters and ranks navigators in this order:

1. **Availability check** — only navigators with status `available`, a configured schedule, and remaining session capacity are considered. A navigator with no schedule set is treated as having an incomplete profile and is skipped.

2. **PRIMARY tier** — if the guest has a specific need (e.g., housing, health), the algorithm looks for a navigator whose listed areas of expertise include that category. If a language was also requested, it further narrows to those who speak it. The least-busy matching navigator is assigned.

3. **FALLBACK tier** — if no specialist is available for the guest's need, any available navigator is eligible. Language is still enforced here as a hard requirement: if no one speaks the requested language, the session goes into a queue (`unassigned`) rather than being assigned to someone who can't communicate with the guest.

**Load balancing:** Among any group of equally eligible navigators, the one with the lowest ratio of active sessions to their capacity ceiling is chosen. This distributes sessions evenly without any navigator being overloaded.

**What happens when no navigator is available:** The session is created with status `unassigned` and enters a queue. The queue processor automatically retries assignment whenever a navigator's availability changes.

**Two-layer architecture:**

Routing runs in two stages to work around infrastructure constraints:

1. **Next.js layer** — runs the full algorithm before calling the Lambda. Fetches the navigator list and live active-session counts (`GET /sessions/load`) in parallel, then picks the best navigator. Sends the chosen navigator's ID to the Lambda as `navigator_id` in the request body.

2. **Lambda layer** — if a valid `navigator_id` is provided, the Lambda uses it directly (no independent routing). If Next.js sends no pick (no eligible navigator found), the Lambda falls back to its own simpler load-based algorithm before creating the session as `unassigned`.

### Queue Processor

**File:** `matrix-chat/backend/src/services/queueProcessor.ts`

Automatically picks up queued sessions and assigns them as soon as a navigator becomes available — no manual intervention needed.

**When it runs:**
- When a session is closed (freeing up one of the navigator's slots)
- When a navigator updates their profile (e.g., changing their status to `available` or increasing their capacity)

Queued sessions are processed oldest-first so guests who have been waiting longest are served first.

### Transfer Requests

**Files:**

| File | Role |
|------|------|
| `matrix-chat/backend/src/routes/sessions.ts` | `POST /api/sessions/:id/transfer` — performs the transfer |
| `src/app/api/guest/sessions/[sessionId]/request-transfer/route.ts` | Guest-side signal |
| `src/lib/transferRequestStore.ts` | Tracks which sessions have a pending guest transfer request |

There are two ways to transfer a session:
- **Manual transfer** — a specific navigator is chosen. The system checks they are available and not already on this session, then moves the session to them.
- **Auto transfer** — no target is specified; the routing algorithm reruns and picks the best available navigator. In this mode, all available navigators are eligible (not just specialists), which gives more options than the initial assignment.

When a transfer completes: the departing navigator is removed from the Matrix room, the new navigator is invited, and a `transferred` event is written to the session's audit log.

**Guest transfer request:** A guest can request a new navigator from the chat UI. This does not automatically transfer the session — it sets a flag (`transfer_requested`) that the navigator or supervisor dashboard can display. A human still makes the final decision to transfer.

**Transfer State Store:** `src/lib/transferRequestStore.ts` is an **in-process, in-memory** store (`globalThis`) that tracks which sessions have a pending transfer request from the user side. **This state is lost on server restart and not shared across multiple Next.js instances.** It is purely cosmetic (the navigator sees a badge), not functionally blocking.

### Matrix Chat Prototype (matrix-chat/)

The `matrix-chat/` directory contains a standalone prototype that was the original implementation before the main Next.js app was built. It uses:
- **Frontend** — React + Vite + TypeScript, served on port 5173 during development
- **Backend** — Express + TypeScript (ESM), served on port 3000
- **Matrix** — A single service-account bot is the sole Matrix actor; guests never receive Matrix credentials

**Limitations of the prototype:**
- **In-memory storage** — sessions, messages, notes, and referrals are lost when the backend restarts.
- **No authentication** — the Navigator dashboard at `/navigator` is open to anyone with the URL.
- **No end-to-end encryption** — messages are visible to the Matrix homeserver.
- **Polling only** — the guest UI polls every 3 seconds instead of using Matrix sync or WebSockets.

---

## 9. Frontend File Structure

*Source: HANDOFF.md*

```
t4sg-streetlives/
├── src/
│   ├── app/
│   │   ├── api/                          # Next.js API routes (Lambda proxy)
│   │   │   ├── navigators/
│   │   │   │   ├── route.ts              # GET/POST /navigators
│   │   │   │   ├── [id]/route.ts         # GET/PUT /navigators/{id}
│   │   │   │   └── me/route.ts           # GET/PUT current user's profile
│   │   │   └── sessions/
│   │   │       ├── route.ts              # GET /sessions
│   │   │       └── [sessionId]/
│   │   │           ├── route.ts          # GET/PATCH/DELETE session
│   │   │           ├── messages/         # GET Matrix messages
│   │   │           ├── events/           # GET/POST session timeline events
│   │   │           ├── approve/          # POST approve (supervisor)
│   │   │           ├── close/            # POST close (navigator)
│   │   │           ├── transfer/         # POST transfer to another navigator
│   │   │           ├── navigator-messages/ # POST send navigator chat message
│   │   │           └── user-close/       # POST close session as user (M2M auth)
│   │   │
│   │   ├── auth/
│   │   │   ├── signin/page.tsx
│   │   │   └── signup/page.tsx
│   │   │
│   │   ├── dashboard/
│   │   │   ├── navigator/
│   │   │   │   ├── page.tsx              # Navigator: session list dashboard
│   │   │   │   ├── profile/page.tsx      # Navigator: profile setup/edit
│   │   │   │   └── [sessionId]/
│   │   │   │       ├── page.tsx          # Navigator: split-panel session detail + chat
│   │   │   │       └── chat/page.tsx     # Navigator: standalone chat view
│   │   │   ├── supervisor/
│   │   │   │   ├── page.tsx              # Supervisor: oversight dashboard
│   │   │   │   └── [sessionId]/
│   │   │   │       ├── page.tsx          # Supervisor: session detail + actions
│   │   │   │       └── chat/page.tsx     # Supervisor: chat transcript
│   │   │   └── user/
│   │   │       ├── page.tsx              # User: active session view
│   │   │       └── [sessionId]/page.tsx  # User: session transcript
│   │   │
│   │   ├── chat/page.tsx                 # Anonymous user chat interface
│   │   ├── layout.tsx                    # Root layout (Sonner + StoreSync)
│   │   └── page.tsx                      # Public landing page
│   │
│   ├── components/
│   │   ├── DashboardPoller.tsx           # Polls router.refresh() every 30s
│   │   ├── ShowMoreList.tsx              # Expand/collapse list (default: show 3)
│   │   ├── OverdueFlair.tsx              # Red "Response overdue" badge (24h+)
│   │   ├── DeleteSessionButton.tsx       # Trash icon → DELETE /api/sessions/{id}
│   │   ├── StoreSync.tsx                 # Hydrates Zustand store on mount
│   │   ├── NavigatorProfileForm.tsx      # Navigator profile form
│   │   ├── ReferralCard.tsx              # Referral display card
│   │   ├── ReferralForm.tsx              # Referral creation form
│   │   └── ...                           # Other UI components
│   │
│   ├── lib/
│   │   ├── auth0.ts                      # Auth0Client init + ROLES_CLAIM constant
│   │   ├── lambda.ts                     # lambdaFetch() server-only helper
│   │   ├── utils.ts                      # cn(), hasUnresponded24h()
│   │   ├── store.ts                      # Zustand store + types
│   │   └── chatApi.ts                    # Client-side anonymous chat API wrapper
│   │
│   └── middleware.ts                     # Auth0 middleware + role-based routing
│
├── public/
│   └── new-icons/                        # SVG icons for session categories
│
├── .env.local                            # Secrets (not committed)
├── next.config.ts
├── tailwind.config.ts
└── tsconfig.json
```

### Key files explained

| File | Purpose |
|---|---|
| `src/middleware.ts` | Enforces auth + role gating on every request. Read this first to understand access control. |
| `src/lib/lambda.ts` | Single place where Auth0 token injection happens. All server→Lambda calls go through here. |
| `src/lib/auth0.ts` | Auth0 client config. The `ROLES_CLAIM` constant (`https://streetlives.app/roles`) is used everywhere roles are read. |
| `src/lib/store.ts` | Zustand store. Contains all shared types. Persists to localStorage under key `streetlives-store-v10`. |
| `src/lib/chatApi.ts` | Used by the anonymous `/chat` page. Unlike other API calls, this hits Lambda directly (no auth token). |
| `src/app/dashboard/navigator/[sessionId]/page.tsx` | Most complex page. Split-panel layout, message polling, session close flow, transfer, timeline. |
| `src/app/dashboard/supervisor/[sessionId]/page.tsx` | Supervisor review page. Approve, return with notes, transfer, view timeline. |

---

## 10. Setup & Local Development

*Source: HANDOFF.md · KIRUI HANDOFF.md*

### Prerequisites

- Node.js 18+
- npm or yarn
- Access to the project's Auth0 tenant (ask the project lead)
- Access to the Lambda API URL (ask the project lead)

### Installation

```bash
git clone https://github.com/lijuliana/T4SG-Streetlives
cd t4sg-streetlives
npm install
```

### Environment variables

Create `.env.local` in the project root:

```env
# Auth0 — Next.js app
AUTH0_DOMAIN=dev-i2wpbc2253ciduoj.us.auth0.com
AUTH0_CLIENT_ID=<your-client-id>
AUTH0_CLIENT_SECRET=<your-client-secret>
AUTH0_SECRET=           # 32-byte hex string — generate with: openssl rand -hex 32

# Auth0 API audience — must match the Auth0 API identifier
AUTH0_AUDIENCE=https://streetlives.app/api

# Lambda backend base URL
NEXT_PUBLIC_API_URL=https://oni18c6q64.execute-api.us-east-1.amazonaws.com

# Your local URL (used for Auth0 callback URLs)
APP_BASE_URL=http://localhost:3000
```

> **Note:** `NEXT_PUBLIC_API_URL` is prefixed with `NEXT_PUBLIC_` so it's accessible client-side (used by `chatApi.ts` for anonymous chat). All other variables are server-only.

### Running locally

```bash
npm run dev
```

Visit `http://localhost:3000`.

To verify it's working:
- Landing page loads at `/`
- Anonymous chat accessible at `/chat`
- Login at `/auth/login` — Auth0 redirects back to home, then role-based redirect to dashboard

### Creating test accounts

1. Log in via Auth0
2. In the Auth0 dashboard, assign the `navigator` or `supervisor` role to the user manually
3. Log out and back in (roles are read from the session token, which refreshes on login)

---

## 11. Navigator & Supervisor Dashboards

*Source: DASHBOARDS.md*

### Architecture Overview

Both dashboards are built on a shared Zustand store with localStorage persistence (`"streetlives-store-v10"`). Only `sessions` and `chatMessages` are persisted — `activeRole` is kept in memory only. All session state mutations go through store actions; components never mutate state directly.

**Key types:**

```ts
type SessionStatus = "queued" | "active" | "closed";
type ReferralStatus = "shared" | "called_together" | "appointment_scheduled" | "contacted" | "visited" | "waitlisted";
type AppRole = "user" | "navigator" | "supervisor";
type SessionEventType = "created" | "assigned" | "transferred" | "closed" | "returned";
```

### Navigator Dashboard

**Files:**

| File | Purpose |
|------|---------|
| `src/app/dashboard/navigator/page.tsx` | List view — active sessions, new requests, past sessions |
| `src/app/dashboard/navigator/[sessionId]/page.tsx` | Session detail — role-aware; editable for navigator, read-only for supervisor |
| `src/app/dashboard/navigator/[sessionId]/chat/page.tsx` | Live chat interface |

**List View:**

The navigator home (`/dashboard/navigator`) splits sessions into three sections:

- **Active** — sessions with status `!== "closed"` assigned to this navigator
- **New Requests** — unassigned sessions (`navigatorId === null`)
- **Past** — closed sessions

A summary strip at the top shows counts for each section, with the "New Requests" count highlighted amber when non-zero. Sessions in the **New Requests** section show an orange **"New Request"** badge instead of the standard green "Active" badge.

**Session Detail Sections (in order):**

1. **Header panel** — topics, routing badge ("Routed" in blue when `assignedByRouting === true`), status badge, navigator name or "Unassigned", start/close timestamps
2. **Accept Session** — navigator role + unassigned session only
3. **Assign to Navigator** — supervisor role + unassigned session only
4. **Routing** — supervisor role + active + assigned only; Transfer dropdown and "Re-run Routing" button
5. **Close Session button** — navigator role + active + own session only; opens the wrap-up form inline
6. **Wrap-up form** — requires completion before closing:
   - **Outcome** (required, multi-select checkboxes): "Referrals shared", "Information only", "Follow-up needed"
   - **Notes** (optional textarea)
   - **Schedule follow-up** checkbox + date picker
   - **"Close & Submit for Review"** button — disabled until at least one outcome is selected
7. **Outcome Log** — read-only; shown after session is closed and logged
8. **Session Notes** — editable textarea when active (saves on blur); static read-only when closed or viewed by supervisor
9. **Referrals** — always visible; editable status dropdowns when active + navigator + own session
10. **Timeline** — immutable event log
11. **Review Status** — navigator role + closed + logged only; shows Awaiting Review, Approved, or Returned
12. **Supervisor Review panel** — supervisor role + closed + logged + not yet decided

**Timeline Event Types:**

| Type | Icon | Color | Label |
| ---- | ---- | ----- | ----- |
| `created` | Circle | Gray | Session created |
| `assigned` | UserPlus | Blue | Assigned |
| `transferred` | ArrowRight | Amber | Transferred |
| `closed` | CheckCircle | Green | Session closed |
| `returned` | RotateCcw | Orange | Returned to navigator |

**Chat:**

The chat page (`/dashboard/navigator/[sessionId]/chat`) is write-enabled for navigators on active sessions, and read-only otherwise.

| Role | Alignment | Style |
|------|-----------|-------|
| `navigator` | Right | Yellow bubble |
| `bot` | Right | Gray bubble |
| `user` | Left | White card + avatar |
| `system` | Center | Divider with text |
| Referral (`serviceId` present) | Right | Yellow card with "Click here for details →" link |

### Supervisor Dashboard

**Files:**

| File | Purpose |
|------|---------|
| `src/app/dashboard/supervisor/page.tsx` | Overview — metrics grid + per-navigator load breakdown |
| `src/app/dashboard/supervisor/[sessionId]/page.tsx` | Session detail — always read-only with routing controls and review panel |
| `src/app/dashboard/supervisor/[sessionId]/chat/page.tsx` | Transcript view — read-only, no input |

**List View Metrics grid** (2 columns on mobile, 5 on desktop):

| Metric | Highlight color |
|--------|----------------|
| Total Sessions | Gray |
| Active | Green |
| New Requests | Amber (when > 0) |
| Total Referrals | Blue |
| Awaiting Review | Amber (when > 0) |

**By Navigator section** — each navigator is rendered as an expandable `NavigatorRow`:

- Load bar (green below 75% capacity, amber at or above 75%)
- Amber dot on name if any sessions have `reviewStatus === "submitted"`

**Supervisor Session Detail Sections (in order):**

1. **Header panel** — topics, status badge, navigator name or "Unassigned", start/close timestamps
2. **Assign to Navigator** — unassigned sessions only
3. **Routing** — active + assigned sessions only; transfer dropdown and "Re-run Routing" button
4. **Session Notes** — always read-only
5. **Referrals** — always read-only
6. **Timeline** — uses `SupervisorTimelineEvent` component; plain gray dot instead of color-coded icons
7. **Supervisor Review** — closed + logged + not yet approved or returned:
   - Coaching note textarea (optional to approve, required to return)
   - "Return to Navigator" — disabled until coaching note is entered
   - "Approve" — always enabled
8. **Review Decision** — closed + already decided; read-only card

### Shared Components

**`DashboardShell`** — layout wrapper used by all detail and list pages.

**`SessionCard`** — renders a session summary row used in list views:
- Navigator/supervisor view: shows `#[last 5 digits of ID]`
- Supervisor view only: shows "Needs Review" amber badge when `reviewStatus === "submitted"`
- Navigator view only: shows "Returned" red badge when `reviewStatus === "returned"`
- Unassigned sessions in navigator view: shows orange **"New Request"** badge

**`ReferralCard`** — displays a single referral. When `editable={true}`, the status field is a dropdown. When `editable={false}`, status is a static badge.

**`ReferralForm`** — modal dialog for adding referrals. On submit, adds the referral and also appends a chat message so every referral appears in the chat transcript.

### Session Lifecycle

```
User initiates chat
  └─ createSession() → status: "queued", navigatorId: null or assigned

Unassigned session
  ├─ Navigator accepts → assignSession() → "assigned" event
  ├─ Supervisor assigns manually → assignSession() → "assigned" event
  └─ Supervisor re-routes → rerouteSession() → routing algorithm picks navigator

Active session (navigator)
  ├─ addReferral() → Referral created + chat message linked by serviceId
  ├─ updateSessionStatus() → session.summary updated
  ├─ addChatMessage() → live chat
  └─ transferSession() → "transferred" event, new navigator assigned

Navigator closes session
  ├─ endSession() → status: "closed", "closed" event appended
  ├─ logSession() → outcome + notes + follow-up + referral names stored on session
  └─ submitForReview() → reviewStatus: "submitted"

Supervisor reviews
  ├─ approveSession(note) → reviewStatus: "approved", reviewedAt set
  └─ returnSession(note) → reviewStatus: "returned", status: "active", "returned" event appended

Navigator sees "Returned" badge, session is re-opened (chat re-enabled), may re-submit after further review
```

### Permission Matrix

| Action | Navigator | Supervisor |
|--------|-----------|------------|
| View own sessions | Yes | — |
| View all sessions | No | Yes |
| Accept unassigned session | Yes | No |
| Assign unassigned session | No | Yes |
| Transfer active session | No | Yes |
| Re-run routing | No | Yes |
| Edit session notes | Yes (own, active) | No |
| Add / edit referrals | Yes (own, active) | No |
| Send chat messages | Yes (own, active) | No |
| Close session + wrap-up | Yes (own, active) | No |
| Submit for review | Yes (own, at close) | No |
| Approve session | No | Yes (closed + logged) |
| Return session (re-opens chat) | No | Yes (closed + logged) |

---

## 12. Usage Guide

*Source: HANDOFF.md*

### User flow (anonymous)

1. User visits `/chat`
2. Selects need category + language
3. Chat window opens — Lambda creates a session and runs the matching algorithm
4. Navigator is assigned; user can chat in real time
5. Navigator closes session when help is complete

### Navigator flow

1. Log in → routed to `/dashboard/navigator`
2. **First visit:** redirected to `/dashboard/navigator/profile` to complete profile (name, languages, expertise, nav group, capacity)
3. Dashboard shows: **Active** (my open sessions), **Unassigned** (available to pick up), **Closed** (my past sessions)
4. Click a session → split-panel view:
   - **Left:** session info, session notes, timeline, transfer/close controls
   - **Right:** live chat
5. To close: select outcome(s), optionally add notes, click "Close & Submit for Review"
6. Closed sessions appear in the supervisor's "Needs Review" queue

### Supervisor flow

1. Log in → routed to `/dashboard/supervisor`
2. Dashboard shows:
   - **Needs Review** (left) — closed sessions awaiting approval
   - **By Navigator** (right) — all navigators with capacity bars
   - **Unassigned** — sessions not yet picked up
   - **Approved Archive** — sessions marked approved
3. Click a session → detail view with:
   - Session metadata, notes, outcome, follow-up date
   - Timeline of events
   - Chat transcript
   - **Approve** button — marks `approved: true`
   - **Return** button — sends session back to navigator with coaching notes (partially implemented — see known issues)
   - **Transfer** — reassign to a different navigator

### Navigator profile fields

| Field | Description |
|---|---|
| `first_name`, `last_name` | Display name shown to supervisors |
| `nav_group` | Organization (e.g., CUNY_PIN, Housing Works). Used as fallback display name if no real name set. |
| `languages` | Languages spoken (used in matching) |
| `expertise_tags` | Areas of expertise (used in matching) |
| `capacity` | Max concurrent active sessions |
| `status` | `available`, `away`, `offline` |
| `availability_schedule` | Day → `{start, end}` hours when they're active |
| `is_general_intake` | Whether they accept general (non-specialized) intake |

### Session status values

| `status` | Meaning |
|---|---|
| `active` | Open, being worked on |
| `closed` | Closed by navigator or user |

Additional flags on closed sessions:
- `submitted_for_review: true` — navigator submitted for supervisor review
- `approved: true` — supervisor approved
- `coaching_notes` — supervisor feedback if session was returned

### Navigator Onboarding & Profile

**Entry point:** `/dashboard/navigator/profile`  
**Key files:** `src/components/NavigatorProfileForm.tsx`, `src/app/dashboard/navigator/profile/page.tsx`, `src/app/api/navigators/me/route.ts`

**Flow:**
1. Navigator logs in with Auth0 (must have `navigator` role assigned).
2. Middleware lets them through to `/dashboard/navigator`.
3. Dashboard server component fetches `/api/navigators` and looks for a row matching their `auth0_user_id`.
4. If no row exists → redirect to `/dashboard/navigator/profile`.
5. Navigator fills in: first name, last name, nav group, capacity, languages (with free-text "other" option), expertise tags, and a **per-day availability schedule**.
6. On save: `PUT /api/navigators/me` → finds the row in RDS by `auth0_user_id` and PATCHes it, or POSTs to create if it doesn't exist yet.
7. After a complete profile is saved, the navigator is redirected to their dashboard.

**Profile Completeness Gate:** The navigator dashboard redirects to profile setup if `myProfile` is null. There is no additional `isProfileComplete()` check. If a navigator has a partial row (e.g. missing `availability_schedule`), they will pass through to the dashboard even with an incomplete profile.

---

## 13. Session Management — Deliverable Notes

*Source: DELIVERABLE_7.md · DELIVERABLE_8.md*

### Deliverable 7

The backend (AWS / RDS / Lambda) and Matrix path are wired to the Next.js app so **anonymous users can start real chat sessions with peer navigators**, and **navigators see live session data in the dashboard**, not the old mock data.

### Deliverable 8

#### Backend — `backend/lambda/index.mjs`

**New endpoints:**
- **`PATCH /sessions/:id`** — updates `notes`, `outcome`, `follow_up_date`, `submitted_for_review`. Only the assigned navigator or a supervisor can update. Returns the full updated session row.
- **`POST /sessions/:id/approve`** — supervisor only. Saves `coaching_notes` and sets `approved = true`. Returns the full updated session row.

**Updated endpoints:**
- **`GET /sessions`** — now role-aware. Reads the `https://streetlives.app/roles` claim from the Auth0 access token.
  - `supervisor` → returns all sessions
  - `navigator` → looks up their navigator profile by `auth0_user_id`, returns only sessions where `navigator_id` matches
  - anything else → 403

**New columns added to RDS sessions table:**  
`notes TEXT`, `outcome TEXT[]`, `follow_up_date DATE`, `submitted_for_review BOOLEAN`, `approved BOOLEAN`, `coaching_notes TEXT`

#### New Proxy Routes

| File | Method | Forwards to |
|---|---|---|
| `sessions/[sessionId]/route.ts` | `PATCH` | `PATCH /sessions/:id` |
| `sessions/[sessionId]/approve/route.ts` | `POST` | `POST /sessions/:id/approve` |
| `sessions/[sessionId]/transfer/route.ts` | `POST` | `POST /sessions/:id/transfer` |
| `sessions/[sessionId]/events/route.ts` | `GET` | `GET /sessions/:id/events` |

#### User Dashboard (Deliverable 8)

`src/app/dashboard/user/page.tsx` reads entirely from **localStorage** — no user account, full anonymity preserved.

- **Active Session**: reads `sl_session_id` + `sl_session_state` from localStorage. On mount, verifies real status via `GET /sessions/:id?token=...` — if the navigator has already closed the session, localStorage is corrected immediately and the session moves to Past Sessions.
- **Past Sessions**: reads `sl_past_sessions` array from localStorage. Each entry links to the read-only transcript.

#### localStorage keys (user-side, device-only)

| Key | Value | Cleared when |
|---|---|---|
| `sl_session_id` | UUID | User starts new chat |
| `sl_session_token` | UUID | User starts new chat |
| `sl_session_state` | `picker/waiting/live/closed` | User starts new chat |
| `sl_session_need_category` | e.g. `housing` | User starts new chat |
| `sl_session_created_at` | ISO timestamp | User starts new chat |
| `sl_past_sessions` | JSON array of closed sessions | Never (accumulates) |

---

## 14. Known Bugs & Issues

*Source: HANDOFF.md · KIRUI HANDOFF.md · DOCUMENTATION_KA.md*

### 14.1 Return-to-navigator not fully implemented

**Description:** The supervisor can click "Return to Navigator" with coaching notes, but the backend DB logic to actually revert the session status and notify the navigator is not wired up.

**Expected:** Session returned to `active`, navigator sees it in their dashboard with supervisor's coaching notes.

**Actual:** The POST may succeed but the session state in the DB may not update correctly.

**Fix needed:** Backend — ensure the `/sessions/{id}/return` endpoint sets `status: "active"`, `submitted_for_review: false`, and saves `coaching_notes`.

---

### 14.2 Delete button does not work

**Description:** The trash icon on "Needs Review" sessions in the supervisor dashboard sends `DELETE /api/sessions/{id}` but the Lambda endpoint does not actually delete the record.

**Steps to reproduce:** Supervisor dashboard → Needs Review → click trash icon → confirm → session remains.

**Fix needed:** Backend — implement the DELETE handler in Lambda. Frontend code is correct.

---

### 14.3 Sessions not flagged by who closed them

**Description:** There is no `closed_by` or `close_source` field in the session data. This means the frontend cannot distinguish between "user closed the chat" vs "navigator closed the chat." All closed sessions show a generic "Closed" status.

**Impact:** Supervisors cannot filter or sort by close reason. All closed sessions appear in "Needs Review" regardless of why they were closed.

**Fix needed:** Backend — add a `close_source: "user" | "navigator"` field, set it when `/close` or `/user-close` is called.

---

### 14.4 Initial message load is slow (~3-10 seconds)

**Description:** When a navigator or supervisor opens a session for the first time in a browser session, messages take ~10 seconds to appear.

**Root cause:** The Lambda → Matrix message fetch is slow on cold start or for large rooms.

**Frontend mitigation (implemented):** Messages are cached in `localStorage` under `sl_messages_{sessionId}`. On subsequent opens of the same session, cached messages render instantly while the poll runs in the background to fetch any new ones.

**Remaining fix needed:** Backend — cache recent messages in the DB so the Lambda fetch doesn't need to hit Matrix cold every time.

---

### 14.5 Matching algorithm exceeds navigator capacity

**Description:** The Lambda matching algorithm can assign a new session to a navigator who is already at their declared max capacity.

**Impact:** Navigators get overloaded. The supervisor dashboard shows capacity bars turning orange/red to indicate overload, but sessions are still assigned.

**Fix needed:** Backend — add a capacity check before assigning. Reject or queue the session if all navigators are at capacity.

---

### 14.6 Referral functionality not implemented

**Description:** The `ReferralCard` and `ReferralForm` components exist in the codebase, and the Zustand store has referral types, but referrals are not wired to the backend or displayed in the session detail views.

**Fix needed:** Design the referral data model in the DB, add Lambda endpoints, and integrate into the navigator session close flow.

---

### 14.7 JWKS Rotation Breaks JWT Validation

**Impact: High.** Auth0 rotates signing keys periodically. The JWKS is baked into the Lambda as `AUTH0_JWKS`. If it rotates, every authenticated Lambda call returns 401 until the env var is updated.

**Fix:** Fetch the JWKS from Auth0, update the `AUTH0_JWKS` env var in the Lambda console, and re-deploy (or just update env and force a cold start).

---

### 14.8 Navigator Status Not Auto-Updated

**Impact: Medium.** A navigator's `status` in `navigator_profiles` is only updated when they explicitly set it. If a navigator goes offline without updating their status, the routing algorithm may still route sessions to them.

**Fix:** Add a heartbeat mechanism or auto-set status to `offline` on Auth0 logout / session expiry.

---

### 14.9 `transferRequestStore` Not Shared Across Instances

**Impact: Low.** The `globalThis.__slTransferRequested` store is in-process memory. On Vercel (serverless), each request can hit a different function instance. A "Transfer Requested" badge on the navigator side may not appear.

**Fix:** Persist this flag to RDS as a column on `sessions` (e.g. `user_requested_transfer BOOLEAN`).

---

### 14.10 Profile Completeness Gate Is Incomplete

**Impact: Low.** The dashboard redirects to profile setup only when no DB row exists. A navigator who has a row but is missing `availability_schedule` or `languages` will pass through and appear to the routing algorithm as ineligible (filtered out silently). They'll never get assigned sessions and won't know why.

**Fix:** Add an `isProfileComplete()` check in the dashboard server component and redirect to profile if incomplete.

---

### 14.11 Routing Algorithm Duplication (Lambda vs. Client)

**Impact: Low.** `backend/lambda/index.mjs` (`assignNavigator`) and `src/lib/routing.ts` (`pickNavigator`) implement the same logic independently. They can drift.

**Fix:** Consolidate — either call the Lambda for routing decisions or move both to a shared module.

---

### 14.12 EC2 Bastion as Single Point of DB Access

**Impact: Operational.** If the bastion EC2 instance is stopped, there is no way to run migrations or debug the database.

**Mitigation:** Keep the bastion's instance ID and key pair documented. Alternatively, set up AWS Systems Manager Session Manager as a keyless alternative.

---

### Fragile areas

- `OverdueFlair` depends on `localStorage` key `sl_nav_responded_{sessionId}`. If the key is absent (e.g., navigator used a different browser), the session will incorrectly show as overdue.
- Message deduplication uses a `seenEventIds` ref. On page load this is seeded from the localStorage cache, so previously-seen messages won't re-appear. However if the cache is cleared, all messages will re-fetch and deduplicate correctly on the first poll.

---

## 15. Performance & Limitations

*Source: HANDOFF.md*

### Message polling

Every open session detail page polls `/api/sessions/{id}/messages` every 7 seconds. With multiple navigators logged in across multiple tabs, this generates high Lambda request volume. If the team scales to 20+ navigators each with a tab open, this could become expensive.

**Mitigation:** Polling stops when a session is closed (`session?.status === "closed"`). But navigators with many concurrent active sessions multiply the polling.

**Future fix:** Replace polling with WebSocket or Server-Sent Events at the Lambda/Matrix layer.

### Dashboard refresh

`DashboardPoller` calls `router.refresh()` every 30 seconds. This re-runs all server components for the dashboard page — i.e., re-fetches all sessions and navigators from Lambda. At low scale this is fine; at high scale it could be expensive.

### Lambda cold starts

The Lambda backend has cold start latency. First requests after idle periods are noticeably slow (5–10+ seconds). This particularly affects the initial load of chat messages.

### No pagination

Session lists (closed sessions, approved archive) are fetched in full on every load. If a supervisor has thousands of sessions, this will become slow. Currently mitigated by `ShowMoreList` limiting display, but the data is still all fetched upfront.

---

## 16. Next Steps / Roadmap

*Source: HANDOFF.md · KIRUI HANDOFF.md · DOCUMENTATION_KA.md*

### Immediate (bugs to fix)

- [ ] Implement return-to-navigator backend logic
- [ ] Implement session delete in Lambda
- [ ] Add `close_source` field to session model

### Short-term features

- [ ] **Referral flow** — complete the referral UI and wire it to backend. Show referrals in session detail and close flow.
- [ ] **Navigator availability toggle** — button to set status to `away`/`offline` on the navigator dashboard
- [ ] **Navigator status management** — auto-set to `offline` on logout or session expiry; add a manual status toggle to the navigator dashboard

### Medium-term

- [ ] **Replace polling with real-time** — WebSocket or SSE for messages and session updates (Matrix `/sync` long-poll)
- [ ] **Pagination** for session lists (backend support needed)
- [ ] **Supervisor analytics** — aggregate views: sessions per day, avg response time, category breakdown
- [ ] **Email/SMS notifications** — notify navigators when a new session is assigned
- [ ] **Referrals to RDS** — Currently referral data is not persisted to the database; add a `referrals` table if the client needs reporting
- [ ] **JWKS auto-refresh** — Schedule a Lambda layer or cron that fetches the JWKS periodically, or use a NAT gateway to allow the Lambda to fetch it at runtime
- [ ] **Monitoring** — Set up CloudWatch alarms on Lambda error rate and RDS CPU; there is currently no alerting
- [ ] **Auto-reassign when navigator goes offline** — detect status change to `away`/`offline` and trigger reassignment for active sessions
- [ ] **Navigator timezone support** — the availability schedule is evaluated in the server's local time; add a timezone field to navigator profiles

### Technical debt

- The Zustand store (`store.ts`) is large and contains many types and actions that are partially unused or duplicated with the backend data models. Consider consolidating once the backend models are stable.
- `chatApi.ts` (anonymous chat) uses a different auth pattern (no token) than all other API calls. It would be cleaner to unify under the same proxy pattern with a guest/anonymous token.
- `mockData.ts` still exists and should be removed once confirmed unused.
- Multiple components define the same `Session` and `NavProfile` interfaces locally (in page files) instead of importing from a shared types file. Consolidate into `src/lib/types.ts`.

### Testing gaps

- Unit tests for utility functions (`cn`, `hasUnresponded24h`, language mapping, `navFullName` fallback)
- Integration tests for API routes (mock Lambda, test auth token injection)
- E2E tests (Playwright) for critical user journeys: user chat → navigator response → supervisor approval

---

## 17. Developer Tips & Gotchas

*Source: HANDOFF.md*

### Auth0 roles don't update in the session until re-login

If you assign the `navigator` or `supervisor` role to a user in the Auth0 dashboard, they must **log out and log back in** before the role is reflected. The role is stored in the session token which is only re-issued at login.

### `lambdaFetch` is server-only

`src/lib/lambda.ts` uses `auth0.getAccessToken()` which only works in server context (API routes, server components). Do not import it into client components — it will throw at runtime.

### `NEXT_PUBLIC_API_URL` is exposed to the browser

Any env variable prefixed with `NEXT_PUBLIC_` is embedded in the client bundle. This is intentional for `chatApi.ts` (anonymous chat hits Lambda directly). Do not put secrets in `NEXT_PUBLIC_` variables.

### Multiple browser tabs during testing

If you're testing with multiple tabs (e.g., logged in as navigator in one tab and supervisor in another), each tab runs its own polling intervals. This is expected behavior but can generate noisy server logs.

### `nav_group` vs navigator name

`nav_group` is the **organization** a navigator belongs to (e.g., `CUNY_PIN`, `Housing_Works`). It is not a person's name. Always use `navFullName()` / `navDisplayName()` helpers (defined in each page file) to get a display name — these check `first_name`/`last_name` first and fall back to `nav_group` with a short ID suffix only if no name is set.

### Session close vs submit for review

Navigators have a single "Close & Submit for Review" action. There is no way to close a session without submitting it (from the navigator's perspective). If a session appears in "Needs Review" without `submitted_for_review: true`, it was likely closed via a different path (e.g., user-close endpoint).

### Optimistic messages

When a navigator sends a message, an optimistic entry is immediately added to the message list with `pending: true` and 50% opacity. On the next poll, if a matching confirmed message arrives from Matrix (same role + content), the optimistic entry is removed and replaced. If the send fails, the optimistic entry is removed and an error is shown. Pending messages are never written to the localStorage cache.

### Message ordering

Messages are sorted by timestamp on every poll merge. This prevents out-of-order display when messages sent in rapid succession are confirmed by Matrix in a different order than they were sent.

### Message cache (localStorage)

Chat messages are cached in `localStorage` under the key `sl_messages_{sessionId}`. On page load, the cache is read synchronously and used to populate the message list before any network request fires — eliminating the blank-screen delay on re-opening a session. The `seenEventIds` set is also seeded from the cache so already-seen messages aren't re-appended on the first poll.

### `OverdueFlair` depends on localStorage

The "Response overdue" badge checks `localStorage.getItem('sl_nav_responded_{sessionId}')`. This key is set when a navigator successfully sends a message. If a navigator responds from a different device/browser, the flair will still appear on their first device. This is a known limitation.

### Tailwind brand colors

Custom colors are defined in `tailwind.config.ts`:
- `bg-brand-yellow` / `text-brand-yellow` → `#FFDC00` (primary accent)
- `bg-brand-exit` / `text-brand-exit` → `#E83E5C` (Quick Exit button — always present for safety)
- `bg-brand-dark` → `#323232`

### `suppressHydrationWarning`

Many timestamp elements have `suppressHydrationWarning` on them. This suppresses React's hydration mismatch warning that occurs because `moment()` formats dates differently on server (UTC) vs client (local timezone). The timestamps are correct client-side; the warning is benign but annoying without the suppression.

---

## 18. Backend API Reference

*Source: matrix-chat/backend/docs/api.md*

Base URL: `http://localhost:3000` (configurable via `PORT` env var)

All request and response bodies are JSON. All timestamps are ISO 8601 strings.

---

### Navigator Profiles

Navigator profiles represent navigators who can be assigned to guest sessions. Each profile maps to a Matrix user on the homeserver.

> **nav_group** is stored for future routing use but does not constrain assignment right now. All navigators are treated as cross-trained across all need categories. **isGeneralIntake** is what controls initial assignment eligibility.

#### POST /api/navigators

Creates a navigator profile from onboarding form data.

**Request body**

| Field            | Type     | Required | Default       | Description                                                   |
|------------------|----------|----------|---------------|---------------------------------------------------------------|
| `userId`         | string   | yes      | —             | Matrix user ID, e.g. `@alice:homeserver.org`                  |
| `navGroup`       | string   | yes      | —             | `"CUNY_PIN"` \| `"HOUSING_WORKS"` \| `"DYCD"` — stored only  |
| `expertiseTags`  | string[] | no       | `[]`          | Free-form domain tags (reserved for future scoring)           |
| `languages`      | string[] | no       | `["en"]`      | ISO 639-1 codes — lowercased automatically                    |
| `capacity`       | number   | no       | `5`           | Max concurrent active sessions                                |
| `status`         | string   | no       | `"available"` | `"available"` \| `"away"` \| `"offline"`                     |
| `isGeneralIntake`| boolean  | no       | `false`       | If `true`, eligible for initial (first-touch) assignment      |

**Response** `201 Created`

```json
{
  "id": "a1b2c3d4-...",
  "userId": "@alice:homeserver.org",
  "navGroup": "HOUSING_WORKS",
  "expertiseTags": ["intake", "housing"],
  "languages": ["en", "es"],
  "capacity": 5,
  "status": "available",
  "isGeneralIntake": true,
  "createdAt": "2026-04-04T12:00:00.000Z",
  "updatedAt": "2026-04-04T12:00:00.000Z"
}
```

**Errors**

| Status | Condition                              |
|--------|----------------------------------------|
| 400    | Missing/invalid fields                 |
| 409    | `userId` already has a profile         |

#### GET /api/navigators

Returns all navigator profiles as an array.

#### GET /api/navigators/:id

Returns a single navigator profile by internal ID. `404` if not found.

#### PATCH /api/navigators/:id

Partial update — all fields optional. Use this to flip a navigator's status, update their language list, or toggle `isGeneralIntake`.

**Request body** (all optional)

| Field            | Type     | Description                                    |
|------------------|----------|------------------------------------------------|
| `navGroup`       | string   | `"CUNY_PIN"` \| `"HOUSING_WORKS"` \| `"DYCD"` |
| `expertiseTags`  | string[] | Replaces existing tags (not merged)            |
| `languages`      | string[] | Replaces existing languages                    |
| `capacity`       | number   | Must be >= 1                                   |
| `status`         | string   | `"available"` \| `"away"` \| `"offline"`       |
| `isGeneralIntake`| boolean  | Toggle general-intake eligibility              |

**Response** `200 OK` — updated profile object. **Errors** `400` invalid value · `404` not found.

---

### Routing

#### POST /api/routing/assign

Dry-run routing: returns the best available navigator without creating a session.

**Request body**

| Field         | Type                     | Required | Description                                              |
|---------------|--------------------------|----------|----------------------------------------------------------|
| `needCategory`| string                   | yes      | `housing`, `employment`, `health`, `benefits`, `youth_services`, `education`, `other` |
| `language`    | string                   | no       | ISO 639-1 code — primary routing filter                  |
| `tags`        | string[]                 | no       | Reserved for future scoring; ignored in v2               |
| `mode`        | `"initial"\|"transfer"`  | no       | Default `"initial"`. `initial` = only `isGeneralIntake = true` navigators. `transfer` = all available. |

**Response (navigator found)** `200 OK`

```json
{
  "assigned": true,
  "navigator": { "id": "...", "userId": "@alice:homeserver.org" },
  "routingReason": {
    "generalIntakeOnly": true,
    "languageRequested": "es",
    "languageMatch": true,
    "loadRatio": 0.2,
    "score": -0.2
  },
  "routingVersion": "v2_language_first_general_intake"
}
```

**Response (no match)** `200 OK`

```json
{
  "assigned": false,
  "reason": "No available general-intake navigator speaks \"fr\"",
  "routingVersion": "v2_language_first_general_intake"
}
```

---

### Sessions

#### POST /api/sessions

Creates a new guest session. Automatically creates a Matrix room, runs routing, invites navigator if found, writes audit events.

**Request body** (all optional)

| Field         | Type     | Description                                               |
|---------------|----------|-----------------------------------------------------------|
| `needCategory`| string   | Stored for audit/analytics; does not constrain routing    |
| `language`    | string   | ISO 639-1 code — primary routing filter                   |
| `tags`        | string[] | Reserved for future use                                   |

**Response** `201 Created`

```json
{
  "sessionId": "uuid",
  "status": "active",
  "createdAt": "2026-04-04T12:00:00.000Z",
  "assignedNavigatorId": "nav-uuid",
  "routingVersion": "v2_language_first_general_intake",
  "routingReason": { ... },
  "routingFailReason": null
}
```

#### GET /api/sessions

Returns all sessions in reverse-chronological order.

#### GET /api/sessions/:sessionId

Returns a single session by ID. `404` if not found.

#### PATCH /api/sessions/:sessionId/status

Manual status override. Prefer `/close` and `/transfer` for standard lifecycle transitions.

**Request body:** `{ "status": "unassigned" | "active" | "closed" | "transferred" }`

#### POST /api/sessions/:sessionId/close

Closes a session. Returns `409` if already closed.

**Request body (optional):** `{ "actor": "who closed it" }`

**Response:** `{ "ok": true, "closedAt": "2026-04-04T13:00:00.000Z" }`

#### POST /api/sessions/:sessionId/transfer

Transfers a session to a different navigator.
- **Manual** — provide `targetNavigatorId`.
- **Auto** — omit `targetNavigatorId`; routing runs in `"transfer"` mode.

**Request body**

| Field               | Type     | Description                                                          |
|---------------------|----------|----------------------------------------------------------------------|
| `targetNavigatorId` | string   | Optional. Skip routing, transfer directly to this navigator.         |
| `language`          | string   | Optional. Language override for auto re-routing.                     |
| `needCategory`      | string   | Optional. Category override for auto re-routing (audit only in v2).  |
| `reason`            | string   | Human-readable reason.                                               |
| `actor`             | string   | Who initiated (written to audit log).                                |

**Response:** `{ "ok": true, "assignedNavigatorId": "new-nav-uuid" }`

**Errors:**

| Status | Condition |
|--------|-----------|
| 400    | `targetNavigatorId` not found or navigator unavailable |
| 400    | Target is already assigned to this session |
| 404    | Session not found |
| 409    | Session is closed |
| 422    | No eligible navigator available (auto re-route path) |

#### GET /api/sessions/:sessionId/events

Returns the full audit log for a session in chronological order.

**Event types:** `created` · `assigned` · `transferred` · `closed`

---

### Session Messages

#### POST /api/sessions/:sessionId/messages

Sends a guest message. Stored locally and mirrored to Matrix best-effort.

**Request body:** `{ "body": "message text" }`

**Errors:** `400` empty body · `404` not found · `409` session closed.

#### GET /api/sessions/:sessionId/messages

Returns all messages in chronological order. Syncs new messages from Matrix before responding (throttled to once per 5 seconds per session).

**Response:** `{ "messages": [ ... ] }`

---

### Session Notes

#### GET /api/sessions/:sessionId/notes

Returns all notes for the session. Notes are backend-only (not sent to Matrix).

#### POST /api/sessions/:sessionId/notes

**Request body**

| Field       | Type   | Required | Description                       |
|-------------|--------|----------|-----------------------------------|
| `body`      | string | yes      | Note text                         |
| `createdBy` | string | no       | Navigator user ID or display name |

---

### Session Referrals

#### GET /api/sessions/:sessionId/referrals

Returns array of referral objects.

#### POST /api/sessions/:sessionId/referrals

**Request body**

| Field         | Type   | Required | Description                       |
|---------------|--------|----------|-----------------------------------|
| `title`       | string | yes      | Referral title / service name     |
| `description` | string | no       | Additional detail                 |
| `createdBy`   | string | no       | Navigator user ID or display name |

---

### Routing Rules — v2 (`v2_language_first_general_intake`)

The current routing algorithm is intentionally simple and rules-based so policy changes are easy to review and test. The logic lives entirely in `src/services/routingService.ts`.

**Initial assignment vs. transfer:**

| Mode        | Eligible pool                                   |
|-------------|--------------------------------------------------|
| `initial`   | `status = "available"` AND `isGeneralIntake = true` |
| `transfer`  | `status = "available"` (any navigator)          |

**Step 1 — Availability:** Navigators with `status = "away"` or `"offline"` are excluded.

**Step 2 — Pool filter:** `initial` mode restricts to `isGeneralIntake = true`. `transfer` mode has no further restriction.

**Step 3 — Language filter (hard rejection):** If a `language` is provided, candidates who do not speak that language are removed. If no candidates remain, routing returns `unassigned`.

**Step 4 — Load-based ranking:**

```
loadRatio = activeSessions / capacity
```

Candidates are ranked by ascending `loadRatio`. Equal load ratios are broken by navigator `id` ascending for determinism.

**What `need_category` does:** `needCategory` is **stored** on the session and included in audit events for analytics. It does **not** constrain which navigators are eligible in v2.

**Routing reason object:**

```json
{
  "generalIntakeOnly": true,
  "languageRequested": "es",
  "languageMatch": true,
  "loadRatio": 0.25,
  "score": -0.25
}
```

`score` equals `−loadRatio` so higher is better (idle navigator scores 0, fully loaded navigator scores −1).

---

### Seed Navigator Pool Reference (for local testing)

| Navigator | Group | Languages | Intake | Status |
|---|---|---|---|---|
| `@intake-alice` | HOUSING_WORKS | en, es | Yes | available |
| `@intake-bob` | DYCD | en | Yes | available |
| `@intake-carol` | CUNY_PIN | en, zh | Yes | available |
| `@specialist-diana` | HOUSING_WORKS | en, es | No | available |
| `@specialist-eve` | DYCD | en, zh | No | away |
| `@specialist-frank` | CUNY_PIN | en | No | offline |

Start with seed data: `SEED_NAVIGATORS=true npm run dev:backend`
