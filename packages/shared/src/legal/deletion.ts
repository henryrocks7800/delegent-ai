// Canonical "delete your account and data" copy for Delegent AI.
//
// This is the user-facing Data deletion page required by the Google Play Data
// Safety form ("provide a way for users to request that their data is
// deleted"). It is rendered client-side by the website and prerendered to a
// static /legal/delete.html so the URL https://delegentai.co.uk/legal/delete
// is publicly reachable without sign-in (Google's reviewer requirement).
//
// Reuses the {title, body[]} section shape shared with the privacy policy +
// terms. Retention figures here MUST stay consistent with the privacy policy
// (legal/privacy.ts sections 10-11).

export type DeletionSection = {
  readonly title: string;
  readonly body: readonly string[];
};

/**
 * How long a lapsed subscriber's workspace is kept before it is destroyed.
 *
 * Owned here because it is a PROMISE before it is a setting, and the promise
 * and the setting had drifted: the published copy said nothing about it at all
 * while the fleet ran on sixty days. The provisioner reads this constant, so
 * changing the retention now changes the sentence customers read in the same
 * commit, which is the only arrangement that stays true.
 */
export const DELEGENT_WORKSPACE_RETENTION_DAYS = 60;

/**
 * What "Export my data" hands over, said on the button rather than inferred
 * from the file.
 *
 * The bundle itself now carries the same limits in a `coverage` block, but
 * somebody deciding whether to press the button should not have to read a JSON
 * file to find out that their coworker's own memory is not in it.
 */
// Since 2026-09-23 the export carries what the coworker remembers (QA F39); it
// used to say "ask us", and nothing could produce it.
export const DELEGENT_EXPORT_SCOPE_NOTE =
  "A JSON file with your account, your chats as the app showed them, what your coworker remembers about you, your files and tasks, which services you connected, and your billing history.";

export const DELEGENT_DELETION_TITLE = 'Delete your Delegent AI account and data';
export const DELEGENT_DELETION_UPDATED = '29 July 2026';

export const DELEGENT_DELETION_INTRO =
  "This page explains how to ask Delegent AI (the company behind the Delegent AI app and AI coworker, registered in England and Wales under) to delete your account and the personal information we hold about you. You can do it from inside the app or by email, and you do not need an active subscription to do so.";

export const DELEGENT_DELETION_SECTIONS: readonly DeletionSection[] = [
  {
    title: 'How to request deletion',
    body: [
      "In the app or in the web app, open Profile and choose Delete my account. You will be asked to confirm, and the request is recorded straight away.",
      "Or email admin@example.com from the email address on your account (or, if you are writing from another address, tell us the email you signed up with). We may ask you to verify your identity before we act, to protect your account. Email works whether or not you still have the app installed and whether or not you can sign in.",
      "When we process the request we permanently delete your account, your conversations and your coworker's memory of you.",
    ],
  },
  {
    title: 'Subscriptions bought through Apple',
    body: [
      "If you subscribed on an iPhone or iPad, Apple takes the payment and Apple holds the subscription. We cannot cancel it for you, and deleting your Delegent AI account does not cancel it either, so you would keep being charged for something you can no longer use.",
      "Cancel it yourself first: on your iPhone or iPad, open Settings, tap your name, tap Subscriptions, choose Delegent AI and then Cancel Subscription. Once that is done, come back and delete your account.",
      "Subscriptions bought through our website or the Android app are ended by us when we process your deletion.",
    ],
  },
  {
    title: 'What is deleted',
    body: [
      "When your deletion request is processed, we erase the personal information we hold about you, including: your account and profile (email address, sign-in identifier, profile name and the name you gave your coworker); your chat history, prompts, attachments and voice messages; your coworker's memory of you; and the files and PDFs kept with your conversation.",
      "Our AI provider, OpenAI, keeps what it receives from your messages for no more than 30 days, to check for misuse, and then deletes it, whether or not you delete your account.",
      "Your authentication record is removed so the account can no longer be signed in to.",
    ],
  },
  {
    title: 'What we keep, and for how long',
    body: [
      "A small amount of information is retained only where the law requires it or to resolve disputes. Transaction and billing records (receipts, invoices, refund history) are kept for at least six years to meet UK tax and accounting obligations, even after your account is deleted. Security and audit logs are kept for up to twelve months. Where there is an active dispute, security incident or fraud investigation, we keep the minimum information needed until it is resolved, then delete it.",
      "We do not sell your personal information, and retained records are not used to rebuild your deleted account.",
      "If you cancel your subscription but do NOT delete your account, that is different: your conversations, your coworker's memory and your files stay with your account, so everything is still there if you come back. Delete your account if you want them gone.",
    ],
  },
  {
    title: 'How long deletion takes',
    body: [
      "Deleting from inside the app removes your sign-in immediately, so you cannot log back in from that moment, and erases your conversations, your coworker's memory and your files at the same moment.",
      "Requests made by email are actioned without undue delay once we have verified them, and always within 30 days.",
      "If a connected service is unreachable while we are disconnecting it, we keep trying afterwards rather than giving up. Your account is still removed on the timings above; the connection is dropped as soon as that service answers.",
    ],
  },
  {
    title: 'Export your data first',
    body: [
      "Account deletion is permanent and cannot be undone. If you want to keep anything, download it or ask us for a copy before you delete. You can also ask us for a copy of the personal information we hold (a subject access request) by emailing admin@example.com.",
    ],
  },
  {
    title: 'Contact and your rights',
    body: [
      "Deletion and data-protection requests: admin@example.com. General support: support@example.com. Registered office: Delegent AI, [registered office address]",
      "You also have the right to access, correct, restrict or object to our use of your personal information, and to complain to the UK Information Commissioner's Office (https://ico.org.uk). Full details are in our Privacy Policy at https://delegentai.co.uk/legal/privacy.",
    ],
  },
];
