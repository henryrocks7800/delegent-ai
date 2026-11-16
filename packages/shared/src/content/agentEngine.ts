// What an account on the agent engine is offered and told.
//
// The agent engine (apps/agent) is the coworker for an account that has no
// per-user cloud computer. It works in the person's connected apps and a set of
// always-available everyday tools, makes PDFs, and remembers them, but it keeps
// no file store and runs nothing on a schedule. So the app shows these accounts
// one plan, a Chat-only shell, and help, FAQ and use-case copy that promises
// only what this engine does. Every other account sees the existing copy.
//
// Which engine an account is on comes from the Worker (GET /api/account/engine,
// apps/worker/src/agent-engine.ts). Plain data only, like the rest of content/.

import { CONNECTABLE_SERVICES, type ConnectableService } from '../connections.ts';
import type { FaqItem, HelpSection } from './help.ts';
import { MODEL_FAQ_ANSWER, MODEL_FAQ_QUESTION } from './modelClaim.ts';
import type { UseCaseCategory } from './skills.ts';

export type CoworkerEngine = 'agent' | 'runner';

/**
 * The one plan on the agent engine. The price a customer is charged is whatever
 * Stripe holds: the live £3.99 monthly price found by stripePriceLookupKey
 * (created 2026-09-15 on Alex's go, product "Delegent AI").
 */
export const AGENT_PLAN = {
  tierId: 'studio',
  /** What the app and Stripe call the plan (Alex, 2026-09-15: "Delegent AI" everywhere). */
  name: 'Delegent AI',
  priceGbpMonthly: 3.99,
  /**
   * The live Stripe price for this plan is found by this lookup key. A
   * subscription on it is recorded under tierId, so everything keyed by tier
   * keeps working, while the allowance and Talk come from this plan.
   */
  stripePriceLookupKey: 'delegent_assistant_monthly',
  freeTrialDays: 30,
  /** Marks a checkout that started the free month, as three_day_trial_2026_09 does for the workspace plans. */
  freeTrialOfferId: 'free_month_2026_09',
  talkMinutesMonthly: 15,
  /** Talk during the free month: nothing has been paid yet. */
  trialTalkMinutes: 5,
  /**
   * The monthly allowance, in billable tokens (see AGENT_USAGE). Set so a user
   * who uses every last bit of it, and all their Talk, costs no more than the
   * £3.99 they pay (Alex, 2026-09-15: "the worst case is I break even"). From
   * the published prices on 2026-09-15, the company not being VAT registered:
   *   £3.99
   *   - card fee, worst case (3.25% + 20p, a non-UK card)     £0.33
   *   - Talk, 15 minutes at the worst-case $0.069 a minute    £0.82
   *   - dictation and Cloudflare for a heavy user             £0.13
   *   = £2.71 for the model and app actions, less OpenRouter's 5.5% fee on
   *     credit = £2.57 = $3.25 at $1 = £0.79 = 16.26M billable tokens.
   * Rounded down. A typical everyday request is 10,000 to 16,000.
   */
  monthlyAllowanceTokens: 16_000_000,
  /**
   * The free month earns nothing, so it gets a quarter of the paid allowance:
   * still hundreds of requests, but a maxed-out trial costs under £1.
   */
  trialAllowanceTokens: 4_000_000,
} as const;

/**
 * How the agent engine meters usage. A billable token is $0.20 per million of
 * provider cost, the model's input price, so the allowance is a hard cost
 * ceiling whatever the mix of input, cached input and output. Each app action
 * adds Composio's $0.0003 a call. The Worker applies this in recordAgentUsage.
 */
export const AGENT_USAGE = {
  usdPerBillableToken: 0.2 / 1_000_000,
  billableTokensPerToolCall: 1_500,
  /** When a reply reports no cost: the previous model's price ratios ($0.02 cached, $1.20 output, per $0.20 input), kept after the
   *  2026-09-22 model change ($0.01, $0.50 per $0.10 input) because they count its tokens at twice their cost, never under. */
  fallbackCachedWeight: 0.1,
  fallbackOutputWeight: 6,
} as const;

/**
 * Top-ups, following what OpenAI and Google do (checked 2026-09-15): the
 * monthly allowance is used first and does not roll over; bought credit is
 * used after it and lasts 12 months. £1 buys what £1 costs us to serve after
 * the worst-case card fee (3.25% + 20p) and OpenRouter's 5.5%: £0.73 = $0.92 =
 * 4.6M billable tokens, rounded down to 4M. Several packs go through as one
 * payment, so the fixed 20p is paid once.
 */
export const AGENT_TOP_UP = {
  pricePence: 100,
  tokens: 4_000_000,
  validMonths: 12,
  maxPacksPerPurchase: 10,
} as const;

export function formatTopUpPrice(packs = 1): string {
  return `£${((AGENT_TOP_UP.pricePence * packs) / 100).toFixed(2)}`;
}

export function formatAgentPlanPrice(): string {
  return `£${AGENT_PLAN.priceGbpMonthly.toFixed(2)}`;
}

export const AGENT_PLAN_SUMMARY = 'Your connected AI coworker. Fast, private, and working in the apps you already use.';

export const AGENT_PLAN_PRICE_NOTE = 'One simple monthly price. No usage bills.';

export const AGENT_PLAN_TRIAL_CTA = 'Start your free month';

/**
 * What a new subscriber is asked to accept is a free month, not a price, so the
 * free month is what every surface leads with (Alex, 2026-09-22: installs were
 * not converting). The price still has to be plainly visible next to it, both
 * because it is honest and because Apple 3.1.2 and Google's subscription policy
 * require the renewal terms on the purchase screen. Lead with FREE, keep
 * `agentPlanThenLine` beside it, and keep the full terms line underneath.
 */
export const AGENT_PLAN_HEADLINE_OFFER = 'Free';
export const AGENT_PLAN_HEADLINE_PERIOD = 'first month';

export function agentPlanThenLine(): string {
  return `then ${formatAgentPlanPrice()} a month`;
}

export function agentFreeTrialTermsLine(): string {
  return `First month free, then ${formatAgentPlanPrice()} per month automatically. Cancel before the free month ends to avoid being charged. New subscribers only.`;
}

/** Connections the agent engine cannot use. FreeAgent is brokered natively for runners, not through Composio. */
export const AGENT_ENGINE_UNSUPPORTED_CONNECTIONS: readonly string[] = ['freeagent'];

export function agentConnectableServices(): readonly ConnectableService[] {
  return CONNECTABLE_SERVICES.filter((service) => !AGENT_ENGINE_UNSUPPORTED_CONNECTIONS.includes(service.id));
}

export type PlanHighlight = {
  /** Shown in bold. */
  readonly lead: string;
  readonly text: string;
};

/** "What you get" on the plan page and in Manage plan, strongest first. Every line is something the agent engine does today. */
export function agentPlanHighlights(): readonly PlanHighlight[] {
  const apps = agentConnectableServices().length;
  return [
    { lead: `${apps} apps, one coworker.`, text: 'Gmail, Outlook, Google Calendar, Drive, Slack, Notion, HubSpot, QuickBooks, Shopify and more.' },
    { lead: 'Your inbox, handled.', text: 'Reads, sorts and summarises your email, and drafts replies in your tone for you to approve.' },
    { lead: 'Travel, sorted.', text: 'Finds and compares flights, hotels and things to do, with prices and links to book.' },
    { lead: 'Documents in seconds.', text: 'Invoices, quotes, letters and itineraries as polished PDFs.' },
    { lead: 'Answers from the live web.', text: 'Search, news, maps, weather and price checks, with the sources.' },
    { lead: 'Your website and shop.', text: 'Updates your Webflow site for you to approve, and tells you what sold on Shopify.' },
    { lead: 'Remembers you.', text: 'Your preferences, the people you work with, and what you talked about before.' },
    { lead: 'Hands-free Talk.', text: `${AGENT_PLAN.talkMinutesMonthly} minutes of voice conversation a month.` },
  ];
}

export type EverydayTool = {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  /** Shown on a coloured tile, the way Skills shows its categories. */
  readonly emoji: string;
  /** The tile's background colour. */
  readonly tint: string;
  /** Sent to the chat when the person taps "Try it". */
  readonly prompt: string;
};

/**
 * Built into the agent engine, no sign-in needed (apps/agent/src/toolkits.ts
 * NO_AUTH_TOOLKITS). On Connections they are ordinary cards inside their
 * category, marked "Built in" instead of offering Connect (Alex, 2026-09-15:
 * extra things it can do are just more connections, not a separate block).
 */
export const AGENT_EVERYDAY_TOOLS: readonly EverydayTool[] = [
  { id: 'flights', title: 'Flights', detail: 'Compares fares and times for your dates, with links to book.', emoji: '\u{2708}\u{FE0F}', tint: '#E3EEF9', prompt: 'Find me flights from London to Edinburgh next Friday, coming back on Sunday.' },
  { id: 'hotels', title: 'Hotels', detail: 'Prices from the big booking sites side by side, through Trivago.', emoji: '\u{1F3E8}', tint: '#EFE8F7', prompt: 'Find me a well-reviewed hotel in central Manchester for next Saturday night, under £150.' },
  { id: 'things_to_do', title: 'Things to do', detail: 'Tours, events and days out, with links to book.', emoji: '\u{1F39F}\u{FE0F}', tint: '#FDEFE2', prompt: 'What are the best things to do in Edinburgh this weekend?' },
  // A town in the prompt: the engine has no location, so "near me" came back as a question.
  { id: 'places', title: 'Local places', detail: 'Local businesses, with opening hours, reviews and how to contact them.', emoji: '\u{1F4CD}', tint: '#E6F2E6', prompt: 'Find three well-reviewed plumbers in central Manchester and their opening hours.' },
  { id: 'shopping', title: 'Price checks', detail: 'Compares prices across shops before you buy.', emoji: '\u{1F3F7}\u{FE0F}', tint: '#FBE7EE', prompt: 'Compare prices for a good ergonomic office chair under £250.' },
  { id: 'web', title: 'Web search', detail: 'Live answers from the web, with the sources.', emoji: '\u{1F310}', tint: '#E2F3F5', prompt: 'What is the current VAT registration threshold in the UK?' },
  { id: 'news', title: 'News', detail: 'The latest headlines on anything you follow.', emoji: '\u{1F4F0}', tint: '#F1ECE4', prompt: 'What are the main UK business news stories today?' },
  { id: 'weather', title: 'Weather', detail: 'The forecast wherever you are headed.', emoji: '\u{26C5}', tint: '#FFF5DB', prompt: 'What is the weather forecast for London this weekend?' },
];

/** The badge a built-in card wears where an app card offers Connect. */
/**
 * Said once an assistant account's subscription is confirmed. There is no
 * workspace to build, so nothing about waiting: Alex saw "spinning up your
 * private workspace" after buying the coworker plan on iPhone (2026-09-16).
 */
export const AGENT_CHECKOUT_THANK_YOU = "You're on Delegent AI. Your coworker is ready, so say hello and give it something to do.";

export const AGENT_BUILT_IN_BADGE = 'Built in';

export const AGENT_CONNECTIONS_INTRO = 'Connect the apps you use and your coworker can work in them. Some things are built in and need no sign-in at all.';

export type AgentConnectionCategory = {
  readonly key: string;
  readonly emoji: string;
  /** The emoji tile's background colour. */
  readonly tint: string;
  readonly title: string;
  /** One line under the title on the collapsed row. */
  readonly hook: string;
  /** Connection ids from CONNECTABLE_SERVICES, in the order shown. */
  readonly services: readonly string[];
  /** AGENT_EVERYDAY_TOOLS ids, shown first as built-in cards. */
  readonly builtIn: readonly string[];
};

/**
 * Connections for an agent-engine account: collapsible categories in the style
 * of Skills, each holding its apps and any built-in tools. Every connectable
 * service and every built-in tool appears in exactly one category
 * (packages/shared/test/agent-engine-content.test.mjs).
 */
export const AGENT_CONNECTION_CATEGORIES: readonly AgentConnectionCategory[] = [
  { key: 'email', emoji: '\u{1F4E7}', tint: '#E3EEF9', title: 'Email', hook: 'Read, sort and reply to your email', services: ['gmail', 'microsoft_outlook', 'agent_mail'], builtIn: [] },
  { key: 'calendar', emoji: '\u{1F4C5}', tint: '#FDEFE2', title: 'Calendar and to-dos', hook: 'Your diary and your lists, kept straight', services: ['google_calendar', 'google_tasks'], builtIn: [] },
  { key: 'travel', emoji: '\u{1F9F3}', tint: '#E2F3F5', title: 'Travel', hook: 'Flights, hotels and days out, compared for you', services: [], builtIn: ['flights', 'hotels', 'things_to_do'] },
  { key: 'everyday', emoji: '\u{1F50E}', tint: '#FFF5DB', title: 'Search and everyday', hook: 'Live answers, news, weather, local places and prices', services: ['firecrawl'], builtIn: ['web', 'news', 'weather', 'places', 'shopping'] },
  { key: 'files', emoji: '\u{1F4C1}', tint: '#EFE8F7', title: 'Files and documents', hook: 'Find, read and save your documents', services: ['google_drive', 'dropbox', 'onedrive', 'google_docs', 'google_sheets', 'pdf_co'], builtIn: [] },
  { key: 'projects', emoji: '\u{2705}', tint: '#E6F2E6', title: 'Tasks and projects', hook: 'Boards, notes and projects kept moving', services: ['notion', 'trello', 'asana', 'clickup', 'jira', 'confluence'], builtIn: [] },
  { key: 'messages', emoji: '\u{1F4AC}', tint: '#E3EEF9', title: 'Messages and support', hook: 'Team chats and customer tickets', services: ['slack', 'microsoft_teams', 'zendesk', 'freshdesk'], builtIn: [] },
  { key: 'money', emoji: '\u{1F4B7}', tint: '#E6F2E6', title: 'Money and customers', hook: 'Accounts, payments and your sales contacts', services: ['quickbooks', 'stripe', 'hubspot', 'salesforce'], builtIn: [] },
  { key: 'website', emoji: '\u{1F3EA}', tint: '#FBE7EE', title: 'Website and shop', hook: 'Keep your site and your store up to date', services: ['shopify', 'webflow'], builtIn: [] },
  { key: 'social', emoji: '\u{1F4E3}', tint: '#FDEFE2', title: 'Social media', hook: 'Your posts, pages and channels', services: ['youtube', 'instagram', 'facebook', 'linkedin', 'reddit'], builtIn: [] },
  { key: 'design', emoji: '\u{1F3A8}', tint: '#EFE8F7', title: 'Design and code', hook: 'Your designs and code projects', services: ['figma', 'github'], builtIn: [] },
];

/**
 * The shared connection copy (connections.ts) speaks about "your coworker".
 * Until 2026-09-16 an agent-engine account read it as "assistant"; Alex then
 * chose "connected AI coworker" for every account, so this is the identity.
 * It stays as the one seam (the chat WebView's `say()` mirrors it) in case the
 * two engines ever need different words again.
 */
export function assistantWording(text: string): string {
  return text;
}

export const AGENT_HOWTO_TITLE = 'Getting the most from your coworker';

export const AGENT_HOWTO_INTRO =
  'A quick guide to your connected AI coworker: what to ask for, how to connect your apps, and how to get the most from it every day.';

/**
 * How an assistant account gets a copy of its data. It has no Export button
 * (Alex, 2026-09-15), but a copy is still the person's right under UK GDPR, so
 * the profile says how to ask: the same address the FAQ and the deletion page
 * give for data-protection requests.
 */
export const AGENT_DATA_COPY_NOTE =
  "Want a copy of your data, including your chats and what your coworker remembers about you? Email admin@example.com from this account's email address and we will send it to you.";

/**
 * The question before a top-up checkout opens. It starts straight away, which
 * is what gives up the 14-day right to cancel (terms, section 6). "A quarter"
 * is AGENT_TOP_UP.tokens against AGENT_PLAN.monthlyAllowanceTokens, and a test
 * holds the two numbers to it.
 */
export function agentTopUpConsentBody(validMonths: number = AGENT_TOP_UP.validMonths): string {
  return `Each top-up adds a quarter of the monthly allowance. It is added straight away, only used once your monthly allowance runs out, and lasts ${validMonths} months. Because it starts straight away, you give up the 14-day right to cancel it. You can choose how many on the next screen.`;
}

/**
 * The how-to guide, kept short on purpose: a line or two per section, because
 * people read it on a phone (Alex, 2026-09-15: "much more succinct"). What the
 * coworker cannot do sits here too, rather than behind a link to the website.
 */
export const AGENT_HOWTO_SECTIONS: readonly HelpSection[] = [
  {
    title: 'Just ask',
    body: [
      'Type it, tap the mic, or open Talk and say it. Plain English works: “sort out my inbox”, “find a hotel in York for Saturday”.',
    ],
  },
  {
    title: 'Everyday jobs',
    body: [
      'Emails, trips, price checks, finding a plumber, a complaint letter. Ask for a document and you get a PDF to download or send. For ideas, see Skills & use cases.',
    ],
  },
  {
    title: 'Built in',
    body: [
      'Flights, hotels, things to do, weather, news, local places, price checks and web search need no setup. It finds and compares; you make the booking.',
    ],
  },
  {
    title: 'Connect your apps',
    body: [
      'Menu, then Connections. Open a group, tap Connect and sign in on the app’s own website. Then just name it: “what is on my calendar tomorrow?”',
    ],
  },
  {
    title: 'It remembers you',
    body: [
      'Tell it your preferences once, like how you sign off emails. A fresh chat clears the screen, not its memory.',
    ],
  },
  {
    title: 'Talk (beta)',
    body: [
      // 2026-09-28 (Alex): live on Android, the relay orb on iPhone, beta on both.
      'In beta. On Android, talk with your coworker out loud: they hear you, do the work and answer, and it is all saved in the chat. On iPhone, Talk passes your request on.',
      `${AGENT_PLAN.talkMinutesMonthly} minutes a month (${AGENT_PLAN.trialTalkMinutes} in your free month). Answers are short, so check the chat for the full one. The mic button just types and does not count.`,
    ],
  },
  {
    title: 'Your allowance',
    body: [
      `Enough for hundreds of requests a month; see what is left under Manage plan. If you run out, top up from ${formatTopUpPrice()} (top-ups last ${AGENT_TOP_UP.validMonths} months) or wait for next month.`,
    ],
  },
  {
    title: 'You stay in control',
    body: [
      'Anything that sends, posts, deletes or spends waits for your yes. It never books or pays, and never asks for a password in the chat.',
      'It cannot run code, work on a schedule, make phone calls or click through websites, and it says so when a job needs one of those.',
    ],
  },
];

export const AGENT_FAQ_ORDERED: readonly FaqItem[] = [
  {
    question: 'What is Delegent AI?',
    answer:
      'Your connected AI coworker. It works in the apps you already use, like your email, calendar and documents, and takes everyday jobs off your hands: sorting your inbox, planning trips, comparing prices, writing letters and making documents. It remembers how you like things done.',
  },
  {
    question: MODEL_FAQ_QUESTION,
    answer: MODEL_FAQ_ANSWER,
  },
  {
    question: 'How much does it cost?',
    answer:
      `One plan: ${formatAgentPlanPrice()} a month, and your first month is free. It includes a generous monthly allowance and ${AGENT_PLAN.talkMinutesMonthly} minutes of hands-free Talk a month. If you ever need more, top up from ${formatTopUpPrice()}. Cancel any time.`,
  },
  {
    question: 'What can it help me with?',
    answer:
      'Everyday life and the admin nobody enjoys. Find money you may be owed in your inbox, clear and reply to email, plan a trip, find a tradesperson with good reviews, compare prices before you buy, write a complaint or an appeal, make an invoice or a quote, keep your calendar and lists straight, and look things up with the sources. Open Skills & use cases in the menu for more ideas.',
  },
  {
    question: 'How do I ask it to do something?',
    answer:
      'Open the chat and say what you need, in your own words. Attach anything useful, like a photo of a letter or a receipt, and it will ask if something is unclear.',
  },
  {
    question: 'Can it book flights and hotels?',
    answer:
      'It finds and compares flights, hotels and things to do for your dates, with prices and links to book. It never pays or books anything itself, so you always make the final booking.',
  },
  {
    question: 'How much can I use it?',
    answer:
      `Your plan includes a generous monthly allowance, enough for hundreds of requests. You can see what is left under Manage plan. If you do reach it, top up from ${formatTopUpPrice()} and carry on, or wait until your allowance refreshes at the start of your next billing month. Top-ups are only used once your monthly allowance runs out, and they last for ${AGENT_TOP_UP.validMonths} months. The free month comes with a smaller allowance.`,
  },
  {
    question: 'What is Talk?',
    answer:
      `Talk is a hands-free conversation, and it is in beta. On Android you talk with your coworker directly: they hear you, do the work and answer out loud, and the whole conversation is saved in the chat. On iPhone and iPad it passes your request to your coworker and the answer lands in the chat. Spoken answers are kept short, and in beta it can mishear or pause, so check the chat for the full answer. Your plan includes ${AGENT_PLAN.talkMinutesMonthly} minutes of Talk a month, or ${AGENT_PLAN.trialTalkMinutes} during your free month. The small mic button is different: it turns your words into a typed message.`,
  },
  {
    question: 'What are the cards that appear while it works?',
    answer: "Live progress in plain English, like 'Working on email' or 'Looking for hotels'. Tap a card to see the detail.",
  },
  {
    question: 'Can it learn how I like things done?',
    answer:
      'Yes. Tell it a preference, correct it once or give it an example, and it remembers the lasting details, like your name, the people you deal with and how you sign off your emails.',
  },
  {
    question: 'How is it different from other AI chat apps?',
    answer:
      'It is built around your own apps and everyday jobs. It works in your email, calendar and documents, finds travel and prices with the links, makes documents you can send, and remembers you, all for one simple monthly price.',
  },
  {
    question: 'Where do my files go?',
    answer:
      'Files and photos you send stay in the chat you sent them in, and PDFs your coworker makes come to you as a download link in the chat. There is no separate file store, so if you want something kept, ask it to save it to your Google Drive, Dropbox or OneDrive once one is connected.',
  },
  {
    question: 'Can I cancel? Is there a free month?',
    answer:
      'Yes, and you can do it yourself. Tap your picture in the top right corner, then Cancel subscription (on iPhone and iPad, Cancel or manage in the App Store), and confirm on the page it opens. Your first month is free, then the plan renews monthly unless you cancel: cancel before the free month ends to avoid being charged. Cancelling keeps your access until the end of the month you have paid for. Plans and top-ups are paid in advance and are not refundable except where the law says so; your UK statutory rights are unaffected.',
  },
  {
    question: 'Is my data private and secure?',
    answer:
      "Yes. Your conversation, your coworker's memory of you and the files you send are kept privately for your account, encrypted in transit, and never used to train AI models. Our AI provider, OpenAI, may keep a message for up to 30 days to check for misuse, then deletes it. App connections are held by our broker, Composio, never in the chat. Want a copy of your data, or your account deleted? Email admin@example.com from your registered address and we will handle it.",
  },
  {
    question: 'Will it ask before doing anything important?',
    answer:
      'When you have clearly asked for something, such as "email John that the meeting is at 3pm", it does it and tells you what it did. When it would be deciding for you, such as who to send to, what to write or what to delete, it shows you first and waits for your yes. Never share passwords or card details in the chat; it will show you the safe way to connect things.',
  },
  {
    question: 'Do I need to set anything up?',
    answer:
      'Hardly anything. Travel, web search, news, the weather, local places and price checks work straight away. To use your own apps, open Connections in the menu, tap a group and connect the app by signing in on its own website.',
  },
  {
    question: 'Can it use my email?',
    answer:
      "Yes. Open Connections, tap Email and connect Gmail or Outlook, signing in on Google's or Microsoft's own site. Your coworker can then find money you may be owed, read your mail, tell you what needs you and draft replies. Nothing is sent until you have read it and said yes. If you would rather keep your own inbox out of it, connect AgentMail and your coworker gets an email address of its own.",
  },
  {
    question: 'How do I find money I might be owed?',
    answer:
      'In the app, open Connections, tap Email and connect Gmail or Outlook. Then say "find money I might be owed in my inbox". Your coworker reads the emails that look relevant, never spam, drafts or sent mail, and within about 15 minutes posts a report: flight compensation you may be able to claim, refunds promised but never paid, upgrades or subscriptions charged twice, and the subscriptions you are paying for. It only reports; nothing is sent, moved or changed. You can run it up to three times a day, and ask it to draft the claim or cancellation for anything it finds.',
  },
  {
    question: 'Can I send files, photos or voice notes?',
    answer:
      'Yes. In the chat, use the paperclip to attach a file or photo, the camera to snap a picture, the mic to speak a message, or Talk for a hands-free conversation. Your coworker reads what you send right there in the chat.',
  },
  {
    question: 'What if I close the app while it is working?',
    answer:
      'The job keeps going. The finished answer is waiting in the chat when you come back, and you get a notification if you have them switched on.',
  },
  {
    question: 'Something not working, or want a new feature?',
    answer:
      "Open the menu and tap Help & suggestions to report a problem or suggest something, and it goes straight to the team. Or email support@example.com.",
  },
];

/**
 * Skills & use cases for an agent-engine account: everyday life and admin, not
 * a business role (Alex, 2026-09-15). Every line is held to the connection
 * capabilities in connections.ts and the engine's built-in tools.
 */
export function agentUseCaseCategories(): readonly UseCaseCategory[] {
  return [
    {
      key: 'email',
      emoji: '\u{1F4E7}',
      tint: '#E3EEF9',
      title: 'Inbox & messages',
      hook: 'Get on top of your email without the slog.',
      useItTo: 'find money you may be owed in your Gmail or Outlook, sort and summarise your inbox, draft replies in your own tone for you to approve, catch up on Slack and Teams, and give your coworker an email address of its own with AgentMail.',
      lead: 'Your inbox, handled.',
      skills: [
        { name: 'Find money you may be owed', desc: 'Say "find money I might be owed in my inbox" and it checks for flight compensation, refunds that never came, double charges and forgotten subscriptions, then reports what it found.' },
        { name: 'Inbox sorting', desc: 'Reads your Gmail or Outlook, tells you what needs you and summarises the rest.' },
        { name: 'Replies in your tone', desc: 'Drafts replies the way you write, and sends only when you say yes.' },
        { name: 'Its own inbox', desc: 'Connect AgentMail and your coworker gets an email address of its own, separate from yours.' },
        { name: 'Team chat', desc: 'Catches you up on Slack or Teams, and posts for you when you ask.' },
      ],
    },
    {
      key: 'travel',
      emoji: '\u{1F9F3}',
      tint: '#E2F3F5',
      title: 'Travel & days out',
      hook: 'Trips planned in minutes, not evenings.',
      useItTo: 'find and compare flights and hotels for your dates, plan things to do, check the forecast where you are going, and turn the plan into a tidy itinerary PDF. None of it needs a connection.',
      lead: 'Holidays, weekends away and work trips, sorted.',
      skills: [
        { name: 'Flights', desc: 'Compares fares and times for your dates, with links to book.' },
        { name: 'Hotels', desc: 'Finds places to stay across the booking sites, with prices and reviews.' },
        { name: 'Things to do', desc: 'Tours, events and days out wherever you are going.' },
        { name: 'Itineraries', desc: 'Pulls your plans into one tidy PDF to keep or share.' },
      ],
    },
    {
      key: 'life',
      emoji: '\u{1F3E0}',
      tint: '#FDEFE2',
      title: 'Life admin',
      hook: 'The boring jobs, done for you.',
      useItTo: 'write letters and complaints, compare prices before you buy, find local tradespeople with good reviews and their opening hours, and keep your calendar and to-do lists straight.',
      lead: 'The little jobs that pile up, taken care of.',
      skills: [
        { name: 'Letters & complaints', desc: 'Drafts refund requests, parking appeals and letters to your landlord or the council, ready to send.' },
        { name: 'Price checks', desc: 'Compares prices across shops so you pay less.' },
        { name: 'Local services', desc: 'Finds plumbers, dentists and garages in your area, with reviews and opening hours.' },
        { name: 'Calendar & to-dos', desc: 'Checks your Google Calendar and keeps your Google Tasks lists up to date.' },
      ],
    },
    {
      key: 'docs',
      emoji: '\u{1F4C4}',
      tint: '#EFE8F7',
      title: 'Documents & paperwork',
      hook: 'Paperwork, sorted.',
      useItTo: 'make polished PDFs like invoices, quotes and letters, read the PDFs, receipts and photos you send, write in Google Docs, keep Google Sheets up to date, and save files to your Drive, Dropbox or OneDrive.',
      lead: 'Documents written, read and filed for you.',
      skills: [
        { name: 'PDFs & photos', desc: 'Makes polished PDFs, like invoices, quotes and letters, and reads the PDFs, receipts and photos you send.' },
        { name: 'Docs & Sheets', desc: 'Writes in Google Docs, and reads and updates your Google Sheets.' },
        { name: 'Saving files', desc: 'Puts documents into your Google Drive, Dropbox or OneDrive.' },
      ],
    },
    {
      key: 'money',
      emoji: '\u{1F4B7}',
      tint: '#E6F2E6',
      title: 'Money & bills',
      hook: 'Keep on top of money in and money out.',
      useItTo: 'find money you may be owed in your inbox, see who owes you and who you owe in QuickBooks, check what came in through Stripe, chase unpaid invoices by email, and make sense of the bills and receipts you send.',
      lead: 'Your money admin, without the spreadsheets.',
      skills: [
        { name: 'Money in your inbox', desc: 'With Gmail or Outlook connected, finds flight compensation, missing refunds, double charges and forgotten subscriptions, and can draft the claim.' },
        { name: 'Bookkeeping', desc: 'Tells you who owes you and who you owe from your live QuickBooks balances, and looks up customers and suppliers.' },
        { name: 'Payments', desc: 'Tells you what came in through Stripe.' },
        { name: 'Invoice chasing', desc: 'Drafts polite reminders for unpaid invoices, sent when you approve.' },
        { name: 'Bills & receipts', desc: 'Reads the bills and receipts you photograph and explains what they say.' },
      ],
    },
    {
      key: 'research',
      emoji: '\u{1F50E}',
      tint: '#FFF5DB',
      title: 'Answers & research',
      hook: 'Live answers, with the sources.',
      useItTo: 'look things up on the live web with the links, catch up on the news, check rules and figures that change, and weigh up options before you decide.',
      lead: 'Real answers from the live web, not guesswork.',
      skills: [
        { name: 'Web research', desc: 'Searches the live web and tells you what it found, with the links.' },
        { name: 'News', desc: 'The latest headlines on anything you follow.' },
        { name: 'Rules & figures', desc: 'Checks things that change, like tax thresholds and opening hours, and shows where it found them.' },
        { name: 'Weather', desc: 'The forecast wherever you are headed.' },
      ],
    },
    {
      key: 'work',
      emoji: '\u{1F4BC}',
      tint: '#FBE7EE',
      title: 'Work & side hustle',
      hook: 'The business side, without the busywork.',
      useItTo: 'update your Webflow site, see what sold on Shopify, keep Notion, Trello or Asana boards moving, look after leads in HubSpot or Salesforce, answer support tickets, and draft social posts.',
      lead: 'Run the business side of things with less effort.',
      skills: [
        { name: 'Website & shop', desc: 'Updates your Webflow site for you to approve, and tells you what sold on Shopify.' },
        { name: 'Projects', desc: 'Keeps your Notion, Trello, Asana, ClickUp or Jira up to date.' },
        { name: 'Customers', desc: 'Tracks leads and deals in HubSpot or Salesforce, and drafts replies to support tickets.' },
        { name: 'Social posts', desc: 'Drafts posts for LinkedIn, Instagram and Facebook, and publishes only once you say yes.' },
      ],
    },
  ];
}
