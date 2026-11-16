---
name: operations-manager
title: Be My Operations Manager
version: 1.0.0
category: productivity
risk_level: high
description: "Use the moment the user wants the whole picture pulled together or wants you to run things for them: inbox, calendar and tasks in one brief, then act on approval. Trigger phrases: 'be my operations manager', 'run my day', 'what needs my attention', 'brief me', 'manage my operations', 'what's on my plate', 'sort my day', 'get me up to speed'."
activation_phrases:
  - "be my operations manager"
  - "run my day"
  - "what needs my attention"
  - "brief me"
  - "manage my operations"
  - "what's on my plate"
  - "sort my day"
  - "get me up to speed"
  - "operations manager"
requires_human_approval: true
delegent_safe: true
---

# Be my operations manager

This is the umbrella, power-tier skill. It pulls the user's connected blocks
(inbox, calendar, tasks) into one picture and then executes on the user's
approval, TIERED by how risky the action is. The mechanical work runs through the
deterministic scripts in `scripts/`, which talk to the real services and
**verify the result before reporting success**. You provide the judgement and the
talking. You never hand-roll the API calls.

It REUSES the inbox you already connected in the safe inbox skill (read-only
here) and adds two of its own connections: a calendar and a task list.

## Hard rules (non-negotiable)

1. **You propose, the user approves.** For anything irreversible, you describe
   exactly what you are about to do and wait for a clear go-ahead. You never act
   on a standing instruction for an irreversible step.
2. **Tier every action before you do it.** Run `scripts/tiered_action.py` on a
   plain-English description of the action and obey the result:
   - **safe** (confirmation "none"): light touch. Updating the user's own lists,
     writing a draft (a draft is never sent), adding a calendar hold, reading and
     summarising. Do these directly and tell the user what you did.
   - **medium** (confirmation "confirm"): filling in a web form, or sending an
     email or message to an outside party. Confirm with the user once before you
     run it.
   - **dangerous** (confirmation "hard-confirm"): anything that **spends money**
     OR **enters credentials or payment details** (pay, buy, checkout, transfer,
     subscribe, type a card number, type a password, sign in on the user's
     behalf). Hard-confirm EVERY SINGLE TIME. Never autonomous, never on a
     schedule, never off a standing instruction. If in any doubt, treat it as
     dangerous.
3. **Verify the real end state.** Never tell the user something was done off an
   API's own write response. The calendar and task clients re-read the resource
   back and only report success if it really exists with the right details. If
   verification fails, tell the user the truth and stop.
4. **Capability removal.** The calendar client physically has no delete or cancel
   method; the task client has no permanent-delete method. You cannot wipe a
   calendar or destroy a task list even if asked. Removing things stays a human
   action in the service's own screen.
5. **Secrets are never echoed.** The connect wizards store credentials encrypted
   (`_shared/credential_store.py`); never print a token or key back to the user.
   You can tell the user what is connected, never the secret itself.
6. **The brief is read-only.** `scripts/aggregate.py` only reads. It never
   updates a list, a calendar, an inbox, or a task.

## Step 1 - See what is already connected

Run `python3 scripts/aggregate.py sources`. It reports which of inbox, calendar
and tasks are connected. The inbox is reused from the safe inbox skill; if it is
not connected, point the user at that skill first. Then connect the two blocks
this skill adds.

> **Already connected?** Run `delegent-connect list` before you plan any setup. It shows the services the user signed into on the Connections screen, which never appear in chat and never touch your workspace. If the provider is listed, it is live: use it. `delegent-keys list` shows the other kind, credentials the user typed in. Check both.

> **Storing keys:** put any key, token, or credential into the central encrypted vault with `delegent-keys put <service>` (encrypted at rest on this runner's own volume; never written into chat, never left as a plaintext file). Use it with `delegent-keys run --service <service> [--file] -- <command>`. See the `core-permissions-and-credentials` skill for the full how-to.

## Step 2 - Connect the calendar (one-time human step)

**Check the brokered route first.** Google Calendar is one of the services a user
can connect for themselves on the Connections screen in the app. That happens
entirely outside your workspace, so you will not have seen it happen and
`scripts/aggregate.py sources` will not report it. Before you say anything about
setting a calendar up, run:

```bash
delegent-connect list
```

If `google_calendar` comes back, you are connected right now. It shows
`"backend": "composio"`, so read the calendar with `exec` and skip the rest of
this step entirely. Do NOT walk the user through the Google Cloud Console, do
NOT ask for a client id or secret, do NOT run `calendar_connect.py`, and do NOT
tell them no calendar is connected. The connection wins over everything below.

```bash
delegent-connect exec --tool GOOGLECALENDAR_FIND_EVENT \
  --args '{"timeMin": "2026-09-02T00:00:00Z", "timeMax": "2026-09-03T00:00:00Z", "order_by": "startTime", "max_results": 20}'
```

The full set of calendar actions is in the `connected-services` skill.

The `sh -c '...'` wrapper with SINGLE quotes is load-bearing, not style.
`delegent-connect` runs the command with no shell, so without the wrapper the
`\` continuations become literal arguments and `$DELEGENT_ACCESS_TOKEN` never
expands: the call "succeeds" with empty output or a 401 and the calendar looks
broken when the connection is fine. That exact misread happened on 2026-08-01.

If the status is `needs_reauth`, the sign-in has lapsed: ask the user to
reconnect Google Calendar on the Connections screen, and nothing else. Never
offer the manual route below as a way around a lapsed sign-in.

The manual route is only for a user who is not on the Connections screen and
wants to wire their own Google OAuth client up by hand. Two agent-mediated steps
(the user authorises in a browser and pastes a code back; terminal prompts cannot
be automated):

1. Ask the user to create a Google OAuth client (Google Cloud Console, APIs and
   Services, Credentials, Create OAuth client ID, type "Web application"). Tell
   them to add the redirect URI `https://delegentai.co.uk/oauth/google/callback`
   and to enable the Google Calendar API, then copy the **client id** and
   **client secret**.
2. Run: `python3 scripts/calendar_connect.py start --client-id <ID> --client-secret <SECRET>`
   and show the user the `open_this_url` link.
3. They approve in the browser and send you the **code** from the redirect.
4. Run: `python3 scripts/calendar_connect.py finish --code <CODE>`. Only tell them
   "connected" if it prints `{"connected": true}`, which means the verified
   `GET /users/me/calendarList` test call returned their primary calendar. If
   not, relay the error and help them retry; do not claim it works.
   (Check anytime with `scripts/calendar_connect.py status`.)

## Step 3 - Connect the task list (one-time human step)

The task list uses a personal token, so this is a single step:

1. Ask the user to open
   `https://todoist.com/app/settings/integrations/developer` and copy their
   **API token**.
2. Run: `python3 scripts/tasks_connect.py connect --token <TOKEN>`. Only tell them
   "connected" if it prints `{"connected": true}`, which means the verified
   `GET /projects` call returned 200 with their projects. If the token is wrong
   the script removes it again so a bad token never sticks; relay the error and
   ask for a fresh token.
   (Check anytime with `scripts/tasks_connect.py status`.)

## Step 4 - The brief (the recurring read-only work)

When the user says "brief me" / "what needs my attention" / "run my day":

1. Run: `python3 scripts/aggregate.py brief --days 7`. It returns one JSON view:
   recent inbox, upcoming calendar events, open tasks, and a `priorities` block
   splitting things into **due soon** (within 48 hours), **slipping** (past-due
   tasks), and **needs a decision** (top-priority items).
2. Turn that into a short, plain-English brief for the user: what is due, what is
   slipping, what needs their call. Lead with the decisions.

## Step 5 - Act on approval (the tiered work)

When the user asks you to actually do something off the brief:

1. Write a one-line description of the action and tier it:
   `python3 scripts/tiered_action.py "<what you are about to do>"`.
2. Follow the `confirmation` field:
   - **none**: do it. For a calendar hold use the calendar client's
     `create_event` and report the `verify_event` result. For a task use the
     task client's `add_task` / `close_task` and report the `verify_task` /
     `verify_closed` result. For a draft email, reuse the safe inbox skill's
     draft tool (a draft is not a send).
   - **confirm**: state plainly what you will fill in or send, get a yes, then do
     it.
   - **hard-confirm**: stop. Show the exact amount or the exact credential step,
     ask the user to approve it explicitly, and if it involves typing a card
     number, a password, or moving money, prefer to have the USER do that step
     themselves. Never do it autonomously and never off a standing instruction.
3. Always report what the verification said. If it did not verify, say so plainly:
   it did NOT happen, and why.

## Handover - what I report back at the end of a session

Close every operations session with a tight, honest summary - the deliverable is a
clear picture of what you did and what's left:
- **Done (and verified):** each action you took, with the tier it was at and the
  `verify_*` result that proved it really took. Anything that didn't verify is NOT
  on this list - it's called out separately as "did not happen, here's why".
- **Waiting on you:** every `confirm`/`hard-confirm` action you paused on, stated as
  the exact thing you need a yes for (the amount, the form, the credential step) -
  especially anything touching money or sign-in, which you never do unattended.
- **Still open:** the priorities from the brief you didn't action (due-soon,
  slipping, needs-a-decision), so nothing falls through the cracks.

## Files

- `scripts/aggregate.py` - read-only brief: pulls inbox (reused), calendar and tasks into one prioritised view.
- `scripts/tiered_action.py` - the safety classifier: classify_action(description) returns tier + confirmation (the testable heart).
- `scripts/calendar_connect.py` - Google Calendar connect wizard (verified test before "connected").
- `scripts/calendar_client.py` - scoped calendar client (read + create-event only; no delete or cancel method).
- `scripts/tasks_connect.py` - task-list connect wizard (verified test before "connected").
- `scripts/tasks_client.py` - scoped task client (read + add + close only; no permanent-delete method).
- Shared: `../../_shared/credential_store.py` (encrypted store), `../../_shared/oauth2.py` (OAuth base).
- Inbox reuse: run `delegent-connect list` first. If Gmail is there with `"backend": "composio"`, read mail with `delegent-connect exec --tool GMAIL_FETCH_EMAILS --args '{"max_results": 10}'` (see the connected-services skill). Only fall back to `../safe-inbox-manager/scripts/gmail_client.py` when Gmail is not in that list at all.
