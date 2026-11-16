// Canonical "Skills & use cases" copy: the categories the app offers and the
// phrase that starts each one.
//
// This lives in @sidekick/shared for the same reason as ./help.ts and ./legal/*.
// It was declared inline in apps/mobile/App.tsx, so the web app had no way to
// render it, and the shared how-to guide told every web user to "Open Skills &
// use cases in this menu" for a screen that did not exist there.
//
// Plain data only: no JSX, no platform imports. Each surface owns its own
// presentation.

export type CategorySkill = {
  readonly name: string;
  readonly desc: string;
};

export type UseCaseCategory = {
  readonly key: string;
  readonly emoji: string;
  readonly title: string;
  /** One line under the title on the collapsed row. */
  readonly hook: string;
  /** The "Use it to ..." summary shown when the row expands. */
  readonly useItTo: string;
  /** Short intro on the category detail page. */
  readonly lead: string;
  /** De-emphasised (the technical category). */
  readonly muted?: boolean;
  /** Background for the emoji tile. Unset draws the accent tint. */
  readonly tint?: string;
  /** The spotlighted specialities, 3 to 5 of them. */
  readonly skills: readonly CategorySkill[];
};

export const DELEGENT_USE_CASE_CATEGORIES: readonly UseCaseCategory[] = [
  {
    key: 'money',
    emoji: '\u{1F4B7}',
    title: 'Money & bookkeeping',
    hook: 'Keep the books straight without lifting a finger.',
    useItTo: 'log receipts, reconcile expenses, prep VAT and year-end, chase unpaid invoices, and see your cashflow at a glance. Connect FreeAgent, QuickBooks, Stripe or Shopify and it works on your real numbers.',
    lead: 'Bookkeeping and money admin, handled for you.',
    skills: [
      { name: 'Bookkeeper', desc: 'Logs receipts, reconciles expenses and drafts your VAT and year-end, straight from FreeAgent or QuickBooks.' },
      { name: 'Invoice chasing', desc: 'Politely follows up unpaid invoices so you get paid sooner.' },
      { name: 'Cashflow view', desc: 'A simple picture of money in and out, with a forecast.' },
      { name: 'Payments and sales', desc: 'Tells you what came in through Stripe and what sold on Shopify.' },
    ],
  },
  {
    key: 'email',
    emoji: '\u{1F4E7}',
    title: 'Email & messages',
    hook: 'Handle the inbox so you can stay on the tools.',
    useItTo: 'give your coworker its own email address, work your Gmail or Outlook, run customer support, and keep up with Slack and Teams.',
    lead: 'An inbox that runs itself.',
    skills: [
      { name: 'Its own inbox', desc: 'Connect AgentMail and your coworker gets an email address of its own, separate from yours.' },
      { name: 'Your inbox', desc: 'Connect Gmail or Outlook and it triages, summarises and drafts replies for you to approve.' },
      { name: 'Customer support', desc: 'Works your Zendesk or Freshdesk tickets and drafts replies in your voice.' },
      { name: 'Team chat', desc: 'Catches you up on Slack or Teams and posts for you when you ask.' },
    ],
  },
  {
    key: 'sales',
    emoji: '\u{1F4C8}',
    title: 'Sales & marketing',
    hook: 'Win more work and keep your name out there.',
    useItTo: 'track leads and deals in HubSpot or Salesforce, research prospects, and plan and post your social content.',
    lead: 'Find leads, win work, and keep your marketing ticking.',
    skills: [
      { name: 'Sales pipeline', desc: 'Tracks your leads and deals in HubSpot or Salesforce so nothing goes cold.' },
      { name: 'Lead research', desc: 'Researches prospects properly using live web pages, not guesswork.' },
      { name: 'Social & content', desc: 'Plans and drafts posts for LinkedIn, Instagram, Facebook, YouTube and Reddit.' },
    ],
  },
  {
    key: 'docs',
    emoji: '\u{1F4C4}',
    title: 'Documents & office',
    hook: 'Turn rough notes into finished paperwork.',
    useItTo: 'create PDFs, spreadsheets and reports, analyse data, fill in forms, and work on the files in your Drive, Dropbox or OneDrive.',
    lead: 'The office documents, built from a few notes.',
    skills: [
      { name: 'PDFs & forms', desc: 'Creates polished PDFs, fills in ones you already have, and converts or reads them through PDF.co.' },
      { name: 'Spreadsheets', desc: 'A tidy Google Sheet or Excel file with the formulas and charts done for you.' },
      { name: 'Reports & analysis', desc: 'Written reports in Google Docs, and a clear read on your data.' },
      { name: 'Your files', desc: 'Finds and organises what is in your Google Drive, Dropbox or OneDrive.' },
    ],
  },
  {
    key: 'ops',
    emoji: '\u{1F4BC}',
    title: 'Operations & admin',
    hook: 'Run the day to day so nothing slips.',
    useItTo: 'keep your tasks, projects, calendar and notes in order across Trello, Asana, ClickUp, Jira, Notion and Google.',
    lead: 'The admin that keeps a business moving.',
    skills: [
      { name: 'Tasks & projects', desc: 'Keeps Trello, Asana, ClickUp or Jira up to date, and tells you what is actually due.' },
      { name: 'Your calendar', desc: 'Reads your Google or Outlook diary and tells you what is coming.' },
      { name: 'Notes & wiki', desc: 'Finds and writes up what you need in Notion or Confluence.' },
    ],
  },
  {
    key: 'web',
    emoji: '\u{1F310}',
    title: 'Web, files & storage',
    hook: 'Look after your website and keep track of what is out there.',
    useItTo: 'build or update your website, read and research the web properly, look at your designs, and keep an eye on your code.',
    lead: 'Your website and the web, handled.',
    skills: [
      { name: 'Website', desc: 'Builds or updates your site, including Webflow content. Preview first, publish only when you approve.' },
      { name: 'Web research', desc: 'Reads and crawls real pages through Firecrawl, then tells you what they say.' },
      { name: 'Design files', desc: 'Reads your Figma files and comments, and leaves a comment when you ask.' },
      { name: 'Your code', desc: 'Looks through your GitHub repositories, issues and pull requests.' },
    ],
  },
  {
    key: 'phone',
    emoji: '\u{260E}\u{FE0F}',
    title: 'Phone',
    hook: 'A number that answers itself.',
    useItTo: 'set up a phone line and a receptionist that takes calls, messages and bookings for you.',
    lead: 'Give your business a phone line that answers for you.',
    skills: [
      { name: 'Phone concierge', desc: 'A business number with a receptionist that handles calls, messages and bookings.' },
    ],
  },
];
