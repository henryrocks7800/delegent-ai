---
name: core-time-awareness
title: Knowing The Time (dates, clocks and timezones)
version: 1.0.0
category: core
risk_level: low
description: "Apply whenever you are about to state a time, date, deadline, or schedule: check the real clock first, use the user's own timezone, and never quote a time that has already passed. Load this for every task that touches 'now', 'today', 'when', a due date, or a scheduled run."
activation_phrases:
  - "what time is it"
  - "what is the date today"
  - "which timezone"
  - "set my timezone"
  - "when does this run"
  - "how long until"
  - "is it too late"
  - "remind me at"
  - "schedule this for"
requires_human_approval: false
delegent_safe: true
---

# Knowing The Time (dates, clocks and timezones)

Getting the time wrong is a small mistake that reads as a big one: quoting a
deadline that already passed, or telling a UK user their reminder is at "09:00
UTC", makes you look like you are guessing. This skill is the discipline you apply
every time you are about to say anything about time. It is not a big workflow, it
is four habits you always keep.

## When to use this skill

Use it before you say anything that involves a clock or a calendar: the current
time or date, "now", "today", "tomorrow", "in an hour", a deadline, "the next
run", how long until something, or when a scheduled task will fire. If a sentence
you are about to send contains a time or a date, this applies.

## The four rules (always)

1. **Check the real clock before you state a time.** Run `date` in your terminal
   first and read a time or date off THAT, never off memory, the training data, or
   an earlier turn. The current date is also given to you at the start of each
   message; use it, but for anything to the minute (a schedule, "is it too late",
   the next run of a task) run `date` so you are exact.
2. **Use the user's timezone, and remember it for the session.** When the user
   tells you their timezone or location (or you can see it, for example a UK user),
   convert every time you show into THAT local time and keep using it for the rest
   of the conversation. Save it to memory so you do not have to ask again next
   time. If you genuinely do not know it yet, ask once, briefly, then remember the
   answer.
3. **Never quote a time that has already passed.** Before you say "the next run is
   at 09:00" or "your slot is 14:30", compare it against the real current time from
   rule 1. If that time is already in the past, roll to the next real occurrence
   (the next day for a daily task, the next slot, and so on) and quote that
   instead. A "next" time must always be in the future.
4. **Show local time, not UTC, unless they ask.** Talk to the user in their own
   local time with a clear label (for example "09:00 (your local time)" or "09:00
   BST"). Do not surface raw UTC, offsets, or "Z" timestamps in chat unless the
   user specifically asks for UTC or is clearly working in it. Keep UTC for the
   plumbing (cron expressions, logs); keep the chat human.

## Working with scheduled tasks and cron

A cron schedule is stored in one timezone (often UTC on the box). When you tell
the user when a scheduled task will next fire, do the conversion: compute the next
fire time, express it in the user's local time per rule 4, and sanity-check it is
in the future per rule 3. If you set or change a schedule, tell the user the next
run in their local time and, only if useful, note the underlying cron in brackets.

## Intake questions

Ask only if you actually need it:

- What timezone or country are you in (only if you do not already know)?
- For a schedule: what local time should it run, and how often?

## Execution playbook

1. Notice you are about to state a time or date.
2. Run `date` and read the real current time.
3. Recall or ask the user's timezone; convert into their local time.
4. If you are quoting a "next" or future time, confirm it is actually in the
   future; if not, advance it to the next real occurrence.
5. Say the time in local terms with a clear label; keep UTC out of the chat unless
   asked.
6. If the timezone was new, save it to memory for next time.

## Verification checklist

Before you send a message that mentions a time or date, verify:

- The time came from the real clock (`date` or the message's current date), not a
  guess.
- It is expressed in the user's local timezone with a clear label.
- Any "next" or future time is genuinely in the future, not already passed.
- No raw UTC or offset is shown in chat unless the user asked for it.

## Handover template

```text
What I did:
- Stated / scheduled: <the time or date>, in <user's timezone>.

Evidence:
- Real current time from `date`: <value>. Next occurrence: <value> (future-checked).

Files / systems touched:
- <none, or the schedule/task you set>

What still needs your approval:
- <none, or confirm the schedule>

Next recommended step:
- <e.g. confirm the local time works for you>
```

## Related skills

- operations-manager
- new-user-onboarding-coach
