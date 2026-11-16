// Canonical in-product help copy: the how-to guide and the FAQ.
//
// This lives in @sidekick/shared so the mobile app and the web app render the
// same words from one edit. Same reasoning as ./legal/* — the copy used to be
// declared inline in apps/mobile/App.tsx, which meant any second surface would
// start as a copy and drift the moment one of them was corrected.
//
// Plain data only: no JSX, no platform imports. Each surface owns its own
// presentation.

import { WEB_APP_DEVICES_ANSWER, WEB_APP_DISPLAY_URL } from './webApp.ts';
import { MODEL_FAQ_ANSWER, MODEL_FAQ_QUESTION } from './modelClaim.ts';

export type HelpSection = {
  readonly title: string;
  readonly body: readonly string[];
};

export type FaqItem = {
  readonly question: string;
  readonly answer: string;
};

export const DELEGENT_HOWTO_TITLE = 'Getting the most from your coworker';

export const DELEGENT_HOWTO_INTRO =
  'A quick guide to working with your AI coworker: how to hand over tasks, find what it can do, and help it learn your business.';

export const DELEGENT_HOWTO_SECTIONS: readonly HelpSection[] = [
  {
    title: 'The core workflow',
    body: [
      'Tap the voice orb and just talk, the way you would to a new colleague. Say what you want done in plain English, no special phrases needed.',
      'Your coworker writes the task into the chat as a clear written record, then goes to work in the background. Bigger jobs take a few minutes, so you can keep chatting or close the app while it works.',
      'When it finishes it tells you out loud and drops the full result into the chat. Anything it creates, like documents, spreadsheets and drafts, lands in the Files drawer ready to open, share or download.',
    ],
  },
  {
    // Deliberately a SHARED section rather than a card one surface renders.
    // It started as a phone-only card, on the reasoning that telling a browser
    // reader to open a browser reads wrong, and that reasoning produced exactly
    // the drift it was meant to avoid: the guide said different things in the
    // app and on the web. Worded so it is true and useful on either one.
    title: 'Phone, computer, or both',
    body: [
      `Your coworker is not tied to one device. The Delegent AI app on your phone and the web app at ${WEB_APP_DISPLAY_URL} are the same coworker, with the same files, the same memory and the same conversation. You sign in the same way on either one.`,
      'Most people use both. The phone is the quickest way to hand something over while you are out, and the browser is the easier place to read a long document, upload a batch of files, or type a detailed brief. Start something at your desk and the reply is waiting in your pocket.',
    ],
  },
  {
    title: 'Finding and using skills',
    body: [
      'Your coworker has trained specialities, from bookkeeping and customer support to website updates and reports. Open “Skills & use cases” in this menu to see what it can take on.',
      'There is no phrase to memorise. Ask for what you want in your own words, and name the service if you are using one: “what came in on Stripe this week”, “put this on my Trello board”, “read my Gmail”. Naming a service is what tells it to use your connection rather than working from scratch.',
      'Not sure how something works? Just ask. Say “walk me through how you chase invoices” and it will explain the steps before doing anything.',
    ],
  },
  {
    title: 'Treat it like a new hire',
    body: [
      'Your coworker gets better the more it knows about your business, so give it a little patience at the start, just as you would a new team member.',
      'Upload your business manuals, price lists and templates so it works to your standards. Tell it your do’s and don’ts, like “always CC me before sending” or “never discount below ten percent”.',
      'Share your preferences and it remembers them. Over time it needs less hand-holding and handles more on its own.',
    ],
  },
  {
    title: 'How Talk works (beta)',
    body: [
      // 2026-09-28 (Alex): Talk is a live conversation with the coworker on
      // Android, still the relay orb on iPhone, and labelled beta on both.
      'Talk is in beta. On Android, the Talk button starts a live conversation with your coworker: say what you need, and your coworker hears you, does the work and answers out loud, thinking with the same model as the chat. Spoken answers are kept short, and every word of the conversation is saved in the chat, full answers included.',
      'On iPhone and iPad, Talk is a lighter hands-free assistant for now: it listens, passes your request to your coworker, and the result arrives in the chat.',
      'While it is in beta, Talk can mishear, pause or cut out. For anything detailed or important the chat is the better place, and the small mic button next to the message box dictates your words straight into it, exactly like typing them.',
    ],
  },
  {
    title: 'Routines that run on a schedule',
    body: [
      'Anything you ask for regularly can run on its own. Open “Routines” in this menu, write the request exactly the way you would say it in chat, then choose how often it should run, hourly, daily or weekly, and the time of day.',
      'There are ready-made starters to load and edit: a morning brief, a weekly review, an end-of-day wrap-up, and an inbox summary. Change the wording so it fits your business rather than leaving it generic.',
      'Each run lands in your chat like any other reply, so you can read it in your own time. Pause a routine while you are away and switch it back on later, or delete it outright. Times follow the clock on your phone, so a nine in the morning routine stays at nine in the morning when the clocks change.',
    ],
  },
  {
    title: 'Connecting your tools',
    body: [
      'Open “Connections” in this menu to link the services you already use: Gmail, Outlook, Google Calendar, Drive, Sheets and Docs, Slack, Teams, Dropbox, OneDrive, Notion, Trello, Asana, Jira, HubSpot, Salesforce, Stripe, QuickBooks, FreeAgent and more.',
      'Connecting is one tap. You sign in on the provider’s own website, in your own browser, so we never see your password. Before you do, the card tells you in plain English what your coworker will be able to do and what the risk is. A handful of services offer no sign-in for apps like this, and those ask you to paste a key from your own account into the connection page instead, never into the chat.',
      'We do not hold the connection ourselves. It is held encrypted by our broker, Composio, and never sits in your chat or on your phone. Disconnect from the same screen at any time, and you can also withdraw access in the provider’s own settings.',
      'Once something is connected, just name it: “read my Gmail”, “what is on my calendar”, “what sold on Shopify”. If it is not connected yet, your coworker says so and points you at this screen rather than guessing.',
    ],
  },
  {
    title: 'Where you’ll need to step in',
    body: [
      'Your coworker does the work, but a few things always need you, by design and for your safety. Anything that spends money, signs you up to something, or acts as you in person comes back for your approval first. Your coworker gets it ready; you give the final yes.',
      'Connecting an outside tool is one tap on the Connections screen, and the sign-in is yours to do, at that service’s own website. Your coworker cannot create an account for you, and it will never ask you to type a password into the chat. If anything ever does, that is not us and you should not.',
      'Some platforms also limit what any outside assistant is allowed to touch. Where that happens, your coworker will tell you and suggest the best way round it, but it cannot override another company’s rules.',
    ],
  },
];

export const DELEGENT_HOWTO_DEEPER_TITLE = 'Want to go deeper?';

export const DELEGENT_HOWTO_DEEPER_BODY =
  'For a plain-English explainer of how your coworker actually works, what an API key is, and exactly where its limits sit, read the fuller guides on our website.';

export const DELEGENT_HOWTO_DEEPER_LABEL = 'Understanding your coworker';

export const DELEGENT_HOWTO_DEEPER_URL = 'https://delegentai.co.uk/guides/how-it-works';

export const DELEGENT_FAQ_ITEMS: readonly FaqItem[] = [
  {
    question: 'What is Delegent AI?',
    answer:
      "An AI coworker for your business, at a fraction of the cost of hiring. They work from their own private cloud computer: admin, bookkeeping, documents, research, your website, and more, and they learn how you like things done.",
  },
  {
    question: MODEL_FAQ_QUESTION,
    answer: MODEL_FAQ_ANSWER,
  },
  {
    question: 'How do I give them a task?',
    answer:
      "Open the chat and say what you need, in your own words. Attach anything useful, add any rules, and they'll ask if something is unclear.",
  },
  {
    question: 'How do I talk instead of type?',
    // The mic is ANDROID-ONLY today. Its audio module cannot be built for
    // Apple devices yet, so on iPhone and iPad the button is hidden rather
    // than shown and broken (2026-08-13). Saying so here stops an iPhone user
    // hunting for a control that is deliberately absent, and points them at
    // Talk, which does work everywhere and is the better tool for speaking
    // at length anyway.
    answer:
      'On Android, tap the microphone next to the message box, speak, and tap it again. Your words appear in the box, ready to send. ' +
      'On iPhone and iPad the microphone is not available yet, so you will not see it. Use the Talk button instead: it is hands-free, ' +
      'works on every device, and passes what you say to your coworker for you. Typing works everywhere, of course.',
  },
  {
    question: 'Can I use this on my computer?',
    answer:
      `Yes. The web app at ${WEB_APP_DISPLAY_URL} runs in any browser on a laptop or desktop, and you sign in the way you ` +
      'always do. It is the same coworker with the same files and the same conversation, so anything you start on your phone ' +
      'is waiting for you at your desk.',
  },
  {
    question: 'What are the cards that appear while they work?',
    answer:
      "Live progress in plain English: 'Searching your files', 'Writing a document'. Tap any card to see the full detail underneath.",
  },
  {
    question: 'What are skills?',
    answer:
      "Trained specialities. Open Skills & use cases in the menu, say the phrase (like 'be my accountant'), and your coworker steps into that role. Your own words work too.",
  },
  {
    question: 'Can they learn how I work?',
    answer:
      "Yes. Correct them once, give an example, or save a repeatable routine and they keep it for next time. Tone, signatures, and workflows included.",
  },
  {
    question: 'Can I set work to happen automatically?',
    answer:
      "Yes. Open Routines in the menu, write the request in your own words, then choose hourly, daily or weekly and the time it should run. There are ready-made starters to edit, like a morning brief or a weekly review. Each run arrives in your chat like any other reply, and you can pause or delete a routine whenever you like.",
  },
  {
    question: 'How is this different from ChatGPT?',
    answer:
      "ChatGPT chats; your Delegent coworker works. They have their own cloud computer where they run tools, keep files, and pick tasks back up where you left off.",
  },
  {
    question: 'Where do my files go?',
    answer:
      "Everything they create lives in their private cloud space. Open or download it from the Files tab.",
  },
  {
    question: 'How much can they handle?',
    answer:
      "Roughly 460 involved tasks a month on Studio, 800 on Pro, and 1200 on Max, where an involved task is a real multi-step job. Quick questions barely touch your allowance. Watch usage on the Monthly capacity page.",
  },
  {
    question: "What's the difference between the plans?",
    answer:
      "Every plan is the same full coworker. Higher plans add more cloud compute and a bigger monthly allowance, nothing else. Change plan any time from Profile; upgrades are prorated.",
  },
  {
    question: 'What if I run low on capacity?',
    answer:
      "You'll see a warning first, and tasks pause if you run out. Upgrade any time, or wait for your next cycle. Unused capacity doesn't roll over.",
  },
  {
    question: 'Can I cancel? Is there a trial?',
    answer:
      "Yes, and you can do it yourself without contacting us. The button sits underneath your current plan on the Manage plan screen. To get there in the phone app, tap your avatar in the top right corner and then Manage plan; in the web app, open Profile and then Manage plan. In the phone app the same button is also on your profile screen. It is named for what it does: Cancel subscription on Android, Cancel or manage billing in the web app, and Cancel or manage in the App Store on iPhone and iPad. On Android and the web it opens the billing portal, where you confirm the cancellation. On iPhone and iPad it opens your App Store subscription settings, because Apple handles cancellations for anything bought through the App Store; you can also reach those from Settings, your name, then Subscriptions. Any free-trial or introductory offer you are eligible for is shown at checkout, with the regular monthly price and renewal terms. A free trial renews into a monthly paid subscription unless you cancel: cancel before the trial ends on Android and the web, and at least 24 hours before it ends on iPhone and iPad. If a trial expires without a successful payment, access stops. Cancelling renewal of a paid subscription preserves access through the period already paid for. We keep your files for a short grace window afterwards, so download anything you want to keep. Plans are billed in advance and are generally non-refundable except where the law requires it; your UK statutory rights are unaffected.",
  },
  {
    question: 'Is my data private and secure?',
    answer:
      "Yes. Your workspace is isolated and hosted in London, encrypted in transit, and never used to train shared models. Need a copy of your data, or want your account deleted? Email admin@example.com from your registered address and we'll handle it.",
  },
  {
    question: 'Will they ask before doing sensitive things?',
    answer:
      "Yes. Payments, sign-ins, and anything that needs you in person come back to you for approval. Don't share passwords or personal financial details in chat; they'll show you the safer way to connect things.",
  },
  {
    question: 'Do I need to set anything up to connect my own tools?',
    answer:
      "Barely. Open Connections in the menu, pick the service, and sign in on its own website. That is the whole setup for almost everything, including Gmail, Outlook, Calendar, Drive, Slack, Teams, Notion, Trello, Stripe and QuickBooks. A few services offer no sign-in for apps like this, and those ask you to paste a key from your own account into the connection page, never into the chat. Your coworker can't create accounts or sign in as you, and anything that spends money or acts as you always comes back for your approval. Some platforms also limit what any assistant can access, which is outside our control.",
  },
  {
    question: 'Can my coworker use my email?',
    answer:
      "Yes. Open Connections in the menu and connect Gmail or Microsoft Outlook, signing in on Google's or Microsoft's own site. Your coworker can then read your mail, tell you what needs you, and draft replies. Nothing is sent without you reading it first and saying so. If you would rather keep your own inbox out of it, connect AgentMail instead and your coworker gets an email address of its own. Disconnect from the same screen at any time.",
  },
  {
    question: 'How do I manage my files?',
    answer:
      "Open the Files tab. Tap a file to preview it, and the expanded card has Rename, Delete, and Download to phone. To act on several files at once, press and hold any file, tick the ones you want, then use Select all or Delete at the top. Deleting always asks you to confirm first.",
  },
  {
    question: 'Can I send files, photos, or voice notes?',
    answer:
      "Yes. In chat, use the paperclip to attach files or photos, the camera button to snap a picture, or the microphone for a live voice conversation. You can also add files directly with the Upload button in the Files tab, and everything lands in your coworker's workspace.",
  },
  {
    question: 'What happens while my coworker works on something long?',
    answer:
      "You'll see live progress in the reply: short plain-English updates about what they're doing, plus progress lines as files get written. Longer jobs keep running even if you close the app, and the finished result is waiting in the chat when you come back.",
  },
  {
    question: 'Something not working, or want a new feature?',
    answer:
      "Open the menu and tap Help & suggestions. Report what's not working, or suggest a feature you'd love, either way it goes straight to the team. Or email support@example.com.",
  },
  {
    question: 'Which devices are supported?',
    answer: WEB_APP_DEVICES_ANSWER,
  },
];

// Feature FAQ entries with staged visibility. Voice mode GA'd 2026-07-16, so
// its entry shows for everyone (leading the list); the Telegram entry stays
// pilot-only until the bot rename, so the public FAQ never promises a feature
// an account can't see yet.
export const DELEGENT_FEATURE_FAQ_ITEMS: readonly FaqItem[] = [
  {
    question: 'What is Voice mode?',
    // 2026-09-28 (Alex): live on Android, the relay orb on iPhone, beta on both.
    answer:
      "Talk, the button with the sound bars, is in beta. On Android it is a live conversation with your coworker, who hears you, does the work and answers out loud, and the whole conversation is saved in the chat. On iPhone and iPad it is a lighter hands-free assistant that passes your request on to your coworker. In beta it can mishear or pause, so the chat is the place for the full answer. It is different from the small mic button, which speaks a message straight into the chat, exactly like typing it.",
  },
  {
    question: 'Can I use it from Telegram?',
    answer:
      "Yes. Say 'connect telegram' in chat and follow the card. Once linked, messaging the bot reaches exactly the same coworker: same workspace, same history, same monthly allowance.",
  },
];

// The order every surface renders: Voice mode leads, Telegram closes.
export const DELEGENT_FAQ_ORDERED: readonly FaqItem[] = [
  DELEGENT_FEATURE_FAQ_ITEMS[0],
  ...DELEGENT_FAQ_ITEMS,
  DELEGENT_FEATURE_FAQ_ITEMS[1],
];
