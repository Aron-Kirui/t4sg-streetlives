# Streetlives x T4SG Technical Documentation

By T4SG (Tech for Social Good) | Spring 2026

---

## Table of Contents

1. [Overview](#overview)
2. [Tech Stack](#tech-stack)
3. [System Architecture](#system-architecture)
4. [Anonymous User Chat](#anonymous-user-chat)
5. [Navigator Dashboard](#navigator-dashboard)
6. [Supervisor Dashboard](#supervisor-dashboard)
7. [Routing Algorithm](#routing-algorithm)
8. [Authentication & Role-Based Access Control](#authentication--role-based-access-control)
9. [Matrix Chat Integration](#matrix-chat-integration)
10. [AWS Infrastructure](#aws-infrastructure)
11. [Database Schema](#database-schema)
12. [Backend Lambda Endpoints](#backend-lambda-endpoints)
13. [Next.js API Layer](#nextjs-api-layer)
14. [Frontend File Structure](#frontend-file-structure)
15. [Setup & Local Development](#setup--local-development)
16. [Deploying Lambda Functions](#deploying-lambda-functions)
17. [Running Database Migrations](#running-database-migrations)
18. [Credential & Ownership Transfer](#credential--ownership-transfer)
19. [Known Bugs & Issues](#known-bugs--issues)
20. [Future Steps](#future-steps)

---

## Overview

Tech for Social Good worked on the Streetlives web platform in Spring 2026. Streetlives (also referred to as YourPeer) connects unhoused individuals with trained human navigators who help them access social services such as housing, food, legal aid, healthcare, and more.

The platform provides three core experiences:

- **Anonymous Chat (User):** An unhoused individual visits the site, selects a need category and language, and is automatically matched with a navigator via a live chat. No login is required.
- **Navigator Dashboard:** Navigators view their active sessions, chat with users in real time, close sessions with outcomes and notes, and submit completed sessions for supervisor review.
- **Supervisor Dashboard:** Supervisors monitor navigator workloads, review closed sessions, approve or return sessions with coaching notes, and manage session routing and transfers.

All pages worked on are protected by role-based access control using Auth0, with the exception of the anonymous chat and landing page which are publicly accessible.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 15 (App Router) |
| Language | TypeScript |
| UI | React 19 + Tailwind CSS |
| State Management | Zustand (localStorage persistence) |
| Authentication | Auth0 (`@auth0/nextjs-auth0` v4) |
| Backend API | AWS Lambda (REST API via API Gateway) |
| Chat Infrastructure | Matrix protocol (hosted externally, accessed via Lambda) |
| Database | PostgreSQL on AWS RDS |
| Icons | Lucide React |
| Toasts / Notifications | Sonner |
| Date Formatting | Moment.js |
| Animations | Framer Motion |

---

## System Architecture

The application follows a three-tier architecture. The browser communicates exclusively with Next.js, which proxies requests to AWS Lambda. Lambda handles business logic, database access, and Matrix chat operations.

```
Browser (anonymous user or authenticated navigator/supervisor)
  |
  v
Next.js App (Vercel or local)
  |--- /api/guest/*         <-- No auth required; validated by session token
  |--- /api/*               <-- Auth0 JWT required
  |
  v
API Gateway (HTTP API)
  |
  v
streetlives-vpc Lambda (private subnet, inside VPC)
  |--- RDS PostgreSQL (private subnet)
  |--- streetlives-matrix Lambda (outside VPC)
            |
            v
       Matrix Homeserver (external)
```

**Key design decisions:**

- **The frontend never calls Lambda directly.** All calls go through Next.js API routes in `src/app/api/`. Those routes use `lambdaFetch()` (server-only) which gets the Auth0 access token, injects it as a Bearer header, and forwards the request to Lambda. This keeps credentials server-side.

- **There is no WebSocket.** Data freshness is maintained through two polling mechanisms:
  - `DashboardPoller` calls `router.refresh()` every 30 seconds to re-fetch session lists.
  - Message polling calls `/api/sessions/{id}/messages` every 7 seconds when a session detail page is open. Sent messages appear instantly for the sender via optimistic UI, but the recipient sees them on their next poll cycle (up to 7 seconds of delay).

---

## Anonymous User Chat

The anonymous chat allows unhoused individuals to get help without creating an account.

**User flow:**
1. User visits `/chat`.
2. Selects a need category (housing, employment, health, benefits, youth services, education, or other) and optionally a language.
3. The system creates a session, runs the routing algorithm to assign a navigator, and opens a live chat window.
4. If no navigator is available, the session enters a queue and is assigned automatically when one becomes available.
5. The navigator closes the session when help is complete.

**Technical Details:**

The chat page is found at `src/app/chat/page.tsx`. When a session is created, the browser receives a `sessionId` and `sessionUserToken`, which are stored in `localStorage`. These tokens are used for all subsequent guest API calls since the user has no Auth0 credentials. The chat page polls `GET /api/guest/sessions/:id/messages` for new messages.

**localStorage keys used by the user side:**

| Key | Value | Cleared When |
|---|---|---|
| `sl_session_id` | UUID of the active session | User starts a new chat |
| `sl_session_token` | UUID used to authenticate guest API calls | User starts a new chat |
| `sl_session_state` | `picker/waiting/live/closed` | User starts a new chat |
| `sl_session_need_category` | e.g., `housing` | User starts a new chat |
| `sl_session_created_at` | ISO timestamp | User starts a new chat |
| `sl_past_sessions` | JSON array of closed sessions | Never (accumulates) |

The User Dashboard at `/dashboard/user` reads entirely from localStorage. It shows the active session (if any) and a list of past sessions. On mount, it verifies the active session's real status via the API and corrects localStorage if the navigator has already closed it.

---

## Navigator Dashboard

The navigator dashboard allows navigators to manage their caseload of active sessions.

**Files:**

| File | Purpose |
|------|---------|
| `src/app/dashboard/navigator/page.tsx` | List view: active sessions, new requests, past sessions |
| `src/app/dashboard/navigator/[sessionId]/page.tsx` | Session detail: split-panel with session info and chat |
| `src/app/dashboard/navigator/[sessionId]/chat/page.tsx` | Standalone chat interface |
| `src/app/dashboard/navigator/profile/page.tsx` | Navigator profile setup/edit |

**List View:**

The navigator home splits sessions into three sections:
- **Active** -- sessions assigned to this navigator that are not closed.
- **New Requests** -- unassigned sessions available to pick up. These show an orange "New Request" badge.
- **Past** -- closed sessions.

A summary strip at the top shows counts for each section. The "New Requests" count is highlighted amber when non-zero.

**Session Detail:**

When a navigator clicks into a session, they see a split-panel layout:
- **Left panel:** Session info, routing badge, status badge, navigator name, timestamps, session notes (editable), referrals, timeline of events, and close/transfer controls.
- **Right panel:** Live chat with the user.

**Closing a Session:**

Navigators close sessions through a wrap-up form that requires:
- **Outcome** (required, multi-select): "Referrals shared," "Information only," "Follow-up needed"
- **Notes** (optional)
- **Follow-up date** (optional date picker)

Clicking "Close & Submit for Review" closes the session and submits it to the supervisor's review queue.

**Navigator Onboarding:**

When a navigator logs in for the first time, they are redirected to `/dashboard/navigator/profile` to complete their profile. The profile form (`src/components/NavigatorProfileForm.tsx`) collects:

| Field | Effect on Routing |
|-------|-------------------|
| First / Last name | Display name in chat messages |
| Navigator group | Organization affiliation (e.g., CUNY PIN, Housing Works) |
| Languages | Guests requesting a language are only matched to navigators who speak it |
| Areas of expertise | Determines which guests reach this navigator in the specialist tier |
| Max concurrent sessions | Hard cap; navigator is excluded from routing once reached |
| Availability schedule | Navigator is only eligible during their configured hours |

**Important:** A navigator with no availability schedule is treated as having an incomplete profile and will not receive any sessions. However, the current profile completeness check only verifies that a database row exists, not that all fields are filled. See Known Bugs for details.

---

## Supervisor Dashboard

The supervisor dashboard provides oversight of all navigators and sessions.

**Files:**

| File | Purpose |
|------|---------|
| `src/app/dashboard/supervisor/page.tsx` | Overview: metrics, per-navigator load breakdown |
| `src/app/dashboard/supervisor/[sessionId]/page.tsx` | Session detail with review controls |
| `src/app/dashboard/supervisor/[sessionId]/chat/page.tsx` | Read-only chat transcript |

**List View:**

The supervisor home displays:
- **Metrics grid** (5 columns): Total Sessions, Active, New Requests, Total Referrals, Awaiting Review. Active metrics are highlighted green; non-zero "New Requests" and "Awaiting Review" are amber.
- **By Navigator section** -- each navigator shown as an expandable row with a capacity load bar (green below 75%, amber at or above 75%). An amber dot appears on navigators with sessions awaiting review.
- **Needs Review** -- closed sessions awaiting supervisor approval.
- **Unassigned** -- sessions not yet picked up by any navigator.
- **Approved Archive** -- previously approved sessions.

**Session Review:**

When reviewing a closed session, supervisors see the session metadata, notes, outcome, timeline, and chat transcript (read-only). They can:
- **Approve** -- marks the session as approved. Always enabled.
- **Return to Navigator** -- requires a coaching note. Sends the session back to the navigator's dashboard with coaching feedback.
- **Transfer** -- reassign the session to a different navigator.
- **Re-run Routing** -- triggers the routing algorithm to find a new navigator.

**Permission Matrix:**

| Action | Navigator | Supervisor |
|--------|-----------|------------|
| View own sessions | Yes | -- |
| View all sessions | No | Yes |
| Accept unassigned session | Yes | No |
| Assign unassigned session | No | Yes |
| Transfer active session | No | Yes |
| Edit session notes | Yes (own, active) | No |
| Send chat messages | Yes (own, active) | No |
| Close session + wrap-up | Yes (own, active) | No |
| Approve session | No | Yes |
| Return session with coaching notes | No | Yes |

---

## Routing Algorithm

When a guest starts a chat, the routing algorithm automatically selects the best available navigator.

**How it works:**

1. **Availability check** -- Only navigators with status `available`, a configured availability schedule, and remaining session capacity are considered.

2. **Primary tier (specialist match)** -- If the guest has a specific need (e.g., housing), the algorithm looks for a navigator whose expertise tags include that category. If a language was also requested, it further narrows to those who speak it.

3. **Fallback tier** -- If no specialist is available, any available navigator is eligible. Language remains a hard requirement: if no one speaks the requested language, the session enters a queue rather than being assigned to someone who cannot communicate with the guest.

4. **Load balancing** -- Among equally eligible navigators, the one with the lowest ratio of active sessions to their capacity ceiling is chosen.

5. **No match** -- If no navigator is available, the session is created with status `unassigned` and enters a queue. The queue processor automatically retries assignment when a navigator's availability changes (e.g., a session is closed or a navigator updates their status).

**Two-layer architecture:**

Routing runs in two stages:
1. **Next.js layer** (`src/lib/routing.ts`) -- runs the full algorithm before calling Lambda. Fetches the navigator list and live session counts in parallel, picks the best navigator, and sends the chosen navigator's ID to Lambda.
2. **Lambda layer** (`backend/lambda/index.mjs`) -- if a valid `navigator_id` is provided, the Lambda uses it directly. If no pick is provided, the Lambda falls back to its own simpler algorithm.

**Important:** These two implementations can drift out of sync. See Known Bugs for details.

---

## Authentication & Role-Based Access Control

Authentication is handled by Auth0 using `@auth0/nextjs-auth0` v4. Three roles are supported:

| Role | Dashboard URL | Access |
|---|---|---|
| `user` (no role) | `/dashboard/user` | Open, no auth required |
| `navigator` | `/dashboard/navigator` | Auth required + `navigator` role |
| `supervisor` | `/dashboard/supervisor` | Auth required + `supervisor` role |

**How it works:**

1. **Auth0 Post-Login Action** -- A deployed Action injects the user's roles into both the ID token and access token under the custom claim `https://streetlives.app/roles`. This Action must not be removed or disabled.

```js
exports.onExecutePostLogin = async (event, api) => {
  const roles = event.authorization?.roles ?? [];
  api.idToken.setCustomClaim("https://streetlives.app/roles", roles);
  api.accessToken.setCustomClaim("https://streetlives.app/roles", roles);
};
```

2. **Next.js Middleware** (`src/middleware.ts`) -- Runs on every request to `/dashboard/navigator/*` and `/dashboard/supervisor/*`. Reads roles from the Auth0 session cookie and returns 403 if the role does not match the route. Unauthenticated users are redirected to the login page.

3. **Lambda-Side Enforcement** (`backend/lambda/index.mjs`) -- Reads the `https://streetlives.app/roles` claim from the JWT access token. `GET /sessions` returns all sessions for supervisors but only the navigator's own sessions for navigators.

4. **Navbar** (`src/components/Navbar.tsx`) -- Displays the appropriate dashboard link based on the user's role.

**Assigning roles:** Roles must be assigned manually in the Auth0 dashboard under User Management > Users > Roles. The role names must match exactly: `navigator` and `supervisor`. Users must log out and log back in after a role change for it to take effect.

**Key files:**

| File | Purpose |
|---|---|
| `src/lib/auth0.ts` | Auth0 client config; `beforeSessionSaved` hook preserves roles in session cookie |
| `src/middleware.ts` | Route guard for protected dashboard routes |
| `src/app/auth/signin/page.tsx` | Sign-in page (redirects to Auth0 hosted login) |
| `src/app/auth/signup/page.tsx` | Sign-up page (redirects to Auth0 hosted login) |
| `src/components/Navbar.tsx` | Displays correct dashboard link based on role |

---

## Matrix Chat Integration

User-navigator messages are transported via the Matrix protocol. A dedicated bot account manages all room creation, messaging, and membership on behalf of the application.

**How it works:**

- When a session is created, a private Matrix room is created for the conversation.
- The bot account logs into the Matrix homeserver using credentials stored in environment variables. The login token is cached so the bot does not need to re-authenticate after a restart.
- When a navigator is assigned, the bot invites them to the Matrix room. On transfer, the old navigator is removed and the new one is invited.
- Messages are formatted with role prefixes (e.g., `[Guest]: Hello`, `[Navigator Name]: Hi there`). The frontend parses these prefixes to determine message alignment and styling.
- Matrix failures are treated as non-fatal: if the homeserver is temporarily unreachable, session assignment still goes through.

**End-to-end encryption is intentionally not enabled.** Supervisors need to read message history for oversight, coaching, and quality assurance. E2E encryption would make messages unreadable to anyone except the two participants, which is incompatible with that requirement.

**Transport encryption (HTTPS/TLS) is in place** for all connections between the browser, Next.js, Lambda, and the Matrix homeserver.

**Key files:**

| File | Role |
|------|------|
| `backend/matrix-lambda/index.mjs` | Matrix Lambda: createRoom, sendMessage, fetchMessages, deleteRoom |
| `matrix-chat/backend/src/services/matrixAuth.ts` | Bot login, session management, token refresh |
| `matrix-chat/backend/src/services/matrixService.ts` | Matrix actions: createRoom, sendMessage, fetchRoomMessages, inviteToRoom, kickFromRoom |

---

## AWS Infrastructure

All resources are provisioned in the client's AWS account in `us-east-1`.

**VPC & Networking:**
- Custom VPC with public and private subnets across two availability zones.
- **Public subnet:** EC2 bastion host for terminal access to RDS.
- **Private subnets:** RDS PostgreSQL and `streetlives-vpc` Lambda.
- **VPC Endpoint:** Allows the VPC Lambda to invoke the Matrix Lambda without routing through the public internet.
- **Security groups:** RDS allows inbound PostgreSQL (port 5432) only from the VPC Lambda and the EC2 bastion.

**Lambda Functions:**

| Function | Location | Purpose |
|---|---|---|
| `streetlives-vpc` | Inside VPC (private subnet) | Main API: reads/writes RDS, invokes Matrix Lambda |
| `streetlives-matrix` | Outside VPC | All Matrix homeserver operations |

**API Gateway:**
- HTTP API fronts `streetlives-vpc` with a `/{proxy+}` route.
- CORS is handled in the Lambda response headers, not in API Gateway.

**EC2 Bastion:**
- A small EC2 instance in the public subnet used for running `psql` against RDS and debugging.
- An Elastic IP is assigned so the IP does not change on restart.
- **If this instance is stopped or terminated, you lose the only direct path into the database.**

**Important Note on JWT Validation:**
The VPC Lambda has no internet access (no NAT gateway). The Auth0 JWKS is stored as a Lambda environment variable (`AUTH0_JWKS`) rather than fetched at runtime. **If Auth0 rotates its signing keys, the Lambda will reject all tokens until `AUTH0_JWKS` is updated.** To refresh: fetch `https://<AUTH0_DOMAIN>/.well-known/jwks.json`, paste the full JSON into the `AUTH0_JWKS` env var in the Lambda console, and redeploy.

---

## Database Schema

**Engine:** PostgreSQL on RDS (private subnet, SSL required)
**Schema reference:** `migration.sql` in the repository root

### `navigator_profiles` Table

One row per navigator. The `auth0_user_id` column links the Auth0 identity to the database row.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID | Primary key |
| `auth0_user_id` | VARCHAR UNIQUE | Auth0 `sub` claim |
| `first_name` / `last_name` | VARCHAR | Set during onboarding |
| `nav_group` | VARCHAR | Organization affiliation |
| `capacity` | INT | Max concurrent sessions |
| `status` | VARCHAR | `available`, `away`, `offline` |
| `languages` | TEXT[] | e.g., `{english, spanish}` |
| `expertise_tags` | TEXT[] | Matches `need_category` values |
| `availability_schedule` | JSONB | `{ "Mon": { "start": "09:00", "end": "17:00" }, ... }` |
| `is_general_intake` | BOOLEAN | Whether to include in general routing |

### `sessions` Table

One row per chat session. Anonymous users are identified only by `session_user_token`.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID | Primary key |
| `matrix_room_id` | VARCHAR | Matrix room created at session start |
| `session_user_token` | VARCHAR | Random UUID; required for all guest API calls |
| `navigator_id` | UUID | FK to `navigator_profiles.id`; NULL if unassigned |
| `need_category` | VARCHAR | `housing`, `employment`, `health`, `benefits`, `youth_services`, `education`, `other` |
| `language` | VARCHAR | ISO 639-1 code (e.g., `es`) |
| `status` | VARCHAR | `unassigned`, `active`, `transferred`, `closed` |
| `routing_reason` | JSONB | Algorithm output at time of routing |
| `notes` | TEXT | Filled by navigator at close |
| `outcome` | TEXT[] | Filled by navigator at close |
| `follow_up_date` | DATE | Filled by navigator at close |
| `submitted_for_review` | BOOLEAN | Navigator marks session ready for supervisor |
| `approved` | BOOLEAN | Supervisor approval |
| `coaching_notes` | TEXT | Supervisor feedback |

### `session_events` Table

Immutable audit log. Every state change writes a new row; rows are never updated.

| `event_type` | Triggered By |
|---|---|
| `created` | Session starts |
| `assigned` | Navigator assigned (by routing or manually) |
| `transferred` | Session transferred to another navigator |
| `closed` | Session closed by navigator or user |

---

## Backend Lambda Endpoints

### `streetlives-vpc` -- Main API (`backend/lambda/index.mjs`)

**Guest endpoints (no auth; validated by `session_user_token`):**

| Method | Path | Description |
|---|---|---|
| `POST` | `/sessions` | Create session + Matrix room, run routing, insert to RDS |
| `GET` | `/sessions/:id` | Get session status (token required as query param) |
| `POST` | `/sessions/:id/messages` | User sends a message to Matrix room |
| `GET` | `/sessions/:id/messages` | Poll Matrix room messages |

**Authenticated endpoints (Auth0 JWT required):**

| Method | Path | Description |
|---|---|---|
| `GET` | `/sessions` | List sessions (supervisor = all; navigator = own) |
| `PATCH` | `/sessions/:id` | Update notes, outcome, submitted_for_review |
| `POST` | `/sessions/:id/close` | Close session |
| `POST` | `/sessions/:id/transfer` | Transfer to another navigator |
| `POST` | `/sessions/:id/approve` | Supervisor: save coaching_notes, set approved |
| `GET` | `/sessions/:id/events` | Fetch session audit log |
| `POST` | `/sessions/:id/navigator-messages` | Navigator sends a message |
| `GET` | `/navigators` | List all navigator profiles |
| `POST` | `/navigators` | Create a navigator profile |
| `GET` | `/navigators/:id` | Get a single navigator profile |
| `PATCH` | `/navigators/:id` | Update a navigator profile |

### `streetlives-matrix` -- Matrix Lambda (`backend/matrix-lambda/index.mjs`)

Invoked by the VPC Lambda via AWS `InvokeCommand` (not HTTP).

| Operation | Description |
|---|---|
| `createRoom` | Creates a private Matrix room for a session |
| `sendMessage` | Sends a message to a room on behalf of the bot |
| `fetchMessages` | Fetches up to 200 messages from a room |
| `deleteRoom` | Purges a room via Synapse Admin API |

---

## Next.js API Layer

The Next.js API routes (`src/app/api/`) act as a proxy between the browser and Lambda. They handle three concerns: attaching the Auth0 access token, hiding Lambda credentials from the client, and providing guest routes that use session tokens instead of auth.

**Authenticated routes:**

| File | Forwards To |
|---|---|
| `api/navigators/me/route.ts` | `GET /navigators` + filter by auth0_user_id; `PATCH /navigators/:id` |
| `api/navigators/route.ts` | `GET /navigators` |
| `api/sessions/[sessionId]/route.ts` | `GET`, `PATCH /sessions/:id` |
| `api/sessions/[sessionId]/transfer/route.ts` | `POST /sessions/:id/transfer` |
| `api/sessions/[sessionId]/approve/route.ts` | `POST /sessions/:id/approve` |
| `api/sessions/[sessionId]/events/route.ts` | `GET /sessions/:id/events` |
| `api/sessions/[sessionId]/close/route.ts` | `POST /sessions/:id/close` |

**Guest routes (no auth):**

| File | Forwards To |
|---|---|
| `api/guest/sessions/route.ts` | `POST /sessions` (create) |
| `api/guest/sessions/[sessionId]/route.ts` | `GET /sessions/:id` |
| `api/guest/sessions/[sessionId]/messages/route.ts` | `GET` / `POST /sessions/:id/messages` |
| `api/guest/navigators/[id]/route.ts` | `GET /navigators/:id` (returns name only) |

---

## Frontend File Structure

```
src/
  app/
    api/                              # Next.js API routes (Lambda proxy)
      navigators/                     # Navigator CRUD
      sessions/                       # Session CRUD, messages, events, actions
      guest/                          # Unauthenticated guest endpoints
    auth/
      signin/page.tsx                 # Sign-in (redirects to Auth0)
      signup/page.tsx                 # Sign-up (redirects to Auth0)
    dashboard/
      navigator/
        page.tsx                      # Navigator session list
        profile/page.tsx              # Navigator profile setup/edit
        [sessionId]/page.tsx          # Session detail + chat
        [sessionId]/chat/page.tsx     # Standalone chat view
      supervisor/
        page.tsx                      # Supervisor oversight dashboard
        [sessionId]/page.tsx          # Session detail + review actions
        [sessionId]/chat/page.tsx     # Read-only transcript
      user/
        page.tsx                      # User active session view
        [sessionId]/page.tsx          # User session transcript
    chat/page.tsx                     # Anonymous user chat interface
    layout.tsx                        # Root layout (Sonner + StoreSync)
    page.tsx                          # Public landing page
  components/
    DashboardPoller.tsx               # Polls router.refresh() every 30s
    NavigatorProfileForm.tsx          # Navigator profile form
    ShowMoreList.tsx                  # Expand/collapse list
    OverdueFlair.tsx                  # "Response overdue" badge (24h+)
    DeleteSessionButton.tsx           # Trash icon for session deletion
    StoreSync.tsx                     # Hydrates Zustand store on mount
    Navbar.tsx                        # Navigation bar with role-based links
  lib/
    auth0.ts                          # Auth0 client config + ROLES_CLAIM
    lambda.ts                         # lambdaFetch() server-only helper
    routing.ts                        # Client-side routing algorithm
    store.ts                          # Zustand store + types
    chatApi.ts                        # Client-side anonymous chat API
    utils.ts                          # Utility functions
    transferRequestStore.ts           # In-memory transfer request tracking
  middleware.ts                       # Auth0 + role-based route guard
```

**Key files to understand first:**

| File | Why |
|---|---|
| `src/middleware.ts` | Read this first to understand access control |
| `src/lib/lambda.ts` | Single place where Auth0 token injection happens |
| `src/lib/auth0.ts` | Auth0 config; the `ROLES_CLAIM` constant is used everywhere roles are read |
| `src/lib/store.ts` | Zustand store with all shared types; persists to localStorage under `streetlives-store-v10` |
| `src/app/dashboard/navigator/[sessionId]/page.tsx` | Most complex page (split-panel, polling, close flow, transfer, timeline) |

---

## Setup & Local Development

### Prerequisites

- Node.js 18+
- npm or yarn
- Access to the Auth0 tenant
- Access to the Lambda API URL

### Installation

```bash
git clone https://github.com/lijuliana/T4SG-Streetlives
cd t4sg-streetlives
npm install
```

### Environment Variables

Create `.env.local` in the project root:

```env
# Auth0
AUTH0_DOMAIN=dev-i2wpbc2253ciduoj.us.auth0.com
AUTH0_CLIENT_ID=<your-client-id>
AUTH0_CLIENT_SECRET=<your-client-secret>
AUTH0_SECRET=<32-byte-hex-string>   # Generate with: openssl rand -hex 32
AUTH0_AUDIENCE=https://streetlives.app/api
APP_BASE_URL=http://localhost:3000

# Lambda backend
NEXT_PUBLIC_API_URL=https://oni18c6q64.execute-api.us-east-1.amazonaws.com
```

`NEXT_PUBLIC_API_URL` is intentionally prefixed with `NEXT_PUBLIC_` so it is accessible client-side (used by `chatApi.ts` for anonymous chat). All other variables are server-only. **Do not put secrets in `NEXT_PUBLIC_` variables.**

### Running Locally

```bash
npm run dev
```

Visit `http://localhost:3000`. To verify:
- Landing page loads at `/`
- Anonymous chat accessible at `/chat`
- Login at `/auth/login` redirects to Auth0, then back to the appropriate dashboard

### Creating Test Accounts

1. Sign up via Auth0 on the site.
2. In the Auth0 dashboard, assign the `navigator` or `supervisor` role to the user under User Management > Users > Roles.
3. Log out and log back in. Roles are stored in the session token, which is only re-issued at login.

---

## Deploying Lambda Functions

Each Lambda function is deployed as a `.zip` file from its directory:

```bash
# VPC Lambda (main API)
cd backend/lambda
zip -r function.zip .
# Upload function.zip to the streetlives-vpc Lambda in the AWS console

# Matrix Lambda
cd backend/matrix-lambda
zip -r function.zip .
# Upload function.zip to the streetlives-matrix Lambda in the AWS console
```

### Lambda Environment Variables

**`streetlives-vpc` (required):**

| Variable | Description |
|---|---|
| `DB_HOST` | RDS endpoint |
| `DB_NAME` | Database name |
| `DB_USER` | Database username |
| `DB_PASSWORD` | Database password |
| `DB_PORT` | Database port |
| `AUTH0_DOMAIN` | Auth0 tenant domain |
| `AUTH0_AUDIENCE` | Must match Next.js `AUTH0_AUDIENCE` |
| `AUTH0_JWKS` | Full JWKS JSON (see JWT Validation section) |
| `MATRIX_LAMBDA_NAME` | `streetlives-matrix` |

**`streetlives-matrix` (required):**

| Variable | Description |
|---|---|
| `MATRIX_BASE_URL` | Matrix homeserver URL |
| `MATRIX_BOT_USER_ID` | Bot account user ID |
| `MATRIX_BOT_PASSWORD` | Bot account password |

`AWS_REGION` is set automatically by the Lambda runtime.

---

## Running Database Migrations

There is no direct public access to the RDS instance. All database access goes through the EC2 bastion host.

**Step 1 -- SSH into the bastion:**

```bash
ssh -i "/path/to/streetlives-bastion-key.pem" ec2-user@<BASTION_PUBLIC_IP>
```

**Step 2 -- Connect to RDS from inside the bastion:**

```bash
psql -h <RDS_ENDPOINT> -U postgres -d streetlives
# Enter the DB password when prompted
```

**Step 3 -- Make schema changes:**

```sql
-- The schema is already live. Run incremental ALTER TABLE statements.
-- Do NOT re-run migration.sql -- it will fail on already-existing tables.
```

`migration.sql` in the repository documents the full schema as it currently stands, for reference only.

---

## Credential & Ownership Transfer

The following items need to be transferred to the StreetLives team before go-live:

### Auth0 Tenant

The Auth0 tenant is fully configured and working but is currently owned by a T4SG SWE's personal account.

**To transfer ownership:**
1. Have the StreetLives team create an Auth0 account under their organization email.
2. In the Auth0 dashboard, go to Tenant Settings > Tenant Members and add the new account as an Admin.
3. Log in as the new admin and go to Tenant Settings > Danger Zone > Transfer Ownership.
4. The original owner can then be removed or kept as a member.

Everything in Auth0 (application, roles, post-login Action, API audience) is already configured. No recreation is needed.

### AWS / Database Credentials

The following will be shared securely:
- `streetlives-bastion-key.pem` (SSH key for the EC2 bastion)
- Database password
- Bastion public IP (Elastic IP assigned; static across restarts)
- All Lambda environment variable values

### Auth0 Callback URLs

When deploying to a new domain, update the callback and logout URLs in the Auth0 application settings to match the new domain.

---

## Known Bugs & Issues

### Return-to-Navigator Not Fully Implemented

The supervisor can click "Return to Navigator" with coaching notes, but the backend logic to revert the session status is not fully wired up. The session state in the database may not update correctly.

**Fix needed:** Ensure the return endpoint sets `status: "active"`, `submitted_for_review: false`, and saves `coaching_notes`.

### Delete Button Does Not Work

The trash icon on "Needs Review" sessions sends `DELETE /api/sessions/{id}`, but the Lambda does not implement the DELETE handler. The frontend code is correct.

**Fix needed:** Implement the DELETE handler in the Lambda.

### Sessions Not Flagged by Who Closed Them

There is no `closed_by` or `close_source` field. The frontend cannot distinguish between user-closed and navigator-closed sessions. All closed sessions appear in "Needs Review."

**Fix needed:** Add a `close_source` field (`"user"` or `"navigator"`) and set it at close time.

### Initial Message Load Is Slow (3-10 Seconds)

When opening a session for the first time, messages take several seconds to appear due to Lambda cold starts and the Matrix fetch. Messages are cached in localStorage after the first load, so subsequent opens are fast.

**Fix needed:** Cache recent messages in the database so the Lambda does not need to hit Matrix cold every time.

### Matching Algorithm Can Exceed Navigator Capacity

The routing algorithm can assign a session to a navigator who is already at their declared max capacity.

**Fix needed:** Add a capacity check before assigning. Queue the session if all navigators are at capacity.

### Referral Functionality Not Implemented

The `ReferralCard` and `ReferralForm` components exist, and the Zustand store has referral types, but referrals are not wired to the backend or displayed in session detail views.

**Fix needed:** Design the referral data model, add Lambda endpoints, and integrate into the session close flow.

### JWKS Rotation Breaks Authentication

**Impact: High.** Auth0 periodically rotates its signing keys. Since the JWKS is stored as a Lambda environment variable, key rotation causes all authenticated Lambda calls to return 401.

**Fix:** Fetch the new JWKS from `https://<AUTH0_DOMAIN>/.well-known/jwks.json`, update the `AUTH0_JWKS` environment variable in the Lambda console, and redeploy.

### Profile Completeness Gate Is Incomplete

The navigator dashboard redirects to profile setup only when no database row exists. A navigator with a partial profile (e.g., missing availability schedule) passes through but is silently excluded from routing.

**Fix needed:** Add an `isProfileComplete()` check and redirect if incomplete.

### Transfer Request Store Not Persistent

The `transferRequestStore` uses in-process memory (`globalThis`). On Vercel (serverless), each request can hit a different instance, so the "Transfer Requested" badge may not appear.

**Fix needed:** Persist the flag to the database as a column on the `sessions` table.

### Routing Algorithm Duplication

`backend/lambda/index.mjs` and `src/lib/routing.ts` implement the same routing logic independently and can drift out of sync.

**Fix needed:** Consolidate into a single implementation.

---

## Future Steps

### Immediate (Bug Fixes)

- Implement return-to-navigator backend logic
- Implement session delete in Lambda
- Add `close_source` field to session model

### Short-Term Features

- **Referral flow** -- complete the referral UI and wire it to the backend
- **Navigator availability toggle** -- button to set status to `away`/`offline` on the navigator dashboard
- **Navigator status management** -- auto-set to `offline` on logout or session expiry

### Medium-Term

- **Replace polling with real-time messaging** -- WebSocket or Server-Sent Events for messages and session updates
- **Pagination** for session lists (requires backend support)
- **Supervisor analytics** -- aggregate views for sessions per day, average response time, and category breakdown
- **Email/SMS notifications** -- notify navigators when a new session is assigned
- **JWKS auto-refresh** -- schedule a Lambda layer or cron to fetch the JWKS periodically, or add a NAT gateway to allow runtime fetching
- **Monitoring** -- set up CloudWatch alarms on Lambda error rate and RDS CPU
- **Navigator timezone support** -- add a timezone field to navigator profiles (the availability schedule currently uses the server's local time)

### Technical Debt

- The Zustand store (`store.ts`) contains many types and actions partially unused or duplicated with backend models. Consolidate once backend models are stable.
- `chatApi.ts` uses a different auth pattern (no token) than all other API calls. Unify under the same proxy pattern with a guest token.
- `mockData.ts` still exists and should be removed once confirmed unused.
- Multiple components define `Session` and `NavProfile` interfaces locally instead of importing from a shared types file. Consolidate into `src/lib/types.ts`.

### Testing Gaps

- Unit tests for utility functions (`cn`, `hasUnresponded24h`, language mapping)
- Integration tests for API routes (mock Lambda, test auth token injection)
- End-to-end tests (Playwright) for critical user journeys: user chat, navigator response, supervisor approval
