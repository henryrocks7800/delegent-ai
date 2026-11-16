/**
 * The Composio toolkits the product offers on the Connections screen, and the
 * auth config behind each. A copy of COMPOSIO_TOOLKITS in
 * apps/worker/src/composio.ts (slug and auth config only), kept identical by
 * test/toolkits.test.ts, so the agent sees exactly the apps the user connected
 * there. Composio's user id is the Supabase user id on both sides.
 */
export const PRODUCT_TOOLKITS: ReadonlyArray<{ slug: string; authConfigId: string }> = [
  { slug: 'gmail', authConfigId: 'ac_yJvbuQWeA0uQ' },
  { slug: 'quickbooks', authConfigId: 'ac_CpwDNq1gY6SH' },
  { slug: 'googlecalendar', authConfigId: 'ac_KLdSotJvCRud' },
  { slug: 'googlesheets', authConfigId: 'ac_FeTHwCDdhUdU' },
  { slug: 'googledocs', authConfigId: 'ac_PsV3q6SSPYkm' },
  { slug: 'notion', authConfigId: 'ac_s09pAPZ-CVIm' },
  { slug: 'trello', authConfigId: 'ac_QNe0qOc-Owo5' },
  { slug: 'asana', authConfigId: 'ac_m7EZFROEEf8X' },
  { slug: 'clickup', authConfigId: 'ac_xItBm4Cs2L7H' },
  { slug: 'googletasks', authConfigId: 'ac_Vy7TZ9VfHRWi' },
  { slug: 'zendesk', authConfigId: 'ac_4_dJCvlr3uBJ' },
  { slug: 'jira', authConfigId: 'ac_x1D8YNApVlw0' },
  { slug: 'confluence', authConfigId: 'ac_N5S3ZjgfUJyM' },
  { slug: 'one_drive', authConfigId: 'ac_B2WlSEXZcnRW' },
  { slug: 'hubspot', authConfigId: 'ac_fyyHSY9Ftc_e' },
  { slug: 'salesforce', authConfigId: 'ac_rdvHLRV9NJ5C' },
  { slug: 'stripe', authConfigId: 'ac__cYajU1M4cDP' },
  { slug: 'youtube', authConfigId: 'ac_0q1Pgmgk7HlM' },
  { slug: 'reddit', authConfigId: 'ac_C0ZEgGc-180r' },
  { slug: 'linkedin', authConfigId: 'ac_LQ8sqUg-8H6d' },
  { slug: 'instagram', authConfigId: 'ac_1XFhh0NqqNR7' },
  { slug: 'facebook', authConfigId: 'ac_A494rpSkqjBQ' },
  { slug: 'pdf_co', authConfigId: 'ac_XHuHmq4de1hq' },
  { slug: 'freshdesk', authConfigId: 'ac_BkhcoiLgZO-m' },
  { slug: 'firecrawl', authConfigId: 'ac_aUWDVARaC-B1' },
  { slug: 'googledrive', authConfigId: 'ac_xYJKrPk-aQir' },
  { slug: 'dropbox', authConfigId: 'ac_o0sg9nW5E1m6' },
  { slug: 'outlook', authConfigId: 'ac_lykFfU9mg4sg' },
  { slug: 'microsoft_teams', authConfigId: 'ac_B8jQhcu9lknb' },
  { slug: 'slack', authConfigId: 'ac_hSCwO6g_ZT1e' },
  { slug: 'github', authConfigId: 'ac_cNTHF5StYQTj' },
  { slug: 'figma', authConfigId: 'ac_7d5uv_v5MWaW' },
  { slug: 'agent_mail', authConfigId: 'ac_RoQKVn4HIWwn' },
  { slug: 'shopify', authConfigId: 'ac_Wj11Owr0uFoH' },
  { slug: 'webflow', authConfigId: 'ac_VEsW3PeRLi4I' },
];

/** Toolkits the agent engine leaves out. FreeAgent is not a Composio toolkit (it is brokered natively), so nothing is excluded today. */
export const EXCLUDED_TOOLKITS = new Set<string>([]);

/**
 * Stripe's grant is read AND write (Stripe refuses a read-only scope for these
 * connections), and production keeps the card's read-only promise by allowing
 * only tools matching /^STRIPE_(LIST|RETRIEVE|SEARCH)_/. A Composio session takes
 * an explicit list rather than a pattern, so this is that pattern applied to
 * Composio's Stripe catalogue on 2026-09-15 (75 of 433 tools).
 */
export const STRIPE_READ_ONLY_TOOLS: readonly string[] = [
  'STRIPE_LIST_ALL_SUBSCRIPTION_ITEM_PERIOD_SUMMARIES',
  'STRIPE_LIST_APPLE_PAY_DOMAINS',
  'STRIPE_LIST_APPLICATION_FEES',
  'STRIPE_LIST_APPS_SECRETS',
  'STRIPE_LIST_BALANCE_TRANSACTIONS',
  'STRIPE_LIST_BILLING_ALERTS',
  'STRIPE_LIST_BILLING_CREDIT_BALANCE_TRANSACTIONS',
  'STRIPE_LIST_CHARGES',
  'STRIPE_LIST_CHARGE_REFUNDS',
  'STRIPE_LIST_CHECKOUT_SESSIONS',
  'STRIPE_LIST_CLIMATE_ORDERS',
  'STRIPE_LIST_CLIMATE_PRODUCTS',
  'STRIPE_LIST_CLIMATE_SUPPLIERS',
  'STRIPE_LIST_COUNTRY_SPECS',
  'STRIPE_LIST_COUPONS',
  'STRIPE_LIST_CREDIT_NOTES',
  'STRIPE_LIST_CUSTOMERS',
  'STRIPE_LIST_CUSTOMER_SUBSCRIPTIONS',
  'STRIPE_LIST_DISPUTES',
  'STRIPE_LIST_ENTITLEMENTS_FEATURES',
  'STRIPE_LIST_FILES',
  'STRIPE_LIST_FILE_LINKS',
  'STRIPE_LIST_FINANCIAL_CONNECTIONS_ACCOUNTS',
  'STRIPE_LIST_FORWARDING_REQUESTS',
  'STRIPE_LIST_FX_QUOTES',
  'STRIPE_LIST_INVOICEITEMS',
  'STRIPE_LIST_INVOICES',
  'STRIPE_LIST_INVOICE_PAYMENTS',
  'STRIPE_LIST_INVOICE_RENDERING_TEMPLATES',
  'STRIPE_LIST_METER_EVENT_SUMMARIES',
  'STRIPE_LIST_PAYMENT_ATTEMPT_RECORDS',
  'STRIPE_LIST_PAYMENT_INTENTS',
  'STRIPE_LIST_PAYMENT_LINKS',
  'STRIPE_LIST_PAYOUTS',
  'STRIPE_LIST_PLANS',
  'STRIPE_LIST_PRICES',
  'STRIPE_LIST_PRODUCTS',
  'STRIPE_LIST_PRODUCTS_PRODUCT_FEATURES',
  'STRIPE_LIST_PROMOTION_CODES',
  'STRIPE_LIST_QUOTES',
  'STRIPE_LIST_RADAR_EARLY_FRAUD_WARNINGS',
  'STRIPE_LIST_RADAR_REVIEWS',
  'STRIPE_LIST_REFUNDS',
  'STRIPE_LIST_REPORTING_REPORT_RUNS',
  'STRIPE_LIST_REVIEWS',
  'STRIPE_LIST_SETUP_ATTEMPTS',
  'STRIPE_LIST_SETUP_INTENTS',
  'STRIPE_LIST_SIGMA_SCHEDULED_QUERY_RUNS',
  'STRIPE_LIST_SUBSCRIPTIONS',
  'STRIPE_LIST_SUBSCRIPTION_ITEMS',
  'STRIPE_LIST_TAX_CODES',
  'STRIPE_LIST_TAX_RATES',
  'STRIPE_LIST_TAX_REGISTRATIONS',
  'STRIPE_LIST_TERMINAL_CONFIGURATIONS',
  'STRIPE_LIST_TERMINAL_LOCATIONS',
  'STRIPE_LIST_TERMINAL_READERS',
  'STRIPE_LIST_TEST_CLOCKS',
  'STRIPE_LIST_TOPUPS',
  'STRIPE_LIST_TRANSFERS',
  'STRIPE_LIST_V2_CORE_EVENTS',
  'STRIPE_LIST_V2_CORE_EVENT_DESTINATIONS',
  'STRIPE_RETRIEVE_BALANCE',
  'STRIPE_RETRIEVE_CHARGE',
  'STRIPE_RETRIEVE_CHECKOUT_SESSION',
  'STRIPE_RETRIEVE_CUSTOMER',
  'STRIPE_RETRIEVE_PAYMENT_INTENT',
  'STRIPE_RETRIEVE_PROMOTION_CODE',
  'STRIPE_RETRIEVE_UPCOMING_INVOICE',
  'STRIPE_SEARCH_CHARGES',
  'STRIPE_SEARCH_CUSTOMERS',
  'STRIPE_SEARCH_INVOICES',
  'STRIPE_SEARCH_PAYMENT_INTENTS',
  'STRIPE_SEARCH_PRICES',
  'STRIPE_SEARCH_PRODUCTS',
  'STRIPE_SEARCH_SUBSCRIPTIONS'
];

/**
 * Toolkits that need no sign-in and hold no user data. Composio Search covers
 * the web, news, maps, flights, hotels, events, shopping and TripAdvisor;
 * Trivago compares hotel prices across booking sites; Viator finds tours and
 * things to do. Flight search, Trivago and Viator were tried live on 2026-09-15
 * (London to Edinburgh flights, Manchester hotels in pounds, Edinburgh food tours).
 * Taskrabbit's MCP was left out: it only takes US bookings.
 */
export const NO_AUTH_TOOLKITS = ['composio_search', 'weathermap', 'hackernews', 'trivago_mcp', 'viator_mcp'];

/**
 * Offered to the model directly, skipping a search round trip. Keep it small:
 * every schema here is sent with every reply. Flights and hotels are here
 * because a trip question otherwise spends two planning steps finding them
 * (measured 2026-09-15: 25 s and 4 steps for a flights-and-hotel question).
 * Sending an email and adding a calendar event are the everyday writes; without
 * them preloaded each took a search round trip first (eval, 2026-09-22: 4 and 5
 * steps). With the prompt cache working, a preloaded schema costs almost nothing
 * on repeat.
 */
export const PRELOADED_TOOLS = [
  'GMAIL_FETCH_EMAILS',
  'GMAIL_SEND_EMAIL',
  // EVENTS_LIST on the primary calendar, not EVENTS_LIST_ALL_CALENDARS: listing
  // calendars needs a scope the calendar.events grant does not include, so the
  // old choice failed every calendar read with a 403 (live QA, 2026-09-23).
  'GOOGLECALENDAR_EVENTS_LIST',
  'GOOGLECALENDAR_CREATE_EVENT',
  'COMPOSIO_SEARCH_WEB',
  'WEATHERMAP_WEATHER',
  'COMPOSIO_SEARCH_FLIGHTS',
  'TRIVAGO_MCP_TRIVAGO_ACCOMMODATION_SEARCH'
];

/** How the prompt names each app, and how people group them. Every product toolkit appears exactly once (test/toolkits.test.ts). */
export const APP_NAMES: Readonly<Record<string, string>> = {
  gmail: 'Gmail', outlook: 'Outlook', agent_mail: 'AgentMail',
  googlecalendar: 'Google Calendar', googletasks: 'Google Tasks',
  googledocs: 'Google Docs', googlesheets: 'Google Sheets', googledrive: 'Google Drive', dropbox: 'Dropbox', one_drive: 'OneDrive', pdf_co: 'PDF.co',
  notion: 'Notion', trello: 'Trello', asana: 'Asana', clickup: 'ClickUp', jira: 'Jira', confluence: 'Confluence',
  hubspot: 'HubSpot', salesforce: 'Salesforce', zendesk: 'Zendesk', freshdesk: 'Freshdesk',
  stripe: 'Stripe', quickbooks: 'QuickBooks',
  slack: 'Slack', microsoft_teams: 'Microsoft Teams',
  facebook: 'Facebook Pages', instagram: 'Instagram', linkedin: 'LinkedIn', reddit: 'Reddit', youtube: 'YouTube',
  webflow: 'Webflow', shopify: 'Shopify', github: 'GitHub',
  figma: 'Figma', firecrawl: 'Firecrawl',
};

export const APP_GROUPS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['Email', ['gmail', 'outlook', 'agent_mail']],
  ['Calendar and to-dos', ['googlecalendar', 'googletasks']],
  ['Documents and files', ['googledocs', 'googlesheets', 'googledrive', 'dropbox', 'one_drive', 'pdf_co']],
  ['Notes and projects', ['notion', 'trello', 'asana', 'clickup', 'jira', 'confluence']],
  ['Customers and support', ['hubspot', 'salesforce', 'zendesk', 'freshdesk']],
  ['Money', ['stripe', 'quickbooks']],
  ['Work chat', ['slack', 'microsoft_teams']],
  ['Social', ['facebook', 'instagram', 'linkedin', 'reddit', 'youtube']],
  ['Websites and shops', ['webflow', 'shopify', 'github']],
  ['Design and web data', ['figma', 'firecrawl']],
];

const APP_NOTES: Readonly<Record<string, string>> = {
  agent_mail: "an email inbox of your own, for dealing with people on the user's behalf",
  pdf_co: 'converts web pages and documents to PDF and reads PDFs',
  stripe: 'read only',
  facebook: 'Pages, not personal profiles',
  instagram: 'business and creator accounts',
  youtube: 'channel and video stats',
  github: 'code, issues and GitHub Pages sites',
  firecrawl: 'reads whole websites into clean text',
  // Composio's Atlassian app does not offer the search or space-list scopes, so
  // CONFLUENCE_CQL_SEARCH and CONFLUENCE_GET_SPACES answer 401. Listing pages
  // works and each page carries its spaceId (QA F12, 2026-09-23).
  confluence: 'pages: find one by listing pages and matching the title, and take a spaceId from a listed page, because search and the space list are not available',
};

/** The app list as the prompt shows it, one line per group. */
export function appCatalogueText(): string {
  return APP_GROUPS.map(([group, slugs]) => `- ${group}: ${slugs.map((slug) => (APP_NOTES[slug] ? `${APP_NAMES[slug]} (${APP_NOTES[slug]})` : APP_NAMES[slug])).join(', ')}`).join('\n');
}
