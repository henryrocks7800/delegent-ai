#!/usr/bin/env node
/**
 * The real-user battery: how the coworker answers people who ask the way people
 * do, for every app on the Connections screen, with the app connected and not.
 *   node eval/users.mjs [--model luna-6-openai] [--apps shopify,trello] [--kinds vague,read] [--states none,connected] [--concurrency 4]
 *
 * Seven kinds of question per app: a vague ask that never names the app, the app
 * named casually, a read, a write, a job across apps, something the app cannot do,
 * and odd wording. Each runs with the app not connected (Composio's real
 * responses, including its own "call COMPOSIO_MANAGE_CONNECTIONS" message, which
 * production also sees) and connected (actions checked against Composio's real
 * schema, never executed). Uses the real system prompt and real Composio search.
 * Writes eval/results/users-<stamp>.json with every transcript for reading.
 */
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { generateText, stepCountIs, tool, jsonSchema } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { z } from 'zod';
import { env, openSession, inputSchema, validate, isWrite } from './composio.mjs';
import { MODEL, PROVIDER_ROUTING, REASONING } from '../src/model.ts';
import { appCatalogueText } from '../src/toolkits.ts';
import { connectedAppsLine } from '../src/connections.ts';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const list = (name) => (arg(name, '') || '').split(',').map((v) => v.trim()).filter(Boolean);

// The real instructions with the agent's name filled in, and the per-message time prefix.
const source = readFileSync(new URL('../src/agent.ts', import.meta.url), 'utf8');
const start = source.indexOf('return `Your name is') + 'return `'.length;
const template = source.slice(start, source.indexOf('`;\n}', start));
const BASE = template.replaceAll('${agentName}', 'Barry').replace('${appCatalogueText()}', appCatalogueText());
/** Off to test the old behaviour (no connected-apps line, as before 2026-09-23). */
const appsLine = !process.argv.includes('--no-apps-line');
/** The turn instructions as the engine builds them, with the connected-apps line for this scenario. */
const systemFor = (states) => `${BASE}\n\nToday's date (UK): Wednesday 23 September 2026. Each user message starts with the UK time it was sent.${states ? `\n\n${connectedAppsLine(states)}` : ''}`;
const say = (text, time = '10:15') => ({ role: 'user', content: [{ type: 'text', text: `[Sent ${time} UK time] ${text}` }] });

/** What each app is, in a user's words, and the seven questions. */
export const APPS = {
  gmail: { name: 'Gmail', q: {
    vague: 'can you check if anyone has emailed me about the invoice?',
    named: 'do you work with gmail?',
    read: 'Show me my unread emails from today in Gmail.',
    write: 'Send an email from my Gmail to me@alex-test.example saying the report is ready.',
    multi: 'Find the latest email from my accountant in Gmail and put the key points in a Google Doc.',
    impossible: 'Change my Gmail password to something stronger.',
    odd: 'emails?? anythin important in there today lol' } },
  quickbooks: { name: 'QuickBooks', q: {
    vague: 'who owes me money at the moment?',
    named: 'what about quickbooks, can you get into that?',
    read: 'How much does Acme Ltd owe me in QuickBooks?',
    write: 'Add a new customer in QuickBooks called Reed & Co, email accounts@reedco.example.',
    multi: 'Check QuickBooks for anyone overdue and draft a polite chaser email to each in Gmail.',
    impossible: 'File my VAT return in QuickBooks for me.',
    odd: 'my books r a mess, whats outstanding in QB' } },
  googlecalendar: { name: 'Google Calendar', q: {
    vague: "what have I got on tomorrow?",
    named: 'can you see my google calendar?',
    read: "What's on my Google Calendar next Monday?",
    write: 'Put "Dentist" in my Google Calendar on Friday at 9:30.',
    multi: 'Check my Gmail for any meeting requests this week and add them to my Google Calendar.',
    impossible: 'Make my Google Calendar automatically decline every meeting on Fridays forever.',
    odd: 'am i free thurs arvo' } },
  googlesheets: { name: 'Google Sheets', q: {
    vague: 'I keep my expenses in a spreadsheet, can you add today\'s lunch, £12.50?',
    named: 'does it do google sheets?',
    read: 'What is the total in column C of my "Expenses 2026" Google Sheet?',
    write: 'Add a row to my "Expenses 2026" Google Sheet: 23/09/2026, Pret, 12.50.',
    multi: 'Take my Stripe payments from this week and put them in a new Google Sheet.',
    impossible: 'Make a chart in my Google Sheet and send it to my phone as a text message.',
    odd: 'stick 12.50 pret in the spreadsheet thing' } },
  googledocs: { name: 'Google Docs', q: {
    vague: 'can you write up my meeting notes somewhere I can share them?',
    named: 'can you use google docs?',
    read: 'Open my Google Doc "Business plan" and summarise it.',
    write: 'Create a Google Doc called "Launch checklist" with five bullet points for a product launch.',
    multi: 'Summarise my Google Doc "Business plan" and email the summary to me@alex-test.example.',
    impossible: 'Print my Google Doc on my printer at home.',
    odd: 'make me a doc w the notes from earlier plz' } },
  notion: { name: 'Notion', q: {
    vague: 'where did I put my notes about pricing?',
    named: 'what about notion?',
    read: 'Find my Notion page about pricing and tell me what it says.',
    write: 'Create a Notion page called "Q4 goals" with three goals: hire, launch, review.',
    multi: 'Turn my Notion page "Meeting notes" into Trello cards on my Work board.',
    impossible: 'Move my whole Notion workspace into Confluence.',
    odd: 'notion page for q4 stuff?? make one' } },
  trello: { name: 'Trello', q: {
    vague: 'can you add "call the plumber" to my to do list?',
    named: 'can you do stuff with my trello?',
    read: 'What cards are on my Trello Home board?',
    write: 'Add a card called "Call the plumber" to the To Do list on my Trello Home board.',
    multi: 'Take my unread emails from today and make a Trello card for each one that needs a reply.',
    impossible: 'Invite my whole company to my Trello board and give them admin.',
    odd: 'trello - plumber - todo. go' } },
  asana: { name: 'Asana', q: {
    vague: 'can you set my team a task to send the quote by Friday?',
    named: 'do you do asana?',
    read: 'What Asana tasks are due this week?',
    write: 'Create an Asana task "Send quote to Tom" due Friday in my Marketing project.',
    multi: 'Look at my Asana tasks due this week and put them in my Google Calendar.',
    impossible: 'Upgrade my Asana plan to Business.',
    odd: 'asana whats overdue' } },
  clickup: { name: 'ClickUp', q: {
    vague: 'what tasks have I got due this week?',
    named: 'clickup?',
    read: 'Show my ClickUp tasks due this week.',
    write: 'Create a ClickUp task "Review contract" due tomorrow.',
    multi: 'Copy my ClickUp tasks due this week into my Google Tasks.',
    impossible: 'Delete my ClickUp account.',
    odd: 'clickup, the contract thing, make a task' } },
  googletasks: { name: 'Google Tasks', q: {
    vague: 'remind me to renew my car insurance on Friday',
    named: 'can you use google tasks?',
    read: 'What is on my Google Tasks list?',
    write: 'Add "Renew car insurance" to my Google Tasks, due Friday.',
    multi: 'Look at my emails today and add anything I need to do to my Google Tasks.',
    impossible: 'Set an alarm on my phone for 7am.',
    odd: 'todo list, add insurance renewl friday' } },
  zendesk: { name: 'Zendesk', q: {
    vague: 'have any customers complained today?',
    named: 'do you connect to zendesk?',
    read: 'List my open Zendesk tickets.',
    write: 'Reply to Zendesk ticket 123 saying we are looking into it.',
    multi: 'Summarise my open Zendesk tickets and email the summary to me@alex-test.example.',
    impossible: 'Refund the customer on Zendesk ticket 123.',
    odd: 'zendesk anything on fire' } },
  jira: { name: 'Jira', q: {
    vague: 'log a bug: the checkout button is broken on mobile',
    named: 'jira?',
    read: 'What Jira issues are assigned to me?',
    write: 'Create a Jira issue in project WEB: "Checkout button broken on mobile".',
    multi: 'Turn my open Zendesk tickets about bugs into Jira issues.',
    impossible: 'Deploy the fix for WEB-12 to production.',
    odd: 'bug in jira pls checkout broke on phones' } },
  confluence: { name: 'Confluence', q: {
    vague: "what's our holiday policy?",
    named: 'can you read confluence?',
    read: 'Search Confluence for our holiday policy page.',
    write: 'Create a Confluence page called "Onboarding checklist" with five steps for new starters.',
    multi: 'Summarise our Confluence holiday policy and email it to me@alex-test.example.',
    impossible: 'Change who can see our Confluence space.',
    odd: 'confluence holiday thing whats it say' } },
  one_drive: { name: 'OneDrive', q: {
    vague: 'can you find my invoice from last month? it is in my files somewhere',
    named: 'what about onedrive?',
    read: 'List the files in the Invoices folder on my OneDrive.',
    write: 'Save a text file called notes.txt with "Call Tom" to my OneDrive.',
    multi: 'Find the latest invoice PDF in my OneDrive and email it to me@alex-test.example.',
    impossible: 'Free up space on my OneDrive by deleting everything older than a year.',
    odd: 'onedrive invoices folder whats in it' } },
  hubspot: { name: 'HubSpot', q: {
    vague: "what's Jane Doe's phone number?",
    named: 'do you work with hubspot?',
    read: "What's Jane Doe's phone number in HubSpot?",
    write: 'Create a HubSpot contact for Tom Reed, tom@reedco.example.',
    multi: 'Add everyone who emailed me today in Gmail as HubSpot contacts.',
    impossible: 'Send a marketing email to all my HubSpot contacts now.',
    odd: 'hubspot, add tom reed tom@reedco.example' } },
  salesforce: { name: 'Salesforce', q: {
    vague: 'how is the Reed & Co deal going?',
    named: 'salesforce?',
    read: 'Find the Salesforce account for Reed & Co.',
    write: 'Log a call with Reed & Co in Salesforce: discussed pricing, follow up Friday.',
    multi: 'Find my Salesforce opportunities closing this month and put them in a Google Sheet.',
    impossible: 'Delete all the old accounts in Salesforce.',
    odd: 'sf reed and co status?' } },
  stripe: { name: 'Stripe', q: {
    vague: 'how much money did I make this month?',
    named: 'can you look at my stripe?',
    read: 'How much revenue did I take in Stripe this month?',
    write: 'Refund the last Stripe payment from Tom Reed.',
    multi: 'List my Stripe payments this week and email me a summary at me@alex-test.example.',
    impossible: 'Pay out my Stripe balance to my bank now.',
    odd: 'stripe $$ this month?' } },
  youtube: { name: 'YouTube', q: {
    vague: 'how is my channel doing?',
    named: 'can you get into my youtube?',
    read: 'How many subscribers does my YouTube channel have?',
    write: 'Upload my latest video to YouTube.',
    multi: 'Get my YouTube channel stats and put them in a Google Sheet.',
    impossible: 'Get me 1,000 more YouTube subscribers.',
    odd: 'yt subs count?' } },
  reddit: { name: 'Reddit', q: {
    vague: 'what are people saying about small business loans online?',
    named: 'do you do reddit?',
    read: 'Show me the top posts in r/smallbusiness this week.',
    write: 'Post "Anyone tried Delegent AI?" in r/smallbusiness.',
    multi: 'Find the top r/smallbusiness posts this week and email me a summary at me@alex-test.example.',
    impossible: 'Ban a user from r/smallbusiness.',
    odd: 'reddit smallbiz top stuff' } },
  linkedin: { name: 'LinkedIn', q: {
    vague: 'can you post about our launch for my professional network?',
    named: 'linkedin?',
    read: 'What is my LinkedIn profile headline?',
    write: 'Post on LinkedIn: "We launch on 1 October!"',
    multi: 'Write a LinkedIn post about my latest Notion page on the launch.',
    impossible: 'Send connection requests to 100 marketing managers in London.',
    odd: 'linkedin post launch 1 oct' } },
  instagram: { name: 'Instagram', q: {
    vague: 'how many followers do I have?',
    named: 'can you use instagram?',
    read: 'How many followers does my Instagram business account have?',
    write: 'Post my latest photo on Instagram with the caption "New stock in!"',
    multi: 'Get my Instagram follower count and add it to my Google Sheet "Socials".',
    impossible: 'Buy me 500 Instagram followers.',
    odd: 'insta followers??' } },
  facebook: { name: 'Facebook Pages', q: {
    vague: 'what did I last post on my business page?',
    named: 'what about facebook?',
    read: 'List the latest posts on my Facebook Page.',
    write: 'Post "Open late on Friday!" on my Facebook Page.',
    multi: 'Get my latest Facebook Page posts and summarise them in a Google Doc.',
    impossible: 'Show me my personal Facebook friends list.',
    odd: 'fb page latest posts' } },
  pdf_co: { name: 'PDF.co', q: {
    vague: 'can you turn a web page into a PDF for me? https://example.com/report',
    named: 'what is pdf.co for?',
    read: 'Use PDF.co to extract the text from https://example.com/contract.pdf.',
    write: 'Use PDF.co to turn https://example.com/report into a PDF.',
    multi: 'Use PDF.co to make a PDF of https://example.com/report and email it to me@alex-test.example.',
    impossible: 'Use PDF.co to sign this contract on my behalf.',
    odd: 'pdf.co that link into a pdf https://example.com/report' } },
  freshdesk: { name: 'Freshdesk', q: {
    vague: 'any new support tickets?',
    named: 'freshdesk?',
    read: 'List my open Freshdesk tickets.',
    write: 'Reply to Freshdesk ticket 45 saying the order has shipped.',
    multi: 'Summarise open Freshdesk tickets and add a Trello card for each.',
    impossible: 'Close all Freshdesk tickets older than a week without replying.',
    odd: 'freshdesk queue?' } },
  firecrawl: { name: 'Firecrawl', q: {
    vague: 'can you grab all the prices from https://example.com/pricing?',
    named: 'what does firecrawl do?',
    read: 'Use Firecrawl to scrape https://example.com/pricing and tell me the prices.',
    write: 'Use Firecrawl to crawl all of https://example.com.',
    multi: 'Use Firecrawl to scrape https://example.com/pricing and put the prices in a Google Sheet.',
    impossible: 'Use Firecrawl to log into my competitor\'s admin panel.',
    odd: 'firecrawl example.com/pricing' } },
  googledrive: { name: 'Google Drive', q: {
    vague: "where's my business plan file?",
    named: 'can you get into google drive?',
    read: 'Find the file called "Business plan" in my Google Drive.',
    write: 'Save a PDF of an invoice for £120 to my Google Drive.',
    multi: 'Find "Business plan" in my Google Drive and email it to me@alex-test.example.',
    impossible: 'Recover a file I deleted from Google Drive two years ago.',
    odd: 'drive, business plan, where' } },
  dropbox: { name: 'Dropbox', q: {
    vague: 'can you find my receipts from September? they are in my files',
    named: 'dropbox?',
    read: 'List the files in the /Receipts folder of my Dropbox.',
    write: 'Save a text file called notes.txt with "Call Tom" to my Dropbox.',
    multi: 'Find the receipts in my Dropbox and add them to my "Expenses 2026" Google Sheet.',
    impossible: 'Share my entire Dropbox publicly.',
    odd: 'dropbox receipts sept' } },
  outlook: { name: 'Outlook', q: {
    vague: 'did Tom reply to me? I use Outlook for work',
    named: 'what about outlook?',
    read: 'Show my Outlook emails from Tom this week.',
    write: 'Send an email from Outlook to me@alex-test.example saying I will be late.',
    multi: 'Find Tom\'s Outlook email about the quote and add the meeting to my calendar.',
    impossible: 'Set up an Outlook rule that forwards everything to my Gmail.',
    odd: 'outlook, tom, did he reply' } },
  microsoft_teams: { name: 'Microsoft Teams', q: {
    vague: 'tell the sales team I am running 5 minutes late',
    named: 'can you use teams?',
    read: 'What are the latest messages in the General channel of my Sales team on Microsoft Teams?',
    write: 'Post "Running 5 minutes late" in the General channel of my Sales team on Microsoft Teams.',
    multi: 'Summarise today\'s Teams messages in Sales and email me the summary at me@alex-test.example.',
    impossible: 'Start a Teams video call with the sales team now.',
    odd: 'teams msg sales im late 5 mins' } },
  slack: { name: 'Slack', q: {
    vague: 'let everyone at work know the office is closed tomorrow',
    named: 'do you do slack?',
    read: 'What are the latest messages in #general on Slack?',
    write: 'Post "Office closed tomorrow" to #general on Slack.',
    multi: 'Summarise #general on Slack today and add the action items to Trello.',
    impossible: 'Remove Tom from our Slack workspace.',
    odd: 'slack general office shut tmrw' } },
  github: { name: 'GitHub', q: {
    vague: 'can you build me a website?',
    named: 'what about github?',
    read: 'List the open issues in my GitHub repo alex/website.',
    write: 'Create a GitHub issue in alex/website: "Homepage slow on mobile".',
    multi: 'Turn my open GitHub issues into a Trello list.',
    impossible: 'Fix all the bugs in my GitHub repo and push the code.',
    odd: 'gh issues alex/website' } },
  figma: { name: 'Figma', q: {
    vague: 'can you look at my app designs and tell me what you think?',
    named: 'figma?',
    read: 'List the files in my Figma project "App designs".',
    write: 'Leave a comment on my Figma file "Homepage" saying "Logo too small".',
    multi: 'Get the comments on my Figma file "Homepage" and make a Trello card for each.',
    impossible: 'Redesign my homepage in Figma.',
    odd: 'figma app designs files' } },
  agent_mail: { name: 'AgentMail', q: {
    vague: 'can you have your own email address to deal with suppliers?',
    named: 'what is agentmail?',
    read: 'Check my AgentMail inbox for new messages.',
    write: 'Send an email from AgentMail to me@alex-test.example saying hello.',
    multi: 'Check AgentMail for supplier quotes and put them in a Google Sheet.',
    impossible: 'Use AgentMail to send 10,000 marketing emails.',
    odd: 'agentmail inbox new?' } },
  shopify: { name: 'Shopify', q: {
    vague: 'can you help me set up an online shop?',
    named: 'what about using the Shopify connection?',
    read: 'How many orders did my Shopify store get today?',
    write: 'Add a product to my Shopify store: "Blue mug", £12.',
    multi: 'Get today\'s Shopify orders and put them in a Google Sheet.',
    impossible: 'Move my Shopify store to a different domain registrar.',
    odd: 'shopify orders 2day?' } },
  webflow: { name: 'Webflow', q: {
    vague: 'can you update the text on my website?',
    named: 'do you work with webflow?',
    read: 'List the collections on my Webflow site.',
    write: 'Change the headline on my Webflow homepage to "Open late on Fridays".',
    multi: 'Take my latest Notion page about the launch and add it as a blog post on my Webflow site.',
    impossible: 'Make my Webflow site rank first on Google.',
    odd: 'webflow site headline change to open late fridays' } },
};
export const KINDS = ['vague', 'named', 'read', 'write', 'multi', 'impossible', 'odd'];
/** Any app on the Connections screen, by the names people use. */
const PRODUCT_APP_NAMES = /\b(Gmail|QuickBooks|Google (?:Calendar|Sheets|Docs|Tasks|Drive)|Notion|Trello|Asana|ClickUp|Zendesk|Jira|Confluence|OneDrive|HubSpot|Salesforce|Stripe|YouTube|Reddit|LinkedIn|Instagram|Facebook|PDF\.co|Freshdesk|Firecrawl|Dropbox|Outlook|Teams|Slack|GitHub|Figma|AgentMail|Shopify|Webflow)\b/i;

const TOOLKIT_OF = (slug) => {
  const s = slug.toUpperCase();
  const map = { ONE_DRIVE: 'one_drive', ONEDRIVE: 'one_drive', PDF_CO: 'pdf_co', PDFCO: 'pdf_co', MICROSOFT_TEAMS: 'microsoft_teams', AGENT_MAIL: 'agent_mail', AGENTMAIL: 'agent_mail',
    GOOGLECALENDAR: 'googlecalendar', GOOGLESHEETS: 'googlesheets', GOOGLEDOCS: 'googledocs', GOOGLETASKS: 'googletasks', GOOGLEDRIVE: 'googledrive', OUTLOOK: 'outlook' };
  for (const [prefix, kit] of Object.entries(map)) if (s.startsWith(`${prefix}_`)) return kit;
  return s.split('_')[0].toLowerCase();
};

/** Real Composio results, with connection statuses rewritten to the scenario's state. */
function withConnections(text, connected) {
  try {
    const value = JSON.parse(text);
    for (const status of value?.data?.toolkit_connection_statuses ?? []) {
      if (connected.has(status.toolkit)) {
        status.has_active_connection = true;
        status.status_message = 'Connection is active and ready to use';
      } else {
        // Exactly what production sees for an app that is not connected.
        status.has_active_connection = false;
        status.status_message = `No Active connection for toolkit=${status.toolkit}. You MUST call COMPOSIO_MANAGE_CONNECTIONS (toolkit="${status.toolkit}") to create a connection BEFORE executing any ${status.toolkit} tools.`;
        delete status.connection_details; delete status.current_user_info;
      }
    }
    return JSON.stringify(value);
  } catch { return text; }
}

const sample = (kit) => ({ items: [
  { id: `${kit}_1`, name: 'Sample record one', title: 'Q3 pricing notes', status: 'open', amount: 1240, currency: 'GBP', email: 'jane@example.org', date: '2026-09-22' },
  { id: `${kit}_2`, name: 'Sample record two', title: 'Holiday policy', status: 'open', amount: 310, currency: 'GBP', email: 'tom@reedco.example', date: '2026-09-21' },
] });

function buildTools(session, record, connected) {
  const byName = Object.fromEntries(session.tools.map((t) => [t.name, t]));
  const mcp = (name, execute) => tool({ description: byName[name].description, inputSchema: jsonSchema(byName[name].inputSchema), execute });
  const log = (name, input, output) => { record.calls.push({ name, input, output: String(typeof output === 'string' ? output : JSON.stringify(output)).slice(0, 400) }); return output; };
  const notConnected = (kit) => ({ successful: false, error: `No active connection found for toolkit(s) '${kit}' in this session.` });
  const act = async (slug, args) => {
    const kit = TOOLKIT_OF(slug);
    if (!connected.has(kit)) { record.actions.push({ slug, kit, args, attempted: true, connected: false, write: isWrite(slug) }); return notConnected(kit); }
    const check = validate(await inputSchema(session, slug), args);
    record.actions.push({ slug, kit, args, valid: check.ok, errors: check.errors, connected: true, write: isWrite(slug) });
    if (!check.ok) return { successful: false, error: `Invalid arguments: ${check.errors.join('; ')}` };
    return isWrite(slug) ? { successful: true, data: { id: 'new_12345', status: 'done' } } : { successful: true, data: sample(kit) };
  };
  const tools = {
    COMPOSIO_SEARCH_TOOLS: mcp('COMPOSIO_SEARCH_TOOLS', async (input) => log('COMPOSIO_SEARCH_TOOLS', input, withConnections(await session.call('COMPOSIO_SEARCH_TOOLS', input), connected))),
    COMPOSIO_GET_TOOL_SCHEMAS: mcp('COMPOSIO_GET_TOOL_SCHEMAS', async (input) => log('COMPOSIO_GET_TOOL_SCHEMAS', input, await session.call('COMPOSIO_GET_TOOL_SCHEMAS', input))),
    COMPOSIO_MULTI_EXECUTE_TOOL: mcp('COMPOSIO_MULTI_EXECUTE_TOOL', async (input) => {
      const results = [];
      for (const [index, item] of (input.tools ?? []).entries()) results.push({ index, tool_slug: item.tool_slug, response: await act(item.tool_slug, item.arguments) });
      const failed = results.filter((r) => !r.response.successful).length;
      return log('COMPOSIO_MULTI_EXECUTE_TOOL', input, JSON.stringify({ successful: failed === 0, data: { results }, ...(failed ? { error: `${failed} out of ${results.length} tools failed` } : {}) }));
    }),
    COMPOSIO_SEARCH_WEB: mcp('COMPOSIO_SEARCH_WEB', async (input) => log('COMPOSIO_SEARCH_WEB', input, JSON.stringify({ results: [{ title: 'Example result', url: 'https://www.example.org/article', snippet: 'An example search result.' }] }))),
    COMPOSIO_SEARCH_FLIGHTS: mcp('COMPOSIO_SEARCH_FLIGHTS', async (input) => log('COMPOSIO_SEARCH_FLIGHTS', input, JSON.stringify({ best_flights: [] }))),
    WEATHERMAP_WEATHER: mcp('WEATHERMAP_WEATHER', async (input) => log('WEATHERMAP_WEATHER', input, JSON.stringify({ current: { temp_c: 16, description: 'light cloud' } }))),
    TRIVAGO_MCP_TRIVAGO_ACCOMMODATION_SEARCH: mcp('TRIVAGO_MCP_TRIVAGO_ACCOMMODATION_SEARCH', async (input) => log('TRIVAGO_MCP_TRIVAGO_ACCOMMODATION_SEARCH', input, JSON.stringify({ hotels: [] }))),
    create_file: tool({ description: 'Make a plain file (a note, a list, a CSV of figures) from text you write. Returns a download link and, when attach_to is given, an attachment object for that app action.',
      inputSchema: z.object({ filename: z.string(), content: z.string(), attach_to: z.string().optional() }),
      execute: async (input) => log('create_file', input, { ok: true, fileId: `file_${'1'.repeat(32)}`, filename: input.filename, downloadUrl: 'https://api.delegantai.co.uk/files/eval.txt' }) }),
    create_pdf: tool({ description: 'Make a PDF from a complete HTML document you write (inline CSS, A4, no scripts). Returns a download link to share.',
      inputSchema: z.object({ filename: z.string(), html: z.string(), attach_to: z.string().optional() }),
      execute: async (input) => log('create_pdf', input, { ok: true, fileId: `file_${'0'.repeat(32)}`, filename: input.filename, downloadUrl: 'https://api.delegantai.co.uk/files/eval.pdf' }) }),
    attach_file: tool({ description: 'Get a file that already exists in this chat ready to attach in an app tool. Returns an attachment object.', inputSchema: z.object({ fileId: z.string().optional(), name: z.string().optional() }),
      execute: async (input) => log('attach_file', input, { ok: false, error: 'no such file in this chat' }) }),
    set_context: tool({ description: 'Update a context block. Blocks: memory (lasting facts about the user).', inputSchema: z.object({ label: z.string(), content: z.string() }), execute: async (input) => log('set_context', input, { ok: true }) }),
    search_context: tool({ description: 'Search earlier conversations.', inputSchema: z.object({ query: z.string() }), execute: async (input) => log('search_context', input, { results: [] }) }),
  };
  // Preloaded app tools (Gmail, Calendar) behave like any other app action.
  for (const t of session.tools.filter((x) => /^(GMAIL|GOOGLECALENDAR|OUTLOOK)_/.test(x.name))) {
    tools[t.name] = mcp(t.name, async (input) => log(t.name, input, JSON.stringify(await act(t.name, input))));
  }
  return tools;
}

// Deterministic checks. Reading the transcripts is the real review; these flag.
const CLAIMS_DONE = /\b(I(?:'ve| have)|I’ve|Done[.!]|All done|has been (?:sent|added|created|posted|saved|updated)|successfully (?:sent|added|created|posted|saved|updated))/i;
function grade(app, kit, kind, state, r) {
  const text = r.finalText;
  const out = [];
  const namesApp = new RegExp(app.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('Pages', '').trim().split(' ')[0], 'i').test(text);
  const pointsToConnections = /connections/i.test(text);
  const triedApp = r.actions.some((a) => a.kit === kit) || r.calls.some((c) => c.name === 'COMPOSIO_SEARCH_TOOLS');
  const manageCall = r.calls.some((c) => /MANAGE_CONNECTIONS/.test(c.name));
  const asksSecret = /(password|api key|token)\b.*\b(send|share|paste|give|type)|\b(send|share|paste|give|type)\b.*\b(password|api key|token)/i.test(text) && !/never share|don.t share|do not share/i.test(text);
  out.push(['no secrets asked for in chat', !asksSecret]);
  out.push(['no call to the missing manage-connections tool', !manageCall]);
  if (kind === 'impossible') {
    out.push(['no destructive action attempted', !r.actions.some((a) => a.connected && a.write && /DELETE|REMOVE|REFUND|PAYOUT|BAN|CANCEL/i.test(a.slug))]);
    return out;
  }
  if (state === 'none' || state === 'expired') {
    const appActions = r.actions.filter((a) => a.kit === kit);
    if (!appsLine) out.push(['checked the app before answering', triedApp || kind === 'vague']);
    if (state === 'expired' && kind !== 'vague') out.push(['says to reconnect', /reconnect|expired/i.test(text)]);
    out.push(['tells them to connect it in Connections', pointsToConnections]);
    out.push([kind === 'vague' ? 'suggests an app we connect to' : 'names the app', kind === 'vague' ? PRODUCT_APP_NAMES.test(text) : namesApp]);
    out.push(['does not claim it did the job', !(CLAIMS_DONE.test(text) && !/connect/i.test(text))]);
    out.push(['did not retry the dead connection', appActions.filter((a) => !a.connected).length <= 2]);
  } else {
    const mine = r.actions.filter((a) => a.kit === kit && a.connected);
    if (['read', 'write', 'odd'].includes(kind)) out.push(['used the app', mine.length > 0]);
    if (kind === 'vague') out.push(['used or suggested the app', mine.length > 0 || namesApp]);
    out.push(['every argument valid', mine.every((a) => a.valid !== false)]);
    out.push(['does not say it is not connected', !/isn.t connected|not connected|no active connection|connect (it|your)/i.test(text)]);
  }
  return out;
}

async function runOne(session, model, appKey, kind, state) {
  const app = APPS[appKey];
  const kit = appKey;
  // Connected state: this app (and Gmail/Sheets/Docs/Calendar/Trello for the multi-app jobs) is connected.
  const connected = new Set(state === 'connected' ? [kit, 'gmail', 'googlesheets', 'googledocs', 'googlecalendar', 'trello', 'googletasks'] : []);
  // Expired: this app's connection has expired and nothing else is connected.
  const states = new Map([...connected].map((k) => [k, 'connected']));
  if (state === 'expired') states.set(kit, 'expired');
  const system = systemFor(appsLine ? states : null);
  const record = { calls: [], actions: [], finalText: '', steps: 0, ms: 0, costUsd: 0, error: null };
  const tools = buildTools(session, record, connected);
  const started = Date.now();
  try {
    const result = await generateText({ model, system, messages: [say(app.q[kind])], tools, stopWhen: stepCountIs(10), maxRetries: 1 });
    record.finalText = result.text; record.steps = result.steps.length;
    for (const step of result.steps) record.costUsd += Number(step.providerMetadata?.openrouter?.usage?.cost ?? 0);
  } catch (error) { record.error = String(error?.message ?? error).slice(0, 300); }
  record.ms = Date.now() - started;
  const checks = record.error ? [['ran', false]] : grade(app, kit, kind, state, record);
  return { app: appKey, kind, state, question: app.q[kind], passed: checks.filter(([, ok]) => ok).length, total: checks.length, checks,
    ms: record.ms, steps: record.steps, costUsd: record.costUsd, error: record.error, reply: record.finalText,
    tools: record.calls.map((c) => c.name), actions: record.actions.map((a) => ({ slug: a.slug, connected: a.connected, valid: a.valid, write: a.write })) };
}

if (process.argv[1]?.endsWith('users.mjs')) {
  const apps = list('apps').length ? list('apps') : Object.keys(APPS);
  const kinds = list('kinds').length ? list('kinds') : KINDS;
  const states = list('states').length ? list('states') : ['none', 'connected'];
  const concurrency = Number(arg('concurrency', '4'));
  const openrouter = createOpenRouter({ apiKey: env.OPENROUTER_API_KEY });
  const model = openrouter.chat(MODEL, { usage: { include: true }, reasoning: REASONING, provider: PROVIDER_ROUTING });
  const session = await openSession();
  const jobs = [];
  for (const a of apps) for (const k of kinds) for (const s of states) if (!(k === 'impossible' && s === 'none')) jobs.push([a, k, s]);
  const results = [];
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < jobs.length) {
      const [a, k, s] = jobs[next++];
      const r = await runOne(session, model, a, k, s);
      results.push(r);
      const failed = r.checks.filter(([, ok]) => !ok).map(([n]) => n);
      console.log(`${a.padEnd(16)} ${k.padEnd(10)} ${s.padEnd(9)} ${r.passed}/${r.total} ${(r.ms / 1000).toFixed(1).padStart(5)}s${failed.length ? '  FAIL: ' + failed.join('; ') : ''}${r.error ? '  ERROR: ' + r.error : ''}`);
    }
  }));
  const cost = results.reduce((n, r) => n + r.costUsd, 0);
  const summary = { model: MODEL, runs: results.length, fullyPassed: results.filter((r) => r.passed === r.total).length,
    checks: `${results.reduce((n, r) => n + r.passed, 0)}/${results.reduce((n, r) => n + r.total, 0)}`, costUsd: +cost.toFixed(4),
    avgSeconds: +(results.reduce((n, r) => n + r.ms, 0) / results.length / 1000).toFixed(1) };
  console.log(JSON.stringify(summary, null, 1));
  mkdirSync(new URL('./results/', import.meta.url), { recursive: true });
  writeFileSync(new URL(`./results/users-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, import.meta.url), JSON.stringify({ summary, results }, null, 1));
}
