# Handoff Documentation — BACKEND

Covers: Matrix service account bot, session endpoints, routing algorithm, navigator intake form, transfer requests, and encryption.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Code Implementation](#code-implementation)
   - [Matrix Service Account Bot](#1-matrix-service-account-bot)
   - [Session Endpoints](#2-session-endpoints)
   - [Routing Algorithm](#3-routing-algorithm)
   - [Queue Processor](#4-queue-processor)
   - [Navigator Intake Form](#5-navigator-intake-form)
   - [Transfer Requests](#6-transfer-requests)
   - [Encryption](#7-encryption)
3. [How to Run](#how-to-run)
4. [Possible Bugs](#possible-bugs)
5. [Next Steps](#next-steps)

---

## Architecture Overview

When a guest starts a chat, three things happen in sequence: a **chat session** is created in our backend, the **routing algorithm** picks the best available navigator, and a private **Matrix room** is created to carry the messages between the guest and navigator. Matrix is a real-time messaging protocol — think of it as the infrastructure that moves messages back and forth, similar to how email servers move email.

```
Guest / Navigator browser
        │
        ▼
  Next.js web app  (the main application)
        │
        ▼
  Lambda backend  (session data, navigator profiles, routing)
        │
        ▼
  Matrix homeserver  (message transport — rooms, invites, messages)
```

The application is the source of truth for all session and navigator data. Matrix is only used to carry the actual chat messages — if Matrix goes down, sessions and routing still work; only live messaging is affected.

---

## Code Implementation

### 1. Matrix Service Account Bot

**What it does:**
A dedicated "bot" account logs into the Matrix homeserver on behalf of the whole application. This means navigators don't need to be registered as Matrix users in the backend — the bot handles all room creation, messaging, and membership changes for every session.

**Files:**

| File | Role |
|------|------|
| [matrix-chat/backend/src/services/matrixAuth.ts](matrix-chat/backend/src/services/matrixAuth.ts) | Handles bot login, keeps the session alive, and automatically refreshes credentials before they expire |
| [matrix-chat/backend/src/services/matrixService.ts](matrix-chat/backend/src/services/matrixService.ts) | All Matrix actions: `createRoom`, `sendMessage`, `fetchRoomMessages`, `inviteToRoom`, `kickFromRoom` |
| [matrix-chat/backend/src/server.ts](matrix-chat/backend/src/server.ts) | Starts the bot session when the server boots |

**How it works:**

When the server starts, the bot logs into Matrix using a username and password stored in the environment config. The login token is saved to a local file (`.matrix-session.json`) so the bot doesn't need to log in again after a restart. The bot automatically refreshes its token before it expires, and if a token is ever rejected mid-request, it re-logs in and retries transparently.

Every time a guest session is assigned to a navigator, the bot invites that navigator's Matrix account to the private room. On transfer, it removes the old navigator and invites the new one. If any of these Matrix calls fail (e.g., the homeserver is temporarily unreachable), the session assignment still goes through — Matrix failures are treated as non-fatal.

**Key requirement:** Each navigator needs a pre-registered account on the Matrix homeserver. Their Matrix user ID (formatted like `@name:matrix.org`) is stored on their navigator profile and used for room invites.

---

### 2. Session Endpoints

**What it does:**
These endpoints manage the full lifecycle of a guest ↔ navigator chat session — from the moment a guest starts a chat to when it's closed or transferred. They also handle all message relay between the guest, navigator, and Matrix room.

**Files:**

| File | Role |
|------|------|
| [matrix-chat/backend/src/routes/sessions.ts](matrix-chat/backend/src/routes/sessions.ts) | All session endpoints |
| [matrix-chat/backend/src/services/sessionStore.ts](matrix-chat/backend/src/services/sessionStore.ts) | Stores session records in memory |
| [matrix-chat/backend/src/services/messageStore.ts](matrix-chat/backend/src/services/messageStore.ts) | Stores chat messages |
| [matrix-chat/backend/src/services/sessionEventStore.ts](matrix-chat/backend/src/services/sessionEventStore.ts) | Audit log — records every lifecycle event |
| [matrix-chat/backend/src/services/noteStore.ts](matrix-chat/backend/src/services/noteStore.ts) | Private notes navigators can attach to a session |
| [matrix-chat/backend/src/services/referralStore.ts](matrix-chat/backend/src/services/referralStore.ts) | Referrals attached to sessions |
| [src/app/api/guest/sessions/route.ts](src/app/api/guest/sessions/route.ts) | Guest session creation — runs routing and creates the session |

**Key endpoints:**

```
POST   /api/sessions                          Create a new session (triggers routing + Matrix room)
GET    /api/sessions/:id                      Get a session's current state
POST   /api/sessions/:id/close               Close a session
POST   /api/sessions/:id/transfer            Transfer to a different navigator
GET    /api/sessions/:id/events              Full audit log for the session
POST   /api/sessions/:id/messages            Guest sends a message
GET    /api/sessions/:id/messages            Fetch messages (polls Matrix for new ones)
POST   /api/sessions/:id/navigator-messages  Navigator sends a message
POST   /api/sessions/:id/notes               Add a private note
POST   /api/sessions/:id/referrals           Add a referral
```

**Session lifecycle events** (recorded to the audit log):

| Event | When it fires |
|-------|---------------|
| `created` | A new session is started |
| `assigned` | A navigator is matched to the session |
| `transferred` | The session is moved to a different navigator |
| `closed` | The session is ended |

**How messaging works:**
Every message — whether from the guest or navigator — is stored in the application and also sent to the Matrix room. Guest messages get a `[Guest]:` prefix in Matrix; navigator messages get a `[Name (Navigator)]:` prefix. This way, anyone viewing the Matrix room directly (e.g., via the Element app) sees clearly labeled messages. The app periodically checks the Matrix room for any new messages (throttled to once every 5 seconds per session) and imports them if they came from outside the dashboard.

---

### 3. Routing Algorithm

**What it does:**
When a guest starts a chat, the routing algorithm automatically selects the best available navigator. It factors in what the guest needs, what language they speak, which navigators are currently on shift, and how busy each navigator already is.

**Files:**

| File | Role |
|------|------|
| [src/lib/routing.ts](src/lib/routing.ts) | Core algorithm (`pickNavigator`) — runs on the Next.js side before the session is created |
| [src/app/api/guest/sessions/route.ts](src/app/api/guest/sessions/route.ts) | Calls the routing algorithm, fetches live load data, and sends the pick to the Lambda |
| [backend/lambda/index.mjs](backend/lambda/index.mjs) | VPC Lambda — receives the routing pick and creates the session in the database |

**Two-layer architecture:**

Routing runs in two stages to work around infrastructure constraints (the VPC Lambda has database access but the Next.js layer has richer context):

1. **Next.js layer** — runs the full algorithm before calling the Lambda. Fetches the navigator list and live active-session counts (`GET /sessions/load`) in parallel, then picks the best navigator. Sends the chosen navigator's ID to the Lambda as `navigator_id` in the request body.

2. **Lambda layer** — if a valid `navigator_id` is provided, the Lambda uses it directly (no independent routing). If Next.js sends no pick (no eligible navigator found), the Lambda falls back to its own simpler load-based algorithm before creating the session as `unassigned`.

**How the algorithm works:**

The algorithm filters and ranks navigators in this order:

1. **Availability check** — only navigators with status `available`, a configured schedule, and remaining session capacity are considered. A navigator with no schedule set is treated as having an incomplete profile and is skipped.

2. **PRIMARY tier** — if the guest has a specific need (e.g., housing, health), the algorithm looks for a navigator whose listed areas of expertise include that category. If a language was also requested, it further narrows to those who speak it. The least-busy matching navigator is assigned.

3. **FALLBACK tier** — if no specialist is available for the guest's need, any available navigator is eligible. Language is still enforced here as a hard requirement: if no one speaks the requested language, the session goes into a queue (`unassigned`) rather than being assigned to someone who can't communicate with the guest.

**Load balancing:**
Among any group of equally eligible navigators, the one with the lowest ratio of active sessions to their capacity ceiling is chosen. This distributes sessions evenly without any navigator being overloaded.

**What happens when no navigator is available:**
The session is created with status `unassigned` and enters a queue. The queue processor (see below) automatically retries assignment whenever a navigator's availability changes.

---

### 4. Queue Processor

**What it does:**
Automatically picks up queued sessions and assigns them as soon as a navigator becomes available — no manual intervention needed.

**File:** [matrix-chat/backend/src/services/queueProcessor.ts](matrix-chat/backend/src/services/queueProcessor.ts)

**When it runs:**
- When a session is closed (freeing up one of the navigator's slots)
- When a navigator updates their profile (e.g., changing their status to `available` or increasing their capacity)

Queued sessions are processed oldest-first so guests who have been waiting longest are served first. The same routing algorithm used at session creation is applied, so all the same rules (language, schedule, capacity, specialization) still apply.

---

### 5. Navigator Intake Form

**What it does:**
The form navigators complete when they first join the platform, and can update at any time. The information they enter directly controls which guest sessions they receive — it is the primary input to the routing algorithm.

**Files:**

| File | Role |
|------|------|
| [src/components/NavigatorProfileForm.tsx](src/components/NavigatorProfileForm.tsx) | The form UI |
| [src/app/dashboard/navigator/profile/page.tsx](src/app/dashboard/navigator/profile/page.tsx) | The profile settings page |
| [src/app/api/navigators/me/route.ts](src/app/api/navigators/me/route.ts) | Saves the navigator's profile (`PUT /api/navigators/me`) |

**Form fields and their effect on routing:**

| Field | Effect |
|-------|--------|
| First / Last name | Used as the display name in chat messages |
| Navigator group | Stored for analytics (CUNY PIN, Housing Works, DYCD, or custom) |
| Languages | Guests requesting a specific language are only matched to navigators who speak it |
| Areas of expertise | Determines which guests reach this navigator in the primary (specialist) tier |
| Max concurrent sessions | Hard cap — navigator is excluded from routing once this limit is reached |
| Availability schedule | Navigator is only eligible during their configured hours on each day |

**Important:** A navigator with no availability schedule set is treated as having an incomplete profile and will not receive any sessions until they fill it out.

---

### 6. Transfer Requests

**What it does:**
Allows a session to be moved from one navigator to another, either manually by a navigator/supervisor or automatically via the routing algorithm. Guests can also signal that they'd like a different navigator, which creates a flag for the navigator or supervisor to act on.

**Files:**

| File | Role |
|------|------|
| [matrix-chat/backend/src/routes/sessions.ts](matrix-chat/backend/src/routes/sessions.ts) | `POST /api/sessions/:id/transfer` — performs the transfer |
| [src/app/api/guest/sessions/[sessionId]/request-transfer/route.ts](src/app/api/guest/sessions/[sessionId]/request-transfer/route.ts) | Guest-side signal (`POST /api/guest/sessions/:id/request-transfer`) |
| [src/lib/transferRequestStore.ts](src/lib/transferRequestStore.ts) | Tracks which sessions have a pending guest transfer request |

**How transfers work:**

There are two ways to transfer a session:

- **Manual transfer** — a specific navigator is chosen. The system checks they are available and not already on this session, then moves the session to them.
- **Auto transfer** — no target is specified; the routing algorithm reruns and picks the best available navigator. In this mode, all available navigators are eligible (not just specialists), which gives more options than the initial assignment.

When a transfer completes:
- The departing navigator is removed from the Matrix room.
- The new navigator is invited to the Matrix room.
- A `transferred` event is written to the session's audit log, recording who it came from, who it went to, and whether it was manual or automatic.

**Guest transfer request:**
A guest can request a new navigator from the chat UI. This does not automatically transfer the session — it sets a flag (`transfer_requested`) that the navigator or supervisor dashboard can display. A human still makes the final decision to transfer.

---

### 7. Encryption

**Transport encryption (in place):** All messages are protected in transit by HTTPS/TLS. Every request between the guest's browser, the Next.js app, the Lambda backend, and the Matrix homeserver travels over an encrypted connection. This means messages cannot be intercepted over Wi-Fi or the internet — which is the protection level our clients require.

**End-to-end encryption (intentionally not enabled):** Matrix supports E2E encryption, but it is deliberately not used. Supervisors need to be able to read message history for oversight, coaching, and quality assurance. E2E encryption would make messages unreadable to anyone except the two participants, which is incompatible with that requirement. Disabling it is not a gap — it is a product decision.

**Who can read messages:** The bot account, any Matrix homeserver admin, navigators assigned to the room, and supervisors via the dashboard. Guests can only read their own session's messages.

---

## How to Run

From the repo root:

```bash
npm install
npm run dev
```

The app runs at `http://localhost:3000`.

---

## Possible Bugs

### Slow load time when opening the chat window

**Symptom:** When the chat window is opened, messages take several seconds to appear even if the conversation already has content.

**Reproduce:**
1. Create a session and exchange a few messages.
2. Close and re-open the chat window (or open it in a new tab).
3. The message list appears blank or stale for up to 5 seconds before populating.

**Root cause:** Each time the chat requests new messages via `GET /api/sessions/:id/messages`, it also checks the Matrix homeserver for any messages that came in from outside the dashboard. That check is rate-limited to once every 5 seconds per session to avoid overloading the homeserver. On first load, if another request recently fired, the check is skipped entirely and the round-trip to matrix.org adds further delay on top.

**Fix leads:**
- Replace polling with Matrix `/sync` (long-poll) so the server pushes new messages to the client as they arrive — this eliminates the delay entirely.
- As a quicker fix: return the locally stored messages immediately and run the Matrix sync in the background. The next poll picks up anything new. This at least removes the blank-screen experience on first open.

---

## Next Steps

1. **Persistent storage** — all session and navigator data currently lives in memory and is lost if the server restarts. Replacing the in-memory stores with a database (the store interfaces are already designed to make this swap straightforward) is the most critical step before production use.

2. **Navigator timezone support** — the availability schedule is evaluated in the server's local time. Navigators who set hours assuming their own timezone may be included or excluded from routing at the wrong times. Adding a timezone field to the navigator profile and intake form would fix this.

3. **Real-time messaging** — the chat UI currently polls for new messages on a 5-second interval. Switching to Matrix `/sync` (a long-poll connection that the server holds open until new messages arrive) would make the chat feel instant.

4. **Auto-reassign when a navigator goes offline** — if a navigator changes their status to `away` or `offline`, their active sessions are not automatically reassigned. A future update to the `PATCH /api/navigators/:id` handler could detect this and trigger reassignment.

5. **Surface the guest transfer request more prominently** — the flag exists and is tracked, but it should be clearly visible as a badge or alert on the navigator/supervisor dashboard so transfer requests don't get missed.

6. **Use navigator name instead of Matrix ID for message labels** — navigator messages in the chat are currently labeled using the navigator's Matrix username, which can look awkward (e.g., `@jane-doe:matrix.org` → `Jane Doe`). Since first and last name are already stored on the profile, those should be used directly.
