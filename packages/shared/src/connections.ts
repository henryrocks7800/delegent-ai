// The connectable-service catalogue.
//
// Single source of truth for what a user's coworker can plug into and for every
// word the reader is shown before they grant it. Both surfaces render this list
// rather than re-deriving it, so the phone and the browser cannot end up making
// different promises about the same account.
//
// The copy is not decorative. The safety sheet is the last screen written in our
// voice before the reader is handed to the provider, so every capability line
// has to map to something a granted scope actually permits.

// 2026-07-28 (Alex): the typed-credential mode is gone with the mailbox that was
// its only user. It asked the reader to paste a password into a screen we drew,
// which is the exact habit the brokered hand-off exists to break, so it is not
// coming back for a provider that has an OAuth route.
//
// The 'guided' escape hatch (hand setup to the agent in chat) went with it. Only
// the phone ever implemented it, so a guided service would have sent a browser
// user into an OAuth start that cannot complete. Brokered is the one route.
export type ConnectionMode = 'oauth';

export type ConnectionCategory =
  | 'tasks'
  | 'email'
  | 'calendar'
  | 'files'
  | 'messaging'
  | 'code'
  | 'money'
  | 'social'
  | 'search'
  | 'web';

export const CONNECTION_CATEGORY_LABELS: Record<ConnectionCategory, string> = {
  files: 'Files and storage',
  email: 'Email',
  calendar: 'Calendar',
  messaging: 'Messaging',
  code: 'Code',
  tasks: 'Tasks and projects',
  money: 'Money and accounts',
  social: 'Social media',
  search: 'Web search',
  web: 'Web',
};

/** Order categories appear in on the Connections screen. */
export const CONNECTION_CATEGORY_ORDER: readonly ConnectionCategory[] = [
  'files',
  'email',
  'calendar',
  'messaging',
  'code',
  'tasks',
  'money',
  'web',
  'social',
  'search',
];

/**
 * One statement on the sheet shown BEFORE we hand the user to the provider.
 *
 * This screen is the whole point of the journey and is deliberately not
 * skippable. It is the last moment the user is reading our words rather than
 * the provider's, so it is where the honest version of "what am I agreeing to"
 * has to live. Every statement must be true of what we actually built; if a
 * behaviour changes, the wording changes with it.
 */
export interface ConnectionSafetyStatement {
  readonly heading: string;
  readonly body: string;
}

/**
 * The provider's own mark, carried as path data rather than an image file.
 *
 * Path data because the phone and the browser draw SVG through different
 * libraries but from the same coordinates, so neither surface can end up with
 * a different-looking logo, and because nothing has to be fetched at render
 * time on a screen the reader is being asked to make a decision on.
 *
 * The glyph is the provider's, unmodified, in the provider's own colour. It is
 * there to say "this is the account you already have", which is the only thing
 * a mark next to a name is allowed to mean: recolouring or reshaping it would
 * both look wrong and be a change that is not ours to make.
 */
export interface BrandMark {
  readonly viewBox: string;
  /** One filled path. Multi-colour marks would need a richer shape than this. */
  readonly path: string;
  readonly color: string;
}

export interface ConnectableService {
  /** Exact vault service string. Also the /api/connections path segment. */
  readonly id: string;
  readonly name: string;
  /**
   * Null for anything with no third-party brand behind it, e.g. a plain
   * mailbox. Surfaces render the name alone rather than a placeholder shape.
   */
  readonly brandMark: BrandMark | null;
  /** One calm line describing what connecting unlocks. */
  readonly blurb: string;
  readonly category: ConnectionCategory;
  /**
   * The user signs in at the provider and we broker the grant, so no credential
   * is ever typed into this app.
   */
  readonly mode: ConnectionMode;
  /**
   * WHICH BROKER holds the grant. Both are brokered and neither puts a
   * credential in this app; they differ only in who stores the token.
   *
   *   'native'   our own Worker broker, encrypted in our database. Every
   *              service that predates 2026-09-01.
   *   'composio' a third party holds the token and we call them per request.
   *
   * It exists so the UI can join a row to the right endpoint, and so nobody has
   * to guess. Adding a service on one backend must never quietly change how an
   * existing one is stored, which is why the existing set stays native rather
   * than being migrated wholesale.
   */
  readonly backend: 'native' | 'composio';
  /** Where the user goes to create the credential. */
  readonly helpUrl: string | null;
  /**
   * What the coworker can genuinely do once connected. Claim-audited: every
   * line must map to a capability that actually exists, because this list is
   * the promise the user decides on.
   */
  readonly capabilities: readonly string[];
  /** Plain-English rendering of the scopes we ask the provider for. */
  readonly permissions: readonly string[];
  /** Shown before the hand-off. Empty for non-oauth services. */
  readonly safety: readonly ConnectionSafetyStatement[];
  /**
   * What the coworker says it can now do, the moment a connection lands. One
   * sentence, in its own voice, and held to the same audit as `capabilities`.
   * Null for anything with no hand-off and so no arrival to announce.
   */
  readonly connectedSummary: string | null;
  /**
   * The suggested opening move. It appears in the announcement AND on the
   * button under it, from this one field, because the two used to be written
   * separately and the button still offered to look inside Dropbox after the
   * user had connected something else entirely.
   */
  readonly firstPrompt: string | null;
}

// Dropbox is the first OAuth-backed connection and the template for the rest.
//
// The sign-in is brokered off the workspace: the coworker asks for a short-lived
// access token per command via `delegent-connect run --service dropbox`, and
// calls Dropbox's own HTTP API with it. Adding the next provider is another
// entry in this file plus one row of Worker config.
//
// The capability lines are claim-audited against what the granted scopes
// actually permit (search, list folder, read file, create, copy, move, delete).
// Do not add a line here that no scope backs.
const COMPOSIO_DISCLOSURE = (provider: string) => ({
  heading: 'The permission screen will say Composio',
  body: `We broker this connection through a company called Composio, so the ${provider} screen names them rather than Delegent AI. Holding connections like this one safely is the whole of what they do, and it means your ${provider} sign-in is never handled by us. Nothing else changes: your coworker still asks us, and we still ask them.`,
});

const COMPOSIO_SHARED = (thing: string) => ({
  heading: 'What gets shared',
  body: `The connection is held encrypted by our broker, never in your chat and never in this app. Your coworker reads ${thing} when a job needs it. Nothing is copied elsewhere and nothing is used to train anything.`,
});

const DROPBOX: ConnectableService = {
  id: 'dropbox',
  name: 'Dropbox',
  brandMark: {
    viewBox: '0 0 24 24',
    path: 'M6 1.807L0 5.629l6 3.822 6.001-3.822L6 1.807zM18 1.807l-6 3.822 6 3.822 6-3.822-6-3.822zM0 13.274l6 3.822 6.001-3.822L6 9.452l-6 3.822zM18 9.452l-6 3.822 6 3.822 6-3.822-6-3.822zM6 18.311l6.001 3.822 6-3.822-6-3.822-6.001 3.822z',
    color: '#0061FF',
  },
  blurb: 'Let your coworker find, read and organise your Dropbox files.',
  category: 'files',
  mode: 'oauth',
  backend: 'composio',
  helpUrl: 'https://www.dropbox.com/account/connected_apps',
  capabilities: [
    'Search everything in your Dropbox and find the right file without you hunting for it',
    'Read documents and pull out the parts you actually asked about',
    'Save its work back to Dropbox as a new file',
    'Tidy up: copy, move and rename things into the folders you want',
    'Delete files, after checking with you first',
  ],
  permissions: [
    'See the name and email on your Dropbox account',
    'See your file and folder names',
    'Read the contents of your files',
    'Create, change, move and delete files',
  ],
  safety: [
    COMPOSIO_DISCLOSURE('Dropbox'),
    {
      heading: 'You stay in control',
      body: 'Your coworker only gets the permissions you approve on the next screen, and it can only reach files your own Dropbox account can already see. You can disconnect it here, or from Dropbox, at any time.',
    },
    {
      heading: 'Connected apps carry real risk',
      body: 'Once connected, your coworker can act on your Dropbox for you. A file or a message that contains hidden instructions could try to make it do something you never asked for. It will always check with you before it deletes, moves or overwrites anything.',
    },
    {
      heading: 'What gets shared',
      body: 'The connection is held encrypted by Composio, the broker we use, never in your chat and never on this device. Your coworker reads file names, folders and file contents when a job needs them. Your Dropbox is not copied anywhere and we do not use it to train anything.',
    },
  ],
  connectedSummary: 'I can search it, read your files, save work back into it and tidy things up for you.',
  firstPrompt: 'Have a look in my Dropbox and tell me what is in there.',
};

// Slack, as the user rather than as a bot. A bot would have to be invited to
// every channel and would post under its own name; a user token means the
// coworker sees exactly what the person who connected it can see, and nothing
// more. That is also the limit worth being loud about: it can post as them.
const SLACK: ConnectableService = {
  id: 'slack',
  name: 'Slack',
  brandMark: {
    viewBox: '0 0 24 24',
    path: 'M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z',
    color: '#4A154B',
  },
  blurb: 'Let your coworker read your Slack and answer for you.',
  category: 'messaging',
  mode: 'oauth',
  backend: 'composio',
  helpUrl: 'https://slack.com/apps/manage',
  capabilities: [
    'Search your Slack and find the conversation you only half remember',
    'Catch you up on a channel you have not read for a week',
    'Tell you who said what, by name, so a thread makes sense out of context',
    'Post a reply as you, when you ask it to',
  ],
  permissions: [
    'See the channels in your workspace',
    'Read messages in the public channels you are in',
    'See and read the private channels you are in',
    'Search your messages, including your direct messages',
    'Send messages as you',
    'See the names of people in your workspace',
  ],
  safety: [
    COMPOSIO_DISCLOSURE('Slack'),
    {
      heading: 'It sees what you see',
      body: 'Your coworker joins as you, so it can reach exactly what your own Slack account can already reach and nothing else. A private channel you are not in stays invisible to it. Slack search covers your direct messages, so a search can surface one, but your coworker is not given your direct messages to read through. You can disconnect it here, or from Slack, at any time.',
    },
    {
      heading: 'Connected apps carry real risk',
      body: 'Once connected, your coworker can read your conversations and post under your name, so to everyone else a message it sends looks like it came from you. A message in a channel could also carry hidden instructions that try to make it do something you never asked for.',
    },
    {
      heading: 'What gets shared',
      body: 'The connection is held encrypted by Composio, the broker we use, never in your chat and never on this device. Your coworker reads messages when a job needs them. Your Slack is not copied anywhere and we do not use it to train anything.',
    },
  ],
  connectedSummary: 'I can search your messages, catch you up on a channel and reply for you when you want me to.',
  // [2026-08-01] Was 'Catch me up on what I missed in Slack this week.' A first
  // prompt has one job: prove the connection works. That one fails at it twice
  // over. On a workspace with nothing in it yet, which is exactly what a brand
  // new Slack looks like, it truthfully returns nothing, and "nothing" reads as
  // broken. And unlike Drive's ("so I can see this working") it never says it is
  // a test, so a blank answer looks like a fault rather than an empty channel.
  // Listing channels proves the grant end to end, works on an empty workspace,
  // and stays read-only: posting into a real team's channel is not something to
  // do to someone on their first tap.
  firstPrompt: 'Tell me which Slack channels you can see, so I know this is working.',
};

// GitHub, granted repository by repository. The user picks which repositories
// on GitHub's own screen, so the honest promise is about the ones they chose,
// never about their account.
const GITHUB: ConnectableService = {
  id: 'github',
  name: 'GitHub',
  brandMark: {
    viewBox: '0 0 24 24',
    path: 'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12',
    color: '#181717',
  },
  blurb: 'Let your coworker read your code and open pull requests for you.',
  category: 'code',
  mode: 'oauth',
  backend: 'composio',
  helpUrl: 'https://github.com/settings/installations',
  capabilities: [
    'Read the code in the repositories you give it, and explain how a part of it works',
    'Make a change on a branch and open a pull request for you to look at',
    'Open an issue, or reply on one, so a job leaves a trail you can follow',
    'Read an open pull request and tell you what it actually changes',
  ],
  permissions: [
    'Read and change files in the repositories you choose',
    'Read and write issues',
    'Read and open pull requests',
  ],
  safety: [
    COMPOSIO_DISCLOSURE('GitHub'),
    {
      heading: 'You choose the repositories',
      body: 'GitHub asks you which repositories to grant on the next screen, and your coworker can reach only those. Everything else in your account stays out of reach. You can change that list, or disconnect, from GitHub at any time.',
    },
    {
      heading: 'Connected apps carry real risk',
      body: 'Once connected, your coworker can change code and open pull requests in the repositories you granted, under your name. An issue or a file it reads could carry hidden instructions that try to make it do something you never asked for, so read what it opens before you merge it.',
    },
    {
      heading: 'What gets shared',
      body: 'The connection is held encrypted by Composio, the broker we use, never in your chat and never on this device. Your coworker reads code and issues when a job needs them. Your repositories are not copied anywhere and we do not use them to train anything.',
    },
  ],
  connectedSummary: 'I can read the repositories you granted, explain how something works and open a pull request for you.',
  firstPrompt: 'Have a look at my repositories and tell me what is open right now.',
};

// Google Drive, on the drive.file scope ONLY.
//
// That scope reaches files this app created and nothing else. It cannot see the
// user's existing Drive, and there is no file picker in the product yet to hand
// it one. So every line here is about the files it makes. Reading somebody's
// whole Drive means drive.readonly, which is a restricted scope behind a paid
// annual security assessment, and we have not signed up to that.
const GOOGLE_DRIVE: ConnectableService = {
  id: 'google_drive',
  name: 'Google Drive',
  brandMark: {
    viewBox: '0 0 24 24',
    path: 'M12.01 1.485c-2.082 0-3.754.02-3.743.047.01.02 1.708 3.001 3.774 6.62l3.76 6.574h3.76c2.081 0 3.753-.02 3.742-.047-.005-.02-1.708-3.001-3.775-6.62l-3.76-6.574zm-4.76 1.73a789.828 789.861 0 0 0-3.63 6.319L0 15.868l1.89 3.298 1.885 3.297 3.62-6.335 3.618-6.33-1.88-3.287C8.1 4.704 7.255 3.22 7.25 3.214zm2.259 12.653-.203.348c-.114.198-.96 1.672-1.88 3.287a423.93 423.948 0 0 1-1.698 2.97c-.01.026 3.24.042 7.222.042h7.244l1.796-3.157c.992-1.734 1.85-3.23 1.906-3.323l.104-.167h-7.249z',
    color: '#4285F4',
  },
  blurb: 'Give your coworker a place in your Drive to put its work.',
  category: 'files',
  mode: 'oauth',
  backend: 'composio',
  helpUrl: 'https://myaccount.google.com/permissions',
  capabilities: [
    'Save its work into your Drive, where you can open it on any device',
    'Come back to something it saved before, read it and bring it up to date',
    'Keep what it makes organised in folders',
    'Share a link to something it made, when you ask for one',
  ],
  permissions: [
    'Create files in your Google Drive',
    'Open and change only the files it created',
    'See the email address on your Google account',
  ],
  safety: [
    COMPOSIO_DISCLOSURE('Google Drive'),
    {
      heading: 'It only ever sees its own files',
      body: 'This does not hand over your Drive. Your coworker can create files and reopen the ones it created, and that is the whole of it. Everything already in your Drive stays invisible to it, including anything shared with you.',
    },
    {
      heading: 'Connected apps carry real risk',
      body: 'Anything your coworker writes into your Drive is written under your name, and a document it reads back could carry hidden instructions that try to make it do something you never asked for. It will check with you before it overwrites or deletes something it saved earlier.',
    },
    {
      heading: 'What gets shared',
      body: 'The connection is held encrypted by Composio, the broker we use, never in your chat and never on this device. Your coworker reads the files it made when a job needs them. Nothing is copied anywhere else and we do not use it to train anything.',
    },
  ],
  connectedSummary: 'I can save my work into your Drive and pick it up again later, though I can only see the files I made myself.',
  firstPrompt: 'Save me a short note in Google Drive so I can see this working.',
};

// Google Calendar on calendar.events: read and write events, and nothing else
// in the Google account. Google classes that scope as sensitive, so this one
// stays dark until the OAuth client is verified, which is exactly what the
// broker's credential gate does for us.
const GOOGLE_CALENDAR: ConnectableService = {
  id: 'google_calendar',
  name: 'Google Calendar',
  brandMark: {
    viewBox: '0 0 24 24',
    path: 'M18.316 5.684H24v12.632h-5.684V5.684zM5.684 24h12.632v-5.684H5.684V24zM18.316 5.684V0H1.895A1.894 1.894 0 0 0 0 1.895v16.421h5.684V5.684h12.632zm-7.207 6.25v-.065c.272-.144.5-.349.687-.617s.279-.595.279-.982c0-.379-.099-.72-.3-1.025a2.05 2.05 0 0 0-.832-.714 2.703 2.703 0 0 0-1.197-.257c-.6 0-1.094.156-1.481.467-.386.311-.65.671-.793 1.078l1.085.452c.086-.249.224-.461.413-.633.189-.172.445-.257.767-.257.33 0 .602.088.816.264a.86.86 0 0 1 .322.703c0 .33-.12.589-.36.778-.24.19-.535.284-.886.284h-.567v1.085h.633c.407 0 .748.109 1.02.327.272.218.407.499.407.843 0 .336-.129.614-.387.832s-.565.327-.924.327c-.351 0-.651-.103-.897-.311-.248-.208-.422-.502-.521-.881l-1.096.452c.178.616.505 1.082.977 1.401.472.319.984.478 1.538.477a2.84 2.84 0 0 0 1.293-.291c.382-.193.684-.458.902-.794.218-.336.327-.72.327-1.149 0-.429-.115-.797-.344-1.105a2.067 2.067 0 0 0-.881-.689zm2.093-1.931l.602.913L15 10.045v5.744h1.187V8.446h-.827l-2.158 1.557zM22.105 0h-3.289v5.184H24V1.895A1.894 1.894 0 0 0 22.105 0zm-3.289 23.5l4.684-4.684h-4.684V23.5zM0 22.105C0 23.152.848 24 1.895 24h3.289v-5.184H0v3.289z',
    color: '#4285F4',
  },
  blurb: 'Let your coworker see your diary and arrange things in it.',
  category: 'calendar',
  mode: 'oauth',
  backend: 'composio',
  helpUrl: 'https://myaccount.google.com/permissions',
  capabilities: [
    'Look at what is on your calendar and tell you where your free time actually is',
    'Put something in your diary with the right people invited',
    'Move or cancel a meeting when a plan changes',
    'Read the notes on an event so it knows what a meeting is for before it acts',
  ],
  permissions: [
    'See the events on your calendar',
    'Create, change and cancel events',
  ],
  safety: [
    {
      heading: 'The permission screen will say Composio',
      body: 'We broker this connection through a company called Composio, so the Google screen names them rather than Delegent AI. Holding connections like this one safely is the whole of what they do, and it means your Google sign-in is never handled by us. Nothing else changes: your coworker still asks us, and we still ask them.',
    },
    {
      heading: 'Your diary, nothing else',
      body: 'Your coworker can see and change events on your calendar. It gets nothing else from your Google account, and it cannot read your email or your files with this. You can disconnect it here, or from your Google account, at any time.',
    },
    {
      heading: 'Connected apps carry real risk',
      body: 'Once connected, your coworker can create and cancel events under your name, and an invitation it sends goes out as you. An event description could also carry hidden instructions that try to make it do something you never asked for. It will check with you before it cancels or moves anything.',
    },
    {
      heading: 'What gets shared',
      body: 'The connection is held encrypted by our broker, never in your chat and never in this app. Your coworker reads your events when a job needs them. Your calendar is not copied anywhere and we do not use it to train anything.',
    },
  ],
  connectedSummary: 'I can see what is in your diary, find your free time and arrange things for you.',
  firstPrompt: 'What is on my calendar tomorrow?',
};

// 2026-07-25 (Alex's call): the catalogue is deliberately down to the one service
// that genuinely works end to end from the app. The six removed entries (Todoist,
// Gmail, Google Calendar, Dropbox, FreeAgent, website hosting) overlapped
// confusingly with the skills that already do the same jobs, and five of them only
// ever handed the user back into chat, which is indistinguishable from not having
// a Connections screen at all. Credentials already in a user's vault under those
// service names are untouched and the on-box skills still read them; only the
// advertised surface shrank. Real OAuth-backed entries replace them.
//
// 2026-07-28 (Alex): the mailbox went the same way, for the same reason in
// reverse. It was the last entry a user set up by typing a password into our own
// UI, which is the habit every other card on this screen is built to avoid, and
// it gave its own mailbox rather than connecting one they already had. The
// on-box agent-email-inbox skill and any vault credential under `agent_mail`
// still work untouched; it is only off the menu.
/**
 * Both Microsoft entries ship with no mark, which is deliberate rather than
 * unfinished. Microsoft had its brand glyphs removed from the icon set everyone
 * else here came from, and the only correct sources are Microsoft's own brand
 * assets, which come with trademark terms somebody has to agree to. Drawing an
 * approximation of a trademark from memory would be both wrong-looking and not
 * ours to do, so the surfaces render the name alone until that call is made.
 */

// Outlook on Mail.Read. Read only: Microsoft keeps sending behind a separate
// Mail.Send scope which is not requested, so "it cannot send mail as you" is a
// claim the registration actually backs.
//
// The honest limit, and it is stated on the sheet rather than buried: Microsoft
// has no per-folder permission for this, so agreeing to it means the whole
// mailbox. Drive got to say "only the files it made" because drive.file exists;
// there is no equivalent here, and pretending otherwise would be the kind of
// line nobody catches until they ask it to find an email.
const MICROSOFT_OUTLOOK: ConnectableService = {
  id: 'microsoft_outlook',
  name: 'Outlook',
  brandMark: null,
  blurb: 'Let your coworker read your Outlook mail, and find money you may be owed.',
  category: 'email',
  mode: 'oauth',
  backend: 'composio',
  helpUrl: 'https://myapps.microsoft.com',
  capabilities: [
    'Find money you may be owed: flight compensation, refunds that never came, double charges and forgotten subscriptions',
    'Read through your inbox and tell you what actually needs you today',
    'Find the email you half remember, without you knowing the search terms',
    'Pull the details out of a long thread and give you the short version',
    'Read an attachment and answer questions about what is in it',
    'Draft a reply for you to send yourself, in your own client',
  ],
  permissions: [
    'Read the mail in your mailbox, including attachments',
    'See the name and email address on your Microsoft account',
  ],
  safety: [
    COMPOSIO_DISCLOSURE('Microsoft Outlook'),
    {
      heading: 'This is your whole mailbox',
      body: 'Microsoft does not offer a way to share only one folder, so connecting this lets your coworker read any email in your account, old or new. If that is more than you want to hand over, this is the one to skip. It cannot send email, delete anything or change a single message.',
    },
    {
      heading: 'Reading email carries a particular risk',
      body: 'An email can be written by anyone, and one that lands in your inbox could carry hidden instructions meant to be read by your coworker rather than by you. It is built to treat the contents of a message as information and not as an order from you, but this is the connection where that matters most, so be wary of asking it to act on a mail from someone you do not know.',
    },
    {
      heading: 'What gets shared',
      body: 'The connection is held encrypted by Composio, the broker we use, never in your chat and never on this device. Your coworker reads your mail when a job needs it. Nothing is copied anywhere else and we do not use it to train anything.',
    },
    {
      heading: 'Turning it off',
      body: 'Disconnecting here deletes our copy of the connection straight away and your coworker loses access within the hour. Microsoft has no way for us to remove the entry from your account for you, so to clear it fully, sign in at myapps.microsoft.com and revoke it there too.',
    },
  ],
  // The first thing people ask after connecting is "so how do I find my money?"
  // (Alex's sister, 2026-09-26), so the wake message and the try-me line lead
  // with Money Finder rather than leaving it to be discovered.
  connectedSummary: 'I can read your Outlook mail, so I can find money you may be owed, tell you what needs you and find things you half remember. I cannot send anything.',
  firstPrompt: 'Find money I might be owed in my inbox.',
};

// Teams on Chat.Read, which is one-to-one and group chats only.
//
// Channels are missing because Microsoft puts them behind ChannelMessage.Read.All
// and marks it admin-consent-required: an ordinary employee cannot approve it,
// so a card promising channels would fail for everybody who is not their own IT
// department. Better to offer the half that works for anyone than the whole
// thing for almost nobody. Chat.ReadWrite would let it post as the user and is
// deliberately not requested.
const MICROSOFT_TEAMS: ConnectableService = {
  id: 'microsoft_teams',
  name: 'Microsoft Teams',
  brandMark: null,
  blurb: 'Let your coworker catch up on your Teams chats.',
  category: 'messaging',
  mode: 'oauth',
  backend: 'composio',
  helpUrl: 'https://myapps.microsoft.com',
  capabilities: [
    'Catch you up on a chat you have not read',
    'Find the message where something was agreed, and tell you when',
    'Pull the actions out of a long back and forth so nothing is dropped',
  ],
  permissions: [
    'Read your one-to-one and group chats in Teams',
    'See the name and email address on your Microsoft account',
  ],
  safety: [
    COMPOSIO_DISCLOSURE('Microsoft Teams'),
    {
      heading: 'Chats only, not channels',
      body: 'This covers your one-to-one and group chats. It does not cover team channels: Microsoft only lets an IT administrator approve that, so it is not something we can offer you directly. Your coworker can read those chats and nothing else in your Microsoft account.',
    },
    {
      heading: 'It cannot say anything as you',
      body: 'Reading only. Your coworker cannot post a message, reply, or react in Teams under your name. Bear in mind a chat may include people outside your organisation, and a message could carry hidden instructions aimed at your coworker rather than at you.',
    },
    {
      heading: 'What gets shared',
      body: 'The connection is held encrypted by Composio, the broker we use, never in your chat and never on this device. Your coworker reads your Teams messages when a job needs them. Nothing is copied anywhere else and we do not use it to train anything.',
    },
    {
      heading: 'Turning it off',
      body: 'Disconnecting here deletes our copy of the connection straight away and your coworker loses access within the hour. Microsoft has no way for us to remove the entry from your account for you, so to clear it fully, sign in at myapps.microsoft.com and revoke it there too.',
    },
  ],
  connectedSummary: 'I can read your Teams chats, so I can catch you up and find what was agreed. I cannot post as you, and I cannot see team channels.',
  firstPrompt: 'Catch me up on anything I have missed in Teams.',
};

// FreeAgent is the first connection where the grant CANNOT be narrowed, and the
// card has to say so out loud rather than list a comfortable subset.
//
// FreeAgent has no scope system: approving the app gives full access to that
// company's books, including creating and deleting. Stripe was rejected for
// exactly this (docs/connections/STATUS.md) because nobody needs a chat
// assistant that can move money. Bookkeeping is the case where write access is
// the entire point, since an assistant that cannot enter an expense cannot do
// the job at all, so this ships with the trade-off stated in the permissions
// list and again in the safety sheet.
//
// The mark is FreeAgent's OWN glyph, taken from https://www.freeagent.com/icon.svg
// (their published site icon), not an approximation drawn by hand. Their file is
// a gradient tile with the glyph knocked out in white; this type carries one
// filled path in one colour, so the three glyph subpaths are concatenated and
// rendered in FreeAgent's own blue, which is the same monochrome treatment every
// other card gets. viewBox is theirs, unchanged, so the proportions are right.
const FREEAGENT: ConnectableService = {
  id: 'freeagent',
  name: 'FreeAgent',
  brandMark: {
    viewBox: '0 0 400 400',
    path: 'M65.8,45.3c2.4,6.5,13.1,13.6,26.6,19.8L89.8,64l56.9,26.2c25.2,11.6,36.8,29.8,35.7,51.1c-10.8-16.9-29.9-28.4-59.6-28.4H88.5C56,99.6,52.4,63.6,65.8,45.3L65.8,45.3z M122.9,129.1H60.2c-13,0-27-1.3-32.4-6.8c-3.7,21.7,10.2,47.1,51.4,47.1h39.6c18.7,0,31.2,6.3,33,19.9c-4.8-2.4-11.4-3.6-22.7-3.6H81.5c6.3,20.7,21.9,33.8,47.6,33.8H150c14.4,0,21,1.6,25.8,6.4C187.8,167.2,170.2,129.1,122.9,129.1L122.9,129.1z M247.1,219.6l9.1-67.6h50.2c30.5,0,55.7-12.7,54.7-52.9H205.4L169.8,364h57.9l12.8-94.8h38.3c32.3,0,50.1-19.9,49-49.6L247.1,219.6L247.1,219.6z',
    color: '#0069BF',
  },
  blurb: 'Let your coworker keep your books up to date in FreeAgent.',
  category: 'money',
  mode: 'oauth',
  backend: 'native',
  helpUrl: 'https://dev.freeagent.com/',
  capabilities: [
    'Enter your receipts and bills as expenses, with the right category picked for you',
    'Attach the receipt itself to each entry, so the evidence sits with the number',
    'Check what has come in and gone out, and tell you where you actually are',
    'Match your spending against your bank feed so nothing is missed or counted twice',
    'Pull the figures together for your accountant at year end',
  ],
  permissions: [
    'Full access to your FreeAgent account: read everything, and create, change and delete records',
    'See your company details, bank transactions, expenses, invoices and contacts',
  ],
  safety: [
    {
      heading: 'FreeAgent cannot give partial access',
      body: 'This one is all or nothing, and that is FreeAgent\'s design, not our choice. There is no read-only option to offer you: approving this gives your coworker the same reach over your books that you have, including changing and deleting entries. Connect it only if you want it actually doing your bookkeeping, and disconnect it here whenever you want.',
    },
    {
      heading: 'It will check before it changes your books',
      body: 'Your coworker asks you first before it creates or deletes anything in FreeAgent, and it tells you what it did afterwards. It only says something is entered once it has read it back from your account and seen it there. A receipt could also carry hidden instructions that try to make it do something you never asked for, which is why nothing lands without you seeing it.',
    },
    {
      heading: 'What gets shared',
      body: 'We store the FreeAgent connection on our own servers, encrypted, and never in your chat. Your coworker reads your books when a job needs it. Your accounts are not copied anywhere and we do not use them to train anything. Disconnecting deletes our copy; you can also remove the app from your own FreeAgent settings.',
    },
  ],
  connectedSummary: 'I can keep your books up to date in FreeAgent, enter receipts with the evidence attached, and tell you where you stand.',
  firstPrompt: 'Where am I up to this month?',
};

// Yahoo Mail (and AOL Mail), on our OWN broker, not Composio: no Composio-like
// service covers Yahoo at a viable price (research 2026-09-25). Read-only
// (mail-r). NOT in CONNECTABLE_SERVICES yet: Yahoo must approve our Mail API
// access first. On approval, add YAHOO_MAIL to the list, remove yahoo_mail
// from PENDING_CARDS / PENDING_PROVIDERS in the two wiring tests, set the two
// Worker secrets, and ship the card in the same release.
//
// The mark is a plain envelope in Yahoo's purple, not Yahoo's logo; swap in
// their published glyph (as FreeAgent's is) once approved and permitted.
export const YAHOO_MAIL: ConnectableService = {
  id: 'yahoo_mail',
  name: 'Yahoo Mail',
  brandMark: {
    viewBox: '0 0 24 24',
    path: 'M3 5h18a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm1.4 2L12 12.2 19.6 7H4.4zM20 8.4l-8 5.4-8-5.4V17h16V8.4z',
    color: '#6001D2',
  },
  blurb: 'Let your coworker read your Yahoo or AOL inbox, for example to find money you are owed.',
  category: 'email',
  mode: 'oauth',
  backend: 'native',
  helpUrl: 'https://login.yahoo.com/account/security',
  capabilities: [
    'Find money you may be owed in your inbox: flight compensation, refunds that never arrived and upgrades charged in full',
    'List the subscriptions you are paying for, with what each costs a year',
  ],
  permissions: [
    'Read your emails and folders (read-only)',
    'See your email address',
  ],
  safety: [
    {
      heading: "You sign in on Yahoo's own page",
      body: 'We never see your Yahoo password. Yahoo gives us read-only access: your coworker can read your mail but cannot send, move or delete anything.',
    },
    {
      heading: 'What gets shared',
      body: "We store the Yahoo connection on our own servers, encrypted, and never in your chat. Your coworker reads your mailbox only for a job you ask for. We do not use your emails for advertising, sell them or use them to train anything. Disconnecting deletes our copy; you can also remove Delegent AI in your Yahoo account's security settings.",
    },
  ],
  connectedSummary: 'I can now read your Yahoo inbox. Ask me to find money you may be owed, and I will check it for you.',
  firstPrompt: 'Find money I might be owed in my Yahoo inbox.',
};

// Gmail, the first connection brokered by Composio rather than by our own
// Worker broker.
//
// WHY IT IS HERE AT ALL. Gmail was ruled out on 2026-08-06 because reading a
// mailbox needs Google's restricted scopes, and those need a paid annual CASA
// security audit. That has not changed. What changed is that a third-party
// broker can be the audited party, so we can find out whether customers
// actually want this BEFORE buying an audit. If they do, we buy our own OAuth
// app and the audit, and this entry keeps working unchanged.
//
// ⚠️ THE CONSENT SCREEN SAYS COMPOSIO, NOT DELEGENT AI, and the safety sheet
// below says so plainly. Hiding that would be exactly the kind of small
// dishonesty this screen exists to avoid: the reader is about to hand over
// their email, and the name on the dialog will not be ours.
const GMAIL: ConnectableService = {
  id: 'gmail',
  name: 'Gmail',
  brandMark: {
    viewBox: '0 0 24 24',
    path: 'M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z',
    color: '#EA4335',
  },
  blurb: 'Let your coworker read, draft and send email from your Gmail, and find money you may be owed.',
  category: 'email',
  mode: 'oauth',
  backend: 'composio',
  helpUrl: 'https://myaccount.google.com/permissions',
  capabilities: [
    'Find money you may be owed: flight compensation, refunds that never came, double charges and forgotten subscriptions',
    'Read your email and tell you what actually needs you',
    'Draft replies in your words, for you to look at before they go',
    'Send an email once you have said yes to it',
    'Find the message you half-remember, without you searching for it',
  ],
  permissions: [
    'Read your Gmail messages and their attachments',
    'Create drafts and send email as you',
    'See the email address on your Google account',
  ],
  safety: [
    {
      heading: 'The permission screen will say Composio',
      body: 'We broker this connection through a company called Composio, so the Google screen names them rather than Delegent AI. Holding connections like this one safely is the whole of what they do, and it means your Google sign-in is never handled by us. Nothing else changes: your coworker still asks us, and we still ask them.',
    },
    {
      heading: 'It sends nothing without you',
      body: 'It sends only when you ask it to, and shows you the email first unless you have already said exactly what to send. It will not reply to anything on its own, and it will not empty your inbox or delete anything.',
    },
    {
      heading: 'Email can carry instructions aimed at your coworker',
      body: 'A message it reads could carry hidden instructions written to make it do something you never asked for. It treats everything in your inbox as words to read rather than orders to follow, and it will check with you before anything leaves your account.',
    },
    {
      heading: 'What gets shared',
      body: 'The connection is held encrypted by our broker, never in your chat and never in this app. Your coworker reads a message when a job needs it. Nothing is copied elsewhere and nothing is used to train anything.',
    },
  ],
  // Same reason as Outlook: lead with Money Finder, the thing people connect for.
  connectedSummary: 'I can read your email, find money you may be owed, tell you what needs you, and draft replies for you to approve before anything is sent.',
  firstPrompt: 'Find money I might be owed in my inbox.',
};

const QUICKBOOKS: ConnectableService = {
  id: 'quickbooks',
  name: 'QuickBooks',
  brandMark: {
    viewBox: '0 0 24 24',
    path: 'M12 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0zm.642 4.1335c.9554 0 1.7296.776 1.7296 1.7332v9.0667h1.6c1.614 0 2.9275-1.3156 2.9275-2.933 0-1.6173-1.3136-2.9333-2.9276-2.9333h-.6654V7.3334h.6654c2.5722 0 4.6577 2.0897 4.6577 4.667 0 2.5774-2.0855 4.6666-4.6577 4.6666H12.642zM7.9837 7.333h3.3291v12.533c-.9555 0-1.73-.7759-1.73-1.7332V9.0662H7.9837c-1.6146 0-2.9277 1.316-2.9277 2.9334 0 1.6175 1.3131 2.9333 2.9277 2.9333h.6654v1.7332h-.6654c-2.5725 0-4.6577-2.0892-4.6577-4.6665 0-2.5771 2.0852-4.6666 4.6577-4.6666Z',
    color: '#2CA01C',
  },
  blurb: 'Let your coworker look up who owes you, who you owe, and your accounts in QuickBooks.',
  category: 'money',
  mode: 'oauth',
  backend: 'composio',
  helpUrl: 'https://app.qbo.intuit.com/app/apps',
  // Honest to what the broker can actually do today: customers, suppliers,
  // accounts and balance reports. It cannot raise invoices or match a bank
  // feed yet, and the card must not imply it can.
  capabilities: [
    'Tell you who owes you money and who you owe, from your live balances',
    'Look up a customer, a supplier or an account without you opening QuickBooks',
    'Add a new customer or supplier when you ask it to',
    'Read your chart of accounts and explain what is in it',
  ],
  permissions: [
    'Read your QuickBooks accounting data: customers, suppliers, accounts and balance reports',
    'Create customers and suppliers in your company file',
    'See the email address on your Intuit account',
  ],
  safety: [
    {
      heading: 'The permission screen will say Composio',
      body: 'We broker this connection through a company called Composio, so the Intuit screen names them rather than Delegent AI. Holding connections like this one safely is the whole of what they do, and it means your Intuit sign-in is never handled by us. Nothing else changes: your coworker still asks us, and we still ask them.',
    },
    {
      heading: 'What it can and cannot do yet',
      body: 'Today it can read your customers, suppliers, accounts and balance reports, and add a customer or supplier. It cannot yet raise an invoice, enter a receipt or match your bank feed in QuickBooks. If you want your coworker actually keeping your books, FreeAgent is the connection that does the whole job.',
    },
    {
      heading: 'It will check with you before it creates anything',
      body: 'Reading your books needs no permission from you each time. Creating a customer or supplier happens only when you ask for it: your coworker tells you what it did afterwards, and only say something is there once it has read it back from your company file. A name or memo in your books could also carry hidden instructions aimed at your coworker, which is why nothing is created without you seeing it.',
    },
    {
      heading: 'What gets shared',
      body: 'The connection is held encrypted by our broker, never in your chat and never in this app. Your coworker reads your books when a job needs it. Nothing is copied elsewhere and nothing is used to train anything. Disconnecting removes the connection at our broker, and you can also remove the app under Apps in QuickBooks itself.',
    },
  ],
  connectedSummary: 'I can tell you who owes you and who you owe, look up customers, suppliers and accounts in QuickBooks, and add new ones when you ask.',
  firstPrompt: 'Who owes me money right now?',
};

const GOOGLE_SHEETS: ConnectableService = {
  id: 'google_sheets',
  name: 'Google Sheets',
  brandMark: {
    viewBox: '0 0 24 24',
    path: 'M11.318 12.545H7.91v-1.909h3.41v1.91zM14.728 0v6h6l-6-6zm1.363 10.636h-3.41v1.91h3.41v-1.91zm0 3.273h-3.41v1.91h3.41v-1.91zM20.727 6.5v15.864c0 .904-.732 1.636-1.636 1.636H4.909a1.636 1.636 0 0 1-1.636-1.636V1.636C3.273.732 4.005 0 4.909 0h9.318v6.5h6.5zm-3.273 2.773H6.545v7.909h10.91v-7.91zm-6.136 4.636H7.91v1.91h3.41v-1.91z',
    color: '#34A853',
  },
  blurb: 'Let your coworker read and update the spreadsheets you point it at.',
  category: 'files',
  mode: 'oauth',
  backend: 'composio',
  helpUrl: 'https://myaccount.google.com/permissions',
  capabilities: [
    'Read a spreadsheet you share the link to and answer questions from it',
    'Add rows, update cells and keep a sheet you use together up to date',
    'Create a new spreadsheet and put its work in it',
    'Find a row by what is in it, without you scrolling',
  ],
  permissions: [
    'Read and change spreadsheets you give it a link to',
    'Create spreadsheets in your Google Drive, and open the ones it created',
  ],
  safety: [
    {
      heading: 'The permission screen will say Composio',
      body: 'We broker this connection through a company called Composio, so the Google screen names them rather than Delegent AI. Holding connections like this one safely is the whole of what they do, and it means your Google sign-in is never handled by us. Nothing else changes: your coworker still asks us, and we still ask them.',
    },
    {
      heading: 'Give it the link',
      body: 'Your coworker cannot browse your Drive with this. It can open any spreadsheet you give it a link to, and it can find by name only the ones it created itself. That is deliberate: it is the narrowest permission Google offers that still lets it work on your sheets, rather than one that sees every file you own.',
    },
    {
      heading: 'It will check with you before it changes anything',
      body: 'Reading is free. Adding rows, changing cells or clearing anything is not: that happens when you ask for it, and your coworker reads the sheet back before it says the change is in. A cell could also carry hidden instructions aimed at your coworker, which is why nothing is changed without you seeing it.',
    },
    {
      heading: 'What gets shared',
      body: 'The connection is held encrypted by our broker, never in your chat and never in this app. Your coworker reads a sheet when a job needs it. Nothing is copied elsewhere and nothing is used to train anything.',
    },
  ],
  connectedSummary: 'I can read and update the spreadsheets you point me at, add rows, and create new ones for my work.',
  firstPrompt: 'Here is a link to my sheet. What does it say?',
};

const GOOGLE_DOCS: ConnectableService = {
  id: 'google_docs',
  name: 'Google Docs',
  brandMark: {
    viewBox: '0 0 24 24',
    path: 'M14.727 6.727H14V0H4.91c-.905 0-1.637.732-1.637 1.636v20.728c0 .904.732 1.636 1.636 1.636h14.182c.904 0 1.636-.732 1.636-1.636V6.727h-6zm-.545 10.455H7.09v-1.364h7.09v1.364zm2.727-3.273H7.091v-1.364h9.818v1.364zm0-3.273H7.091V9.273h9.818v1.363zM14.727 6h6l-6-6v6z',
    color: '#4285F4',
  },
  blurb: 'Let your coworker read, write and edit the documents you point it at.',
  category: 'files',
  mode: 'oauth',
  backend: 'composio',
  helpUrl: 'https://myaccount.google.com/permissions',
  capabilities: [
    'Read a document you share the link to and tell you what it says',
    'Write a new document from a brief, in Google Docs where you can edit it',
    'Change the wording in a document you point it at, when you ask',
    'Find and replace across a document without you doing it by hand',
  ],
  permissions: [
    'Read and change documents you give it a link to',
    'Create documents in your Google Drive, and open the ones it created',
  ],
  safety: [
    {
      heading: 'The permission screen will say Composio',
      body: 'We broker this connection through a company called Composio, so the Google screen names them rather than Delegent AI. Holding connections like this one safely is the whole of what they do, and it means your Google sign-in is never handled by us. Nothing else changes: your coworker still asks us, and we still ask them.',
    },
    {
      heading: 'Give it the link',
      body: 'Your coworker cannot browse your Drive with this. It can open any document you give it a link to, and it can find by name only the ones it created itself. That is deliberate: it is the narrowest permission Google offers that still lets it work on your documents, rather than one that sees every file you own.',
    },
    {
      heading: 'It will check with you before it changes anything',
      body: 'Reading is free. Rewriting, replacing or deleting text is not: that happens when you ask for it, and your coworker reads the document back before it says the change is in. A document could also carry hidden instructions aimed at your coworker, which is why nothing is changed without you seeing it.',
    },
    {
      heading: 'What gets shared',
      body: 'The connection is held encrypted by our broker, never in your chat and never in this app. Your coworker reads a document when a job needs it. Nothing is copied elsewhere and nothing is used to train anything.',
    },
  ],
  connectedSummary: 'I can read the documents you point me at, write new ones from a brief, and edit wording when you ask.',
  firstPrompt: 'Write me a one-page summary of this as a Google Doc.',
};

const NOTION: ConnectableService = {
  id: 'notion',
  name: 'Notion',
  brandMark: {
    viewBox: '0 0 24 24',
    path: 'M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.373-1.54 1.447-1.632z',
    color: '#000000',
  },
  blurb: 'Let your coworker read and write in the Notion pages you share with it.',
  category: 'tasks',
  mode: 'oauth',
  backend: 'composio',
  helpUrl: 'https://www.notion.so/my-integrations',
  capabilities: [
    'Read the pages and databases you have shared with it and answer from them',
    'Write a new page from a brief, in the place you point it at',
    'Add a row to a database, like a task list or a CRM, when you ask',
    'Find the page you half-remember by its title',
  ],
  permissions: [
    'Read and change the Notion pages and databases you choose to share with it',
    'Create pages and database rows inside those',
  ],
  safety: [
    {
      heading: 'The permission screen will say Composio',
      body: 'We broker this connection through a company called Composio, so the Notion screen names them rather than Delegent AI. Holding connections like this one safely is the whole of what they do, and it means your Notion sign-in is never handled by us. Nothing else changes: your coworker still asks us, and we still ask them.',
    },
    {
      heading: 'You choose which pages it can see',
      body: 'Notion asks you to pick the pages to share when you connect, and your coworker can reach only those and what sits under them. Share a whole workspace if you want, or one page. You can change the selection later from the page menu in Notion, under Connections.',
    },
    {
      heading: 'It will check with you before it changes anything',
      body: 'Reading is free. Creating a page, adding a row or editing text is not: that happens when you ask for it, and your coworker reads the page back before it says the change is in. A page could also carry hidden instructions aimed at your coworker, which is why nothing is changed without you seeing it.',
    },
    {
      heading: 'What gets shared',
      body: 'The connection is held encrypted by our broker, never in your chat and never in this app. Your coworker reads a page when a job needs it. Nothing is copied elsewhere and nothing is used to train anything.',
    },
  ],
  connectedSummary: 'I can read the Notion pages you have shared with me, write new ones, and add rows to your databases when you ask.',
  firstPrompt: 'What is in my Notion workspace?',
};

const TRELLO: ConnectableService = {
  id: 'trello',
  name: 'Trello',
  brandMark: {
    viewBox: '0 0 24 24',
    path: 'M21.147 0H2.853A2.86 2.86 0 000 2.853v18.294A2.86 2.86 0 002.853 24h18.294A2.86 2.86 0 0024 21.147V2.853A2.86 2.86 0 0021.147 0zM10.34 17.287a.953.953 0 01-.953.953h-4a.954.954 0 01-.954-.953V5.38a.953.953 0 01.954-.953h4a.954.954 0 01.953.953zm9.233-5.467a.944.944 0 01-.953.947h-4a.947.947 0 01-.953-.947V5.38a.953.953 0 01.953-.953h4a.954.954 0 01.953.953z',
    color: '#0052CC',
  },
  blurb: 'Let your coworker keep your Trello boards moving.',
  category: 'tasks',
  mode: 'oauth',
  backend: 'composio',
  helpUrl: 'https://trello.com/my/account',
  capabilities: [
    'Tell you what is on a board and what is stuck in which list',
    'Add a card when you ask, in the right list, with a due date',
    'Move a card along, add a comment, or tick a checklist item',
    'Find the card you half-remember across your boards',
  ],
  permissions: [
    'Read your boards, lists and cards',
    'Create, change, move and archive cards, and comment on them',
    'See your Trello account name and email',
  ],
  safety: [
    {
      heading: 'The permission screen will say Composio',
      body: 'We broker this connection through a company called Composio, so the Trello screen names them rather than Delegent AI. Holding connections like this one safely is the whole of what they do, and it means your Trello sign-in is never handled by us. Nothing else changes: your coworker still asks us, and we still ask them.',
    },
    {
      heading: 'It will check with you before it changes a board',
      body: 'Reading is free. Adding, moving or archiving a card is not: that happens when you ask for it, and your coworker reads the board back before it says the change is in. A card could also carry hidden instructions aimed at your coworker, which is why nothing is changed without you seeing it.',
    },
    {
      heading: 'Every board you can see, it can see',
      body: 'Trello does not offer a per-board permission, so this connection reaches every board your account can open, including ones shared with you by other people. It only acts on the ones you point it at.',
    },
    {
      heading: 'What gets shared',
      body: 'The connection is held encrypted by our broker, never in your chat and never in this app. Your coworker reads a board when a job needs it. Nothing is copied elsewhere and nothing is used to train anything.',
    },
  ],
  connectedSummary: 'I can read your Trello boards, add and move cards when you ask, and tell you what is stuck.',
  firstPrompt: 'What is on my Trello board this week?',
};

const ASANA: ConnectableService = {
  id: 'asana',
  name: 'Asana',
  brandMark: {
    viewBox: '0 0 24 24',
    path: 'M18.78 12.653c-2.882 0-5.22 2.336-5.22 5.22s2.338 5.22 5.22 5.22 5.22-2.34 5.22-5.22-2.336-5.22-5.22-5.22zm-13.56 0c-2.88 0-5.22 2.337-5.22 5.22s2.338 5.22 5.22 5.22 5.22-2.338 5.22-5.22-2.336-5.22-5.22-5.22zm12-6.525c0 2.883-2.337 5.22-5.22 5.22-2.882 0-5.22-2.337-5.22-5.22 0-2.88 2.338-5.22 5.22-5.22 2.883 0 5.22 2.34 5.22 5.22z',
    color: '#F06A6A',
  },
  blurb: 'Let your coworker keep your Asana projects and tasks moving.',
  category: 'tasks',
  mode: 'oauth',
  backend: 'composio',
  helpUrl: 'https://app.asana.com/0/my-apps',
  capabilities: [
    'Tell you what is on your plate and what is overdue, across your projects',
    'Add a task when you ask, in the right project, with a due date and owner',
    'Tick a task off, move its date, or add a note when a plan changes',
    'Read a project and tell you where it actually stands',
  ],
  permissions: [
    'Read your workspaces, projects and tasks',
    'Create, change and complete tasks, and comment on them',
    'See your Asana name and email',
  ],
  safety: [
    {
      heading: 'The permission screen will say Composio',
      body: 'We broker this connection through a company called Composio, so the Asana screen names them rather than Delegent AI. Holding connections like this one safely is the whole of what they do, and it means your Asana sign-in is never handled by us. Nothing else changes: your coworker still asks us, and we still ask them.',
    },
    {
      heading: 'It will check with you before it changes a task',
      body: 'Reading is free. Adding, completing, reassigning or re-dating a task is not: that happens when you ask for it, and your coworker reads the task back before it says the change is in. A task could also carry hidden instructions aimed at your coworker, which is why nothing is changed without you seeing it.',
    },
    {
      heading: 'Everything you can see, it can see',
      body: 'Asana does not offer a per-project permission, so this connection reaches every workspace and project your account can open, including ones shared with you by other people. It only acts on the ones you point it at.',
    },
    {
      heading: 'What gets shared',
      body: 'The connection is held encrypted by our broker, never in your chat and never in this app. Your coworker reads a project when a job needs it. Nothing is copied elsewhere and nothing is used to train anything.',
    },
  ],
  connectedSummary: 'I can read your Asana projects, add and complete tasks when you ask, and tell you what is overdue.',
  firstPrompt: 'What is on my plate in Asana this week?',
};

const CLICKUP: ConnectableService = {
  id: 'clickup',
  name: 'ClickUp',
  brandMark: {
    viewBox: '0 0 24 24',
    path: 'M2 18.439l3.69-2.828c1.961 2.56 4.044 3.739 6.363 3.739 2.307 0 4.33-1.166 6.203-3.704L22 18.405C19.298 22.065 15.941 24 12.053 24 8.178 24 4.788 22.078 2 18.439zM12.04 6.15l-6.568 5.66-3.036-3.52L12.055 0l9.543 8.296-3.05 3.509z',
    color: '#7B68EE',
  },
  blurb: 'Let your coworker keep your ClickUp lists and tasks moving.',
  category: 'tasks',
  mode: 'oauth',
  backend: 'composio',
  helpUrl: 'https://app.clickup.com/settings/apps',
  capabilities: [
    'Tell you what is in a list and what is overdue',
    'Add a task when you ask, in the right list, with a due date and priority',
    'Change a task\'s status, move its date, or add a comment when a plan changes',
    'Read a task and its subtasks so it knows the whole picture before it acts',
  ],
  permissions: [
    'Read the Workspaces you authorise, and their spaces, folders, lists and tasks',
    'Create and change tasks, and comment on them',
    'See your ClickUp name and email',
  ],
  safety: [
    {
      heading: 'The permission screen will say Composio',
      body: 'We broker this connection through a company called Composio, so the ClickUp screen names them rather than Delegent AI. Holding connections like this one safely is the whole of what they do, and it means your ClickUp sign-in is never handled by us. Nothing else changes: your coworker still asks us, and we still ask them.',
    },
    {
      heading: 'You choose which Workspaces it can see',
      body: 'ClickUp asks you to pick the Workspaces to authorise when you connect, and your coworker can reach only those. Within a Workspace it sees what your account sees, including lists shared with you by other people, and only acts on the ones you point it at.',
    },
    {
      heading: 'It will check with you before it changes a task',
      body: 'Reading is free. Adding, closing, re-dating or reassigning a task is not: that happens when you ask for it, and your coworker reads the task back before it says the change is in. A task could also carry hidden instructions aimed at your coworker, which is why nothing is changed without you seeing it.',
    },
    {
      heading: 'What gets shared',
      body: 'The connection is held encrypted by our broker, never in your chat and never in this app. Your coworker reads a list when a job needs it. Nothing is copied elsewhere and nothing is used to train anything.',
    },
  ],
  connectedSummary: 'I can read your ClickUp lists, add and update tasks when you ask, and tell you what is overdue.',
  firstPrompt: 'What is overdue in ClickUp?',
};

const GOOGLE_TASKS: ConnectableService = {
  id: 'google_tasks',
  name: 'Google Tasks',
  brandMark: {
    viewBox: '0 0 24 24',
    path: 'M11.383.617C5.097.617 0 5.714 0 12c0 6.286 5.097 11.383 11.383 11.383 6.286 0 11.38-5.097 11.38-11.383a11.34 11.34 0 0 0-.878-4.389l-3.203 3.203c.062.387.1.782.1 1.186a7.398 7.398 0 1 1-7.4-7.398c1.499 0 2.889.448 4.054 1.214l2.857-2.857a11.325 11.325 0 0 0-6.91-2.342zm9.674.756c-.292 0-.583.112-.805.334-2.97 2.965-5.934 5.934-8.9 8.902L9.596 8.854a1.139 1.139 0 0 0-1.61 0l-1.775 1.773a1.139 1.139 0 0 0 0 1.61l4.166 4.163a1.421 1.421 0 0 0 2.012 0L23.666 5.121a1.136 1.136 0 0 0 0-1.61l-1.805-1.804a1.136 1.136 0 0 0-.804-.334z',
    color: '#2684FC',
  },
  blurb: 'Let your coworker keep your Google Tasks lists up to date.',
  category: 'tasks',
  mode: 'oauth',
  backend: 'composio',
  helpUrl: 'https://myaccount.google.com/permissions',
  capabilities: [
    'Tell you what is on your lists and what is overdue',
    'Add a task with a due date when you ask',
    'Tick a task off or move its date when a plan changes',
  ],
  permissions: ['Read, create, change and complete tasks on your Google Tasks lists'],
  safety: [
    COMPOSIO_DISCLOSURE('Google'),
    {
      heading: 'It will check with you before it changes a list',
      body: 'Reading is free. Adding, completing or re-dating a task is not: that happens when you ask for it, and your coworker reads the list back before it says the change is in. A task could also carry hidden instructions aimed at your coworker, which is why nothing is changed without you seeing it.',
    },
    COMPOSIO_SHARED('your lists'),
  ],
  connectedSummary: 'I can read your Google Tasks lists, add and complete tasks when you ask, and tell you what is overdue.',
  firstPrompt: 'What is on my task list today?',
};

const ZENDESK: ConnectableService = {
  id: 'zendesk',
  name: 'Zendesk',
  brandMark: {
    viewBox: '0 0 24 24',
    path: 'M12.914 2.904V16.29L24 2.905H12.914zM0 2.906C0 5.966 2.483 8.45 5.543 8.45s5.542-2.484 5.543-5.544H0zm11.086 4.807L0 21.096h11.086V7.713zm7.37 7.84c-3.063 0-5.542 2.48-5.542 5.543H24c0-3.06-2.48-5.543-5.543-5.543z',
    color: '#03363D',
  },
  blurb: 'Let your coworker work your Zendesk tickets with you.',
  category: 'messaging',
  mode: 'oauth',
  backend: 'composio',
  helpUrl: 'https://support.zendesk.com/hc/en-us/articles/4408845965210',
  capabilities: [
    'Tell you which tickets need you and what each one is about',
    'Draft a reply to a ticket for you to approve before it goes',
    'Raise a ticket when you ask',
    'Look up an organisation and its open tickets',
  ],
  permissions: [
    'Read your tickets, users and organisations',
    'Create tickets and post replies to them',
  ],
  safety: [
    COMPOSIO_DISCLOSURE('Zendesk'),
    {
      heading: 'You will be asked for your Zendesk address',
      body: 'Zendesk lives at your own address, like yourcompany.zendesk.com. The connection screen asks for that first part so it knows where to sign you in; it is not a password.',
    },
    {
      heading: 'It replies to nobody without you',
      body: 'Reading is free. A reply on a ticket goes to a customer, so your coworker posts one only when you ask it to, and shows you the words first unless you have already said exactly what to write. It creates or closes a ticket only when you ask it to. A ticket could also carry hidden instructions aimed at your coworker, which is why nothing leaves without you seeing it.',
    },
    COMPOSIO_SHARED('a ticket'),
  ],
  connectedSummary: 'I can read your Zendesk tickets, tell you which need you, and draft replies for you to approve.',
  firstPrompt: 'Which tickets need me today?',
};

const JIRA: ConnectableService = {
  id: 'jira',
  name: 'Jira',
  brandMark: {
    viewBox: '0 0 24 24',
    path: 'M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.005-1.005zm5.723-5.756H5.736a5.215 5.215 0 0 0 5.215 5.214h2.129v2.058a5.218 5.218 0 0 0 5.215 5.214V6.758a1.001 1.001 0 0 0-1.001-1.001zM23.013 0H11.455a5.215 5.215 0 0 0 5.215 5.215h2.129v2.057A5.215 5.215 0 0 0 24 12.483V1.005A1.001 1.001 0 0 0 23.013 0Z',
    color: '#0052CC',
  },
  blurb: 'Let your coworker keep your Jira issues moving.',
  category: 'tasks',
  mode: 'oauth',
  backend: 'composio',
  helpUrl: 'https://id.atlassian.com/manage-profile/apps',
  capabilities: [
    'Tell you what is assigned to you and what is blocked',
    'Create an issue in the right project when you ask',
    'Move an issue through its workflow, comment on it, or reassign it',
    'Search issues in plain words or in JQL',
  ],
  permissions: [
    'Read your Jira projects, issues and users',
    'Create and change issues, comment on them, and move them through workflows',
  ],
  safety: [
    COMPOSIO_DISCLOSURE('Atlassian'),
    {
      heading: 'You will be asked for your Atlassian address',
      body: 'Jira lives at your own address, like yourcompany.atlassian.net. The connection screen asks for that first part so it knows where to sign you in; it is not a password.',
    },
    {
      heading: 'It will check with you before it changes an issue',
      body: 'Reading is free. Creating, transitioning, reassigning or commenting is not: that happens when you ask for it, and your coworker reads the issue back before it says the change is in. An issue could also carry hidden instructions aimed at your coworker, which is why nothing is changed without you seeing it.',
    },
    COMPOSIO_SHARED('an issue'),
  ],
  connectedSummary: 'I can read your Jira issues, create and move them when you ask, and tell you what is blocked.',
  firstPrompt: 'What is assigned to me in Jira?',
};

const CONFLUENCE: ConnectableService = {
  id: 'confluence',
  name: 'Confluence',
  brandMark: {
    viewBox: '0 0 24 24',
    path: 'M.87 18.257c-.248.382-.53.875-.763 1.245a.764.764 0 0 0 .255 1.04l4.965 3.054a.764.764 0 0 0 1.058-.26c.199-.332.454-.763.733-1.221 1.967-3.247 3.945-2.853 7.508-1.146l4.957 2.337a.764.764 0 0 0 1.028-.382l2.364-5.346a.764.764 0 0 0-.382-1 599.851 599.851 0 0 1-4.965-2.361C10.911 10.97 5.224 11.185.87 18.257zM23.131 5.743c.249-.405.531-.875.764-1.25a.764.764 0 0 0-.256-1.034L18.675.404a.764.764 0 0 0-1.058.26c-.195.335-.451.763-.734 1.225-1.966 3.246-3.945 2.85-7.508 1.146L4.437.694a.764.764 0 0 0-1.027.382L1.046 6.422a.764.764 0 0 0 .382 1c1.039.49 3.105 1.467 4.965 2.361 6.698 3.246 12.392 3.029 16.738-4.04z',
    color: '#172B4D',
  },
  blurb: 'Let your coworker read and write your Confluence pages.',
  category: 'files',
  mode: 'oauth',
  backend: 'composio',
  helpUrl: 'https://id.atlassian.com/manage-profile/apps',
  capabilities: [
    'Find the page you half-remember and tell you what it says',
    'Write a new page from a brief, in the right space',
    'Update a page when you ask, keeping its history',
    'Answer questions from your team wiki',
  ],
  permissions: [
    'Read your Confluence spaces and pages',
    'Create and update pages',
  ],
  safety: [
    COMPOSIO_DISCLOSURE('Atlassian'),
    {
      heading: 'You will be asked for your Atlassian address',
      body: 'Confluence lives at your own address, like yourcompany.atlassian.net. The connection screen asks for that first part so it knows where to sign you in; it is not a password.',
    },
    {
      heading: 'It will check with you before it changes a page',
      body: 'Reading is free. Creating or updating a page is not: that happens when you ask for it, and your coworker reads the page back before it says the change is in. A page could also carry hidden instructions aimed at your coworker, which is why nothing is changed without you seeing it.',
    },
    COMPOSIO_SHARED('a page'),
  ],
  connectedSummary: 'I can read your Confluence pages, write new ones from a brief, and update them when you ask.',
  firstPrompt: 'What does our wiki say about onboarding?',
};

const CHECKS_FIRST = (thing: string) => ({
  heading: 'It will check with you before it changes anything',
  body: `Reading is free. Creating, changing or sending ${thing} is not: that happens when you ask for it, and your coworker reads the result back before it says the change is in. ${thing[0].toUpperCase() + thing.slice(1)} could also carry hidden instructions aimed at your coworker, which is why nothing is changed without you seeing it.`,
});

const ONEDRIVE: ConnectableService = {
  id: 'onedrive',
  name: 'OneDrive',
  brandMark: {
    viewBox: '0 0 24 24',
    path: 'M9.5 6a5.5 5.5 0 0 1 5.2 3.7A4.3 4.3 0 0 1 19 9.5a4.2 4.2 0 0 1 4.1 3.3A3.6 3.6 0 0 1 20.4 19H6.1A4.6 4.6 0 0 1 5 9.9 5.5 5.5 0 0 1 9.5 6z',
    color: '#0078D4',
  },
  blurb: 'Let your coworker find and work with the files in your OneDrive.',
  category: 'files',
  mode: 'oauth',
  backend: 'composio',
  helpUrl: 'https://account.microsoft.com/privacy/app-access',
  capabilities: [
    'Find the file you half-remember and tell you what is in it',
    'Save its work into your OneDrive where you can open it anywhere',
    'Keep what it makes organised in folders',
    'Tell you what changed recently',
  ],
  permissions: [
    'Read, create and change files in your OneDrive',
    'See your name and email on your Microsoft account',
  ],
  safety: [
    COMPOSIO_DISCLOSURE('Microsoft'),
    {
      heading: 'Every file you can see, it can see',
      body: 'Microsoft does not offer a "only its own files" permission for OneDrive the way Google does for Drive, so this connection reaches every file your account can open. It only acts on the ones you point it at, and it will not delete anything: that action is refused on purpose.',
    },
    CHECKS_FIRST('a file'),
    COMPOSIO_SHARED('a file'),
  ],
  connectedSummary: 'I can find files in your OneDrive, read them, and save my work there.',
  firstPrompt: 'What did I change in OneDrive this week?',
};

const HUBSPOT: ConnectableService = {
  id: 'hubspot',
  name: 'HubSpot',
  brandMark: {
    viewBox: '0 0 24 24',
    path: 'M18.164 7.93V5.084a2.198 2.198 0 001.267-1.978v-.067A2.2 2.2 0 0017.238.845h-.067a2.2 2.2 0 00-2.193 2.193v.067a2.196 2.196 0 001.252 1.973l.013.006v2.852a6.22 6.22 0 00-2.969 1.31l.012-.01-7.828-6.095A2.497 2.497 0 104.3 4.656l-.012.006 7.697 5.991a6.176 6.176 0 00-1.038 3.446c0 1.343.425 2.588 1.147 3.607l-.013-.02-2.342 2.343a1.968 1.968 0 00-.58-.095h-.002a2.033 2.033 0 102.033 2.033 1.978 1.978 0 00-.1-.595l.005.014 2.317-2.317a6.247 6.247 0 104.782-11.134l-.036-.005zm-.964 9.378a3.206 3.206 0 113.215-3.207v.002a3.206 3.206 0 01-3.207 3.207z',
    color: '#FF7A59',
  },
  blurb: 'Let your coworker keep your HubSpot contacts, companies and deals up to date.',
  category: 'tasks',
  mode: 'oauth',
  backend: 'composio',
  helpUrl: 'https://app.hubspot.com/',
  capabilities: [
    'Look up a contact or company and tell you where things stand',
    'Add a contact, company or deal when you ask',
    'Move a deal along its pipeline and keep the notes current',
    'Tell you which deals are stalling',
  ],
  permissions: [
    'Read and change contacts, companies and deals in your HubSpot',
  ],
  safety: [
    COMPOSIO_DISCLOSURE('HubSpot'),
    {
      heading: 'Contacts, companies and deals, nothing else',
      body: 'We asked HubSpot for those three and no more. Your coworker cannot read or send marketing email, cannot touch tickets or quotes, and cannot change your account settings with this.',
    },
    CHECKS_FIRST('a record'),
    COMPOSIO_SHARED('a record'),
  ],
  connectedSummary: 'I can read your HubSpot contacts, companies and deals, add and update them when you ask, and tell you what is stalling.',
  firstPrompt: 'Which deals have gone quiet?',
};

const SALESFORCE: ConnectableService = {
  id: 'salesforce',
  name: 'Salesforce',
  brandMark: {
    viewBox: '0 0 24 24',
    path: 'M10 5.5a4.5 4.5 0 0 1 4-2.3 4.5 4.5 0 0 1 4.2 2.9 3.8 3.8 0 0 1 4.6 2.9A4 4 0 0 1 20 17H5.5a4.3 4.3 0 0 1-1.2-8.4A4.4 4.4 0 0 1 10 5.5z',
    color: '#00A1E0',
  },
  blurb: 'Let your coworker work your Salesforce leads, contacts and opportunities.',
  category: 'tasks',
  mode: 'oauth',
  backend: 'composio',
  helpUrl: 'https://login.salesforce.com/',
  capabilities: [
    'Look up an account, contact, lead or opportunity and tell you where it stands',
    'Add a lead or a task when you ask',
    'Answer questions across your data in plain words',
    'Log a call or an email against a record',
  ],
  permissions: [
    'Full access to your Salesforce data: read everything, and create, change and delete records',
  ],
  safety: [
    COMPOSIO_DISCLOSURE('Salesforce'),
    {
      heading: 'You will be asked for your Salesforce address',
      body: 'Salesforce lives at your own address, like yourcompany.my.salesforce.com. The connection screen asks for that first part so it knows where to sign you in; it is not a password. Leave the second field as it is.',
    },
    {
      heading: 'Salesforce cannot give partial access',
      body: 'The only grant Salesforce offers an app like this is full access, and that is Salesforce\'s design, not our choice. Approving this gives your coworker the same reach over your data that you have. It will not delete anything: that action is refused on purpose. Connect it only if you want your coworker actually working your pipeline.',
    },
    CHECKS_FIRST('a record'),
    COMPOSIO_SHARED('a record'),
  ],
  connectedSummary: 'I can read your Salesforce accounts, contacts, leads and opportunities, add leads and tasks when you ask, and log activity.',
  firstPrompt: 'What is in my pipeline this month?',
};

const STRIPE: ConnectableService = {
  id: 'stripe',
  name: 'Stripe',
  brandMark: {
    viewBox: '0 0 24 24',
    path: 'M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.594-7.305h.003z',
    color: '#635BFF',
  },
  blurb: 'Let your coworker read your Stripe payments, customers and invoices.',
  category: 'money',
  mode: 'oauth',
  backend: 'composio',
  helpUrl: 'https://dashboard.stripe.com/settings/apps',
  capabilities: [
    'Tell you what came in today, this week, this month',
    'Look up a customer and what they have paid',
    'Find an invoice or a charge and tell you its status',
    'Tell you which subscriptions are active, past due or cancelled',
  ],
  permissions: ['Stripe grants read and write access to your account, because Stripe does not offer a read-only grant to apps like this. Our server only ever lets read actions through: payments, customers, invoices, subscriptions and balance. It cannot charge, refund, or change anything'],
  safety: [
    COMPOSIO_DISCLOSURE('Stripe'),
    {
      heading: 'Read-only, enforced by us',
      body: 'This is your money. We asked Stripe for a read-only grant and Stripe refused: it only offers read and write to connections like this. So the read-only rule lives on our server instead. Every Stripe action your coworker asks for is checked there first, and anything that is not a read is refused before it reaches Stripe. It cannot take a payment, issue a refund, cancel a subscription or change a customer. The risk is that the grant itself is wider than what we use, so if you would rather not, do not connect it.',
    },
    {
      heading: 'What it sees',
      body: 'Customer names, email addresses, amounts and invoice details are visible to it when a job needs them. It uses them to answer your question and for nothing else. The risk here is what it might see, not what it might do.',
    },
    COMPOSIO_SHARED('a payment'),
  ],
  connectedSummary: 'I can read your Stripe payments, customers, invoices and subscriptions, and tell you what came in.',
  firstPrompt: 'What came in this week?',
};

const YOUTUBE: ConnectableService = {
  id: 'youtube',
  name: 'YouTube',
  brandMark: {
    viewBox: '0 0 24 24',
    path: 'M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z',
    color: '#FF0000',
  },
  blurb: 'Let your coworker read your YouTube channel and research videos.',
  category: 'social',
  mode: 'oauth',
  backend: 'composio',
  helpUrl: 'https://myaccount.google.com/permissions',
  capabilities: [
    'Tell you how your channel and videos are doing',
    'Find videos on a topic and summarise them from their captions',
    'List your playlists and subscriptions',
  ],
  permissions: ['Read-only access to your YouTube account and public YouTube data. It cannot upload, edit or delete anything'],
  safety: [
    COMPOSIO_DISCLOSURE('Google'),
    {
      heading: 'Read-only, on purpose',
      body: 'This connection can only look. It cannot upload a video, change a title or thumbnail, or post a comment. The risk here is what your coworker might see, not what it might do. If you want it publishing for you, that will be a separate, clearly labelled connection.',
    },
    COMPOSIO_SHARED('a video'),
  ],
  connectedSummary: 'I can read your YouTube channel statistics, list your playlists, and research videos by their captions.',
  firstPrompt: 'How did my channel do this month?',
};

const REDDIT: ConnectableService = {
  id: 'reddit',
  name: 'Reddit',
  brandMark: {
    viewBox: '0 0 24 24',
    path: 'M12 0C5.373 0 0 5.373 0 12c0 3.314 1.343 6.314 3.515 8.485l-2.286 2.286C.775 23.225 1.097 24 1.738 24H12c6.627 0 12-5.373 12-12S18.627 0 12 0Zm4.388 3.199c1.104 0 1.999.895 1.999 1.999 0 1.105-.895 2-1.999 2-.946 0-1.739-.657-1.947-1.539v.002c-1.147.162-2.032 1.15-2.032 2.341v.007c1.776.067 3.4.567 4.686 1.363.473-.363 1.064-.58 1.707-.58 1.547 0 2.802 1.254 2.802 2.802 0 1.117-.655 2.081-1.601 2.531-.088 3.256-3.637 5.876-7.997 5.876-4.361 0-7.905-2.617-7.998-5.87-.954-.447-1.614-1.415-1.614-2.538 0-1.548 1.255-2.802 2.803-2.802.645 0 1.239.218 1.712.585 1.275-.79 2.881-1.291 4.64-1.365v-.01c0-1.663 1.263-3.034 2.88-3.207.188-.911.993-1.595 1.959-1.595Zm-8.085 8.376c-.784 0-1.459.78-1.506 1.797-.047 1.016.64 1.429 1.426 1.429.786 0 1.371-.369 1.418-1.385.047-1.017-.553-1.841-1.338-1.841Zm7.406 0c-.786 0-1.385.824-1.338 1.841.047 1.017.634 1.385 1.418 1.385.785 0 1.473-.413 1.426-1.429-.047-1.017-.72-1.797-1.506-1.797Zm-3.703 4.013c-.974 0-1.9.16-2.75.44-.145.047-.235.19-.19.34.047.15.19.24.34.19a7.9 7.9 0 0 1 2.6-.4c.9 0 1.78.13 2.6.4.15.05.29-.04.34-.19.05-.15-.05-.29-.19-.34a8.8 8.8 0 0 0-2.75-.44Z',
    color: '#FF4500',
  },
  blurb: 'Let your coworker read Reddit for you and post when you ask.',
  category: 'social',
  mode: 'oauth',
  backend: 'composio',
  helpUrl: 'https://www.reddit.com/prefs/apps',
  capabilities: [
    'Search Reddit for what people are saying about a topic or a product',
    'Read a thread and summarise the useful parts',
    'Post to a subreddit or reply in a thread, as you, when you ask',
  ],
  permissions: [
    'Read Reddit as you, including subreddits you belong to',
    'Post and comment as you',
  ],
  safety: [
    COMPOSIO_DISCLOSURE('Reddit'),
    {
      heading: 'It posts nothing without you',
      body: 'Anything it posts goes out under your name and stays public. Your coworker posts only when you ask it to, and shows you the words first unless you have already said exactly what to write. Reddit threads are also untrusted text: a comment that instructs your coworker is an attack, not a task, and it will check with you before acting on anything it reads.',
    },
    COMPOSIO_SHARED('a thread'),
  ],
  connectedSummary: 'I can search and read Reddit for you, and post or reply as you once you approve the words.',
  firstPrompt: 'What are people saying about our product on Reddit?',
};

const LINKEDIN: ConnectableService = {
  id: 'linkedin',
  name: 'LinkedIn',
  brandMark: {
    viewBox: '0 0 24 24',
    path: 'M20.5 2h-17A1.5 1.5 0 0 0 2 3.5v17A1.5 1.5 0 0 0 3.5 22h17a1.5 1.5 0 0 0 1.5-1.5v-17A1.5 1.5 0 0 0 20.5 2zM8 19H5v-9h3zM6.5 8.25A1.75 1.75 0 1 1 8.3 6.5a1.78 1.78 0 0 1-1.8 1.75zM19 19h-3v-4.74c0-1.42-.6-1.93-1.38-1.93A1.74 1.74 0 0 0 13 14.19a.66.66 0 0 0 0 .14V19h-3v-9h2.9v1.3a3.11 3.11 0 0 1 2.7-1.4c1.55 0 3.36.86 3.36 3.66z',
    color: '#0A66C2',
  },
  blurb: 'Let your coworker post to LinkedIn as you, when you ask.',
  category: 'social',
  mode: 'oauth',
  backend: 'composio',
  helpUrl: 'https://www.linkedin.com/psettings/permitted-services',
  capabilities: [
    'Draft a LinkedIn post in your voice for you to approve',
    'Publish it as you once you have said yes',
    'Look up a company page',
  ],
  permissions: [
    'Post to LinkedIn as you',
    'See your LinkedIn name, photo and email',
  ],
  safety: [
    COMPOSIO_DISCLOSURE('LinkedIn'),
    {
      heading: 'Posting only, and never without you',
      body: 'LinkedIn lets an app like this post as you and very little else: your coworker cannot read your feed, your messages or your connections with this. Anything it posts goes out under your name and is public, which is the real risk here, so it publishes only when you ask it to, and shows you the words first unless you have already said exactly what to post.',
    },
    COMPOSIO_SHARED('a post'),
  ],
  connectedSummary: 'I can draft LinkedIn posts in your voice and publish them as you once you approve.',
  firstPrompt: 'Draft a LinkedIn post about what we shipped this week.',
};

const INSTAGRAM: ConnectableService = {
  id: 'instagram',
  name: 'Instagram',
  brandMark: {
    viewBox: '0 0 24 24',
    path: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm0 8.2a3.2 3.2 0 1 1 0-6.4 3.2 3.2 0 0 1 0 6.4zM17.4 5.4a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4zM12 2c-2.7 0-3.1 0-4.1.06-1.06.05-1.8.22-2.4.47a4.9 4.9 0 0 0-1.8 1.16 4.9 4.9 0 0 0-1.16 1.8c-.25.6-.42 1.34-.47 2.4C2 8.9 2 9.3 2 12s0 3.1.06 4.1c.05 1.06.22 1.8.47 2.4a4.9 4.9 0 0 0 1.16 1.8 4.9 4.9 0 0 0 1.8 1.16c.6.25 1.34.42 2.4.47C8.9 22 9.3 22 12 22s3.1 0 4.1-.06c1.06-.05 1.8-.22 2.4-.47a4.9 4.9 0 0 0 1.8-1.16 4.9 4.9 0 0 0 1.16-1.8c.25-.6.42-1.34.47-2.4C22 15.1 22 14.7 22 12s0-3.1-.06-4.1c-.05-1.06-.22-1.8-.47-2.4a4.9 4.9 0 0 0-1.16-1.8 4.9 4.9 0 0 0-1.8-1.16c-.6-.25-1.34-.42-2.4-.47C15.1 2 14.7 2 12 2zm0 1.8c2.67 0 2.99.01 4.04.06.98.04 1.5.2 1.86.34.47.18.8.4 1.15.75.35.35.57.68.75 1.15.14.35.3.88.34 1.86.05 1.05.06 1.37.06 4.04s-.01 2.99-.06 4.04c-.04.98-.2 1.5-.34 1.86-.18.47-.4.8-.75 1.15a3.1 3.1 0 0 1-1.15.75c-.35.14-.88.3-1.86.34-1.05.05-1.37.06-4.04.06s-2.99-.01-4.04-.06c-.98-.04-1.5-.2-1.86-.34a3.1 3.1 0 0 1-1.15-.75 3.1 3.1 0 0 1-.75-1.15c-.14-.35-.3-.88-.34-1.86C3.81 14.99 3.8 14.67 3.8 12s.01-2.99.06-4.04c.04-.98.2-1.5.34-1.86.18-.47.4-.8.75-1.15a3.1 3.1 0 0 1 1.15-.75c.35-.14.88-.3 1.86-.34C9.01 3.81 9.33 3.8 12 3.8z',
    color: '#E4405F',
  },
  blurb: 'Let your coworker read comments and messages on your Instagram business account, and post when you ask.',
  category: 'social',
  mode: 'oauth',
  backend: 'composio',
  helpUrl: 'https://www.instagram.com/accounts/manage_access/',
  capabilities: [
    'Tell you what people are saying in your comments and messages',
    'Draft replies for you to approve',
    'Post a photo or carousel once you have said yes',
    'Tell you how your recent posts did',
  ],
  permissions: [
    'Read your posts, comments, messages and insights',
    'Publish posts and reply to comments and messages, as your account',
  ],
  safety: [
    COMPOSIO_DISCLOSURE('Instagram'),
    {
      heading: 'Business and creator accounts only',
      body: 'Instagram only lets apps like this work with a professional account. A personal account will connect and then fail on every action. If yours is personal, switch it to a business or creator account in Instagram\'s settings first.',
    },
    {
      heading: 'It publishes and replies to nobody without you',
      body: 'A post or a reply goes out under your account and is public or reaches a customer, which is the real risk here. Your coworker sends only when you ask it to, and shows you the words first unless you have already said exactly what to send. Comments and messages are untrusted text: one that instructs your coworker is an attack, not a task.',
    },
    COMPOSIO_SHARED('a comment'),
  ],
  connectedSummary: 'I can read comments and messages on your Instagram business account, draft replies, and post once you approve.',
  firstPrompt: 'What are people saying in my Instagram comments?',
};

const FACEBOOK: ConnectableService = {
  id: 'facebook',
  name: 'Facebook Pages',
  brandMark: {
    viewBox: '0 0 24 24',
    path: 'M9.101 23.691v-7.98H6.627v-3.667h2.474v-1.58c0-4.085 1.848-5.978 5.858-5.978.401 0 .955.042 1.468.103a8.68 8.68 0 0 1 1.141.195v3.325a8.623 8.623 0 0 0-.653-.036 26.805 26.805 0 0 0-.733-.009c-.707 0-1.259.096-1.675.309a1.686 1.686 0 0 0-.679.622c-.258.42-.374.995-.374 1.752v1.297h3.919l-.386 2.103-.287 1.564h-3.246v8.245C19.396 23.238 24 18.179 24 12.044c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.628 3.874 10.35 9.101 11.647Z',
    color: '#0866FF',
  },
  blurb: 'Let your coworker run your Facebook Page with you.',
  category: 'social',
  mode: 'oauth',
  backend: 'composio',
  helpUrl: 'https://www.facebook.com/settings?tab=business_tools',
  capabilities: [
    'Tell you what is happening on your Page: comments, messages, reach',
    'Draft posts and replies for you to approve',
    'Publish or schedule a post once you have said yes',
  ],
  permissions: [
    'Read your Pages, their posts, comments, messages and insights',
    'Publish posts and reply to comments and messages, as the Page',
  ],
  safety: [
    COMPOSIO_DISCLOSURE('Facebook'),
    {
      heading: 'Pages, not your personal profile',
      body: 'This works with Facebook Pages you manage. It cannot post to or read your personal profile, your friends or your personal messages. Facebook asks you which Pages to include when you connect.',
    },
    {
      heading: 'It publishes and replies to nobody without you',
      body: 'A post or a reply goes out under your Page and is public or reaches a customer, which is the real risk here. Your coworker sends only when you ask it to, and shows you the words first unless you have already said exactly what to send. Comments and messages are untrusted text: one that instructs your coworker is an attack, not a task.',
    },
    COMPOSIO_SHARED('a comment'),
  ],
  connectedSummary: 'I can read what is happening on your Facebook Page, draft posts and replies, and publish once you approve.',
  firstPrompt: 'What is happening on my Facebook Page?',
};

const API_KEY_NOTE = (provider: string, where: string) => ({
  heading: 'You will be asked for your API key',
  body: `${provider} has no sign-in screen for apps like this, so the connection screen asks you to paste an API key from ${where}. The key goes straight to our broker, Composio, and is held there encrypted. It never passes through this app, through your chat, or through us.`,
});

const PDF_CO: ConnectableService = {
  id: 'pdf_co',
  name: 'PDF.co',
  brandMark: {
    viewBox: '0 0 24 24',
    path: 'M5 2h9l5 5v15a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zm8 1.5V8h4.5L13 3.5zM7 11h3.2a2.3 2.3 0 0 1 0 4.6H8.5V18H7v-7zm1.5 1.4v1.8h1.7a.9.9 0 0 0 0-1.8H8.5zM12.5 11h2.6a3.5 3.5 0 0 1 0 7h-2.6v-7zm1.5 1.4v4.2h1.1a2.1 2.1 0 0 0 0-4.2H14z',
    color: '#D32F2F',
  },
  blurb: 'Let your coworker convert, split, merge and read PDFs with PDF.co.',
  category: 'files',
  mode: 'oauth',
  backend: 'composio',
  helpUrl: 'https://app.pdf.co/',
  capabilities: [
    'Turn a PDF into text, a spreadsheet or images',
    'Merge, split or rotate PDFs and delete pages',
    'Turn a web page into a PDF',
    'Read the fields in a PDF form',
  ],
  permissions: ['Use your PDF.co account to process the files your coworker sends it, which spends your PDF.co credits'],
  safety: [
    COMPOSIO_DISCLOSURE('PDF.co'),
    API_KEY_NOTE('PDF.co', 'your PDF.co dashboard'),
    {
      heading: 'It spends your credits, so it checks with you',
      body: 'Every conversion costs PDF.co credits from your account, and the files it processes are uploaded to PDF.co to do the work. Your coworker tells you what it is about to send and checks with you before a large or sensitive job. The risk here is cost and where a file travels, not what it might do to your data.',
    },
    COMPOSIO_SHARED('a file'),
  ],
  connectedSummary: 'I can convert, split, merge and read PDFs through your PDF.co account.',
  firstPrompt: 'Turn this PDF into a spreadsheet.',
};

const FRESHDESK: ConnectableService = {
  id: 'freshdesk',
  name: 'Freshdesk',
  brandMark: {
    viewBox: '0 0 24 24',
    path: 'M12 2a10 10 0 0 0-10 10v8a2 2 0 0 0 2 2h8a10 10 0 0 0 0-20zm-4.5 8.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm4.5 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm4.5 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z',
    color: '#25C16F',
  },
  blurb: 'Let your coworker work your Freshdesk tickets with you.',
  category: 'messaging',
  mode: 'oauth',
  backend: 'composio',
  helpUrl: 'https://support.freshdesk.com/support/solutions/articles/215517',
  capabilities: [
    'Tell you which tickets need you and what each is about',
    'Draft a reply for you to approve before it goes',
    'Raise or update a ticket when you ask',
  ],
  permissions: ['Read, create, update and reply to tickets in your Freshdesk, as you'],
  safety: [
    COMPOSIO_DISCLOSURE('Freshdesk'),
    API_KEY_NOTE('Freshdesk', 'your Freshdesk profile settings, along with the first part of your Freshdesk address'),
    {
      heading: 'It replies to nobody without you',
      body: 'A reply on a ticket goes to a customer. Your coworker posts only when you ask it to, and shows you the words first unless you have already said exactly what to write; it creates or closes a ticket only when you ask. A ticket could also carry hidden instructions aimed at your coworker, which is why nothing leaves without you seeing it.',
    },
    COMPOSIO_SHARED('a ticket'),
  ],
  connectedSummary: 'I can read your Freshdesk tickets, tell you which need you, and draft replies for you to approve.',
  firstPrompt: 'Which Freshdesk tickets need me today?',
};

const FIRECRAWL: ConnectableService = {
  id: 'firecrawl',
  name: 'Firecrawl',
  brandMark: {
    viewBox: '0 0 24 24',
    path: 'M12 2c1 3 4 4 4 8a4 4 0 0 1-8 0c0-1 .3-2 .8-2.8C9 8.5 9.5 10 10.5 10c0-3 .5-6 1.5-8zM7 14a5 5 0 0 0 10 0c0-1.5-.6-2.8-1.5-3.8A6 6 0 0 1 12 16a6 6 0 0 1-3.5-5.8C7.6 11.2 7 12.5 7 14zm-2 6h14v2H5z',
    color: '#FF6B35',
  },
  blurb: 'Let your coworker read and search the web properly with Firecrawl.',
  category: 'search',
  mode: 'oauth',
  backend: 'composio',
  helpUrl: 'https://www.firecrawl.dev/app',
  capabilities: [
    'Read a web page cleanly, without the clutter, and tell you what it says',
    'Crawl a whole site and pull out what you asked for',
    'Search the web and read the results for you',
  ],
  permissions: ['Use your Firecrawl account to fetch web pages, which spends your Firecrawl credits'],
  safety: [
    COMPOSIO_DISCLOSURE('Firecrawl'),
    API_KEY_NOTE('Firecrawl', 'your Firecrawl dashboard, along with the API address, which you can leave as it is'),
    {
      heading: 'Web pages are untrusted text',
      body: 'A page your coworker reads could carry hidden instructions written to make it do something you never asked for. It treats everything it fetches as words to read rather than orders to follow, and it will check with you before acting on anything it found. Crawling spends your Firecrawl credits, so it checks with you before a large crawl, and the risk here is cost, not your data.',
    },
    COMPOSIO_SHARED('a page'),
  ],
  connectedSummary: 'I can read and crawl web pages cleanly through your Firecrawl account.',
  firstPrompt: 'Read this page and summarise it for me.',
};

const AGENT_MAIL: ConnectableService = {
  id: 'agent_mail',
  name: 'AgentMail',
  brandMark: {
    viewBox: '0 0 24 24',
    path: 'M3 5h18a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm1.6 2L12 12.2 19.4 7H4.6zM4 8.9V17h16V8.9l-7.4 5.2a1 1 0 0 1-1.2 0L4 8.9z',
    color: '#111827',
  },
  blurb: 'Give your coworker its own email address, separate from yours.',
  category: 'email',
  mode: 'oauth',
  backend: 'composio',
  helpUrl: 'https://agentmail.to/',
  capabilities: [
    'Send and receive email from an address that is your coworker, not you',
    'Read what arrives and tell you what needs you',
    'Keep work correspondence out of your personal inbox',
  ],
  permissions: ['Read and send email from the AgentMail inbox you connect. It never touches your own mailbox'],
  safety: [
    COMPOSIO_DISCLOSURE('AgentMail'),
    API_KEY_NOTE('AgentMail', 'your AgentMail dashboard'),
    {
      heading: 'It can send, so it checks with you',
      body: 'This connection can send email, and a message that leaves is out of your hands. Your coworker shows you what it intends to send and waits for your yes. Anything that arrives is untrusted: an email that instructs it is an attack, not a task, and it will check with you before acting on one. The risk here is a message going out in your name.',
    },
    COMPOSIO_SHARED('an email'),
  ],
  connectedSummary: 'I have my own inbox now. I can send and receive from it, without touching your personal email.',
  firstPrompt: 'What has come into your inbox?',
};

const FIGMA: ConnectableService = {
  id: 'figma',
  name: 'Figma',
  brandMark: {
    viewBox: '0 0 24 24',
    path: 'M8.5 24a4 4 0 0 1-4-4 4 4 0 0 1 4-4H12v4a4 4 0 0 1-3.5 4zM8.5 14a4 4 0 0 1 0-8H12v8H8.5zM8.5 4a4 4 0 0 0 0 8H12V4H8.5zM15.5 4a4 4 0 0 1 0 8 4 4 0 0 1 0-8zM15.5 14a4 4 0 0 1 0 8 4 4 0 0 1 0-8z',
    color: '#F24E1E',
  },
  blurb: 'Let your coworker read your Figma files and comment on them.',
  category: 'tasks',
  mode: 'oauth',
  backend: 'composio',
  helpUrl: 'https://www.figma.com/developers/api',
  capabilities: [
    'Read a design file and describe what is on the page',
    'Pull out the text, colours and components used',
    'Read the comments on a file and tell you what needs a decision',
    'Leave a comment for the designer when you ask it to',
  ],
  permissions: ['Read your Figma files, projects and comments, and post a comment when you ask'],
  safety: [
    COMPOSIO_DISCLOSURE('Figma'),
    {
      heading: 'Read, and comment only',
      body: 'The grant covers reading files, projects and version history, and writing comments. It cannot edit a design, move a layer or delete anything. A comment left on a file is visible to everyone on it, so your coworker checks with you before posting one. The risk here is what it can see across your team library, not what it can break.',
    },
    COMPOSIO_SHARED('a design file'),
  ],
  connectedSummary: 'I can read your Figma files and comments, and leave a comment when you ask.',
  firstPrompt: 'What is in this Figma file?',
};

const SHOPIFY: ConnectableService = {
  id: 'shopify',
  name: 'Shopify',
  brandMark: {
    viewBox: '0 0 24 24',
    path: 'M15.3 3.5c-.1-.1-.3-.1-.4-.1l-1 .2s-.7-.7-.8-.8c-.1-.1-.2-.1-.4-.1l-.6 15.9 5.6 1.2S15.4 3.7 15.3 3.5zM12 3.6c-.3.1-.7.2-1.1.4-.1-.4-.3-.9-.6-1.3-.4-.5-.9-.7-1.4-.7-1.5 0-2.9 1.6-3.6 4-1 .3-1.7.5-1.8.6-.5.2-.6.2-.6.7L1.8 20.4 13 22.5V3.5c-.4 0-.7 0-1 .1zm-1.9.6l-2.4.7c.5-1.8 1.4-2.8 2.1-3 .2.4.3.9.3 1.6v.7z',
    color: '#95BF47',
  },
  blurb: 'Let your coworker read your Shopify orders, products and customers.',
  category: 'money',
  mode: 'oauth',
  backend: 'composio',
  helpUrl: 'https://help.shopify.com/en/manual/apps/app-types/custom-apps',
  capabilities: [
    'Tell you what sold today, this week, this month',
    'Look up an order and where it has got to',
    'Find a product and check its stock',
    'Look up a customer and what they have bought',
  ],
  permissions: ['Read and change products, orders, customers, inventory and fulfilments in the store you connect'],
  safety: [
    COMPOSIO_DISCLOSURE('Shopify'),
    API_KEY_NOTE('Shopify', 'a custom app in your own store admin, along with your store address'),
    {
      heading: 'This is your shop, so it checks first',
      body: 'The token Shopify issues covers changing orders, products and stock as well as reading them. Your coworker treats this as a read-only connection unless you say otherwise, and it will always show you what it is about to change and wait for your yes. Customer names and addresses are visible to it when a job needs them, and are used for nothing else. An order note or a customer message could carry hidden instructions aimed at your coworker, so it will check with you before acting on anything it reads. The risk here is a change to a live shop, so nothing happens without your yes.',
    },
    COMPOSIO_SHARED('an order'),
  ],
  connectedSummary: 'I can read your Shopify orders, products, stock and customers, and tell you what sold.',
  firstPrompt: 'What sold this week?',
};

const WEBFLOW: ConnectableService = {
  id: 'webflow',
  name: 'Webflow',
  brandMark: {
    viewBox: '0 0 24 24',
    path: 'M24 4.5l-7.2 14.4h-6.8l3-5.9h-.1c-2.5 3.2-6.2 5.3-11.4 5.9L4.6 9.6h5l-1.6 6.6h.1c2.3-3.3 5.1-5.5 8.6-6.6h4.1l-1.5 6.6h.1c1.5-2.3 2.6-4.4 3.4-6.6l1.2-5.1H24z',
    color: '#146EF5',
  },
  blurb: 'Let your coworker read and update your Webflow site content.',
  category: 'web',
  mode: 'oauth',
  backend: 'composio',
  helpUrl: 'https://developers.webflow.com/data/reference/token/authorized-by',
  capabilities: [
    'Read the pages and content on your site',
    'Find and update a blog post or a collection item',
    'Draft new content into your CMS for you to review',
    'Tell you what changed and when it was last published',
  ],
  permissions: ['Read and change the pages, CMS content, assets and forms on the Webflow sites your token covers'],
  safety: [
    COMPOSIO_DISCLOSURE('Webflow'),
    API_KEY_NOTE('Webflow', 'the API access panel in your Webflow site settings'),
    {
      heading: 'Your public website, so nothing publishes itself',
      body: 'The token can change live site content, which is why your coworker drafts and shows you the change before anything is saved, and never publishes a site without you asking. A page or a form entry could carry hidden instructions aimed at it, so it treats everything it reads as words rather than orders.',
    },
    COMPOSIO_SHARED('a page'),
  ],
  connectedSummary: 'I can read your Webflow site content and draft updates for you to approve.',
  firstPrompt: 'What is on my website right now?',
};

export const CONNECTABLE_SERVICES: readonly ConnectableService[] = [
  DROPBOX,
  GOOGLE_DRIVE,
  GOOGLE_CALENDAR,
  GMAIL,
  MICROSOFT_OUTLOOK,
  SLACK,
  MICROSOFT_TEAMS,
  GITHUB,
  FREEAGENT,
  QUICKBOOKS,
  GOOGLE_SHEETS,
  GOOGLE_DOCS,
  NOTION,
  TRELLO,
  ASANA,
  CLICKUP,
  GOOGLE_TASKS,
  ZENDESK,
  JIRA,
  CONFLUENCE,
  ONEDRIVE,
  HUBSPOT,
  SALESFORCE,
  STRIPE,
  YOUTUBE,
  REDDIT,
  LINKEDIN,
  INSTAGRAM,
  FACEBOOK,
  PDF_CO,
  FRESHDESK,
  FIRECRAWL,
  AGENT_MAIL,
  FIGMA,
  SHOPIFY,
  WEBFLOW,
];

/**
 * An OAuth service is only real once the broker holds credentials for it, and
 * the broker is the only thing that knows. `available` is the id list it
 * reports; `null` means we have not been able to ask yet, in which case the
 * catalogue is shown as written rather than emptied out.
 *
 * This is what lets a provider go live by adding a secret instead of shipping
 * an app update, and it is what stops a listed provider handing the user a
 * failure the moment they tap it.
 */
export function isServiceOffered(
  service: ConnectableService,
  available: readonly string[] | null,
): boolean {
  if (service.mode !== 'oauth' || available === null) return true;
  return available.includes(service.id);
}

export function findConnectableService(id: string): ConnectableService | null {
  const wanted = (id || '').trim().toLowerCase();
  return CONNECTABLE_SERVICES.find((service) => service.id === wanted) ?? null;
}

export interface ConnectionCategoryGroup {
  readonly category: ConnectionCategory;
  readonly label: string;
  readonly services: readonly ConnectableService[];
}

/**
 * The catalogue grouped for display. Empty categories are dropped so the screen
 * never shows a heading with nothing under it.
 */
export function connectionCategoryGroups(): readonly ConnectionCategoryGroup[] {
  const groups: ConnectionCategoryGroup[] = [];
  for (const category of CONNECTION_CATEGORY_ORDER) {
    const services = CONNECTABLE_SERVICES.filter((service) => service.category === category);
    if (services.length > 0) {
      groups.push({ category, label: CONNECTION_CATEGORY_LABELS[category], services });
    }
  }
  return groups;
}

/**
 * Live state of one connection, as the Worker reports it. Deliberately carries
 * no token material of any kind: there is nothing in this shape that would be
 * dangerous to render, log, or hand to the model.
 */
export type ConnectionStatus = 'connected' | 'needs_reauth' | 'disconnected';

export interface ConnectionState {
  readonly provider: string;
  readonly status: ConnectionStatus;
  /** Which account is linked, e.g. an email address. Null until read back. */
  readonly accountLabel: string | null;
  readonly connectedAt: string | null;
}

/**
 * Always returns a state. A provider the server did not mention is
 * `disconnected`, not unknown: an absent row and an explicit "no" mean the
 * same thing to the user, and returning null here would put a null check on
 * every render path that only ever resolves to the same answer.
 */
export function findConnectionState(
  states: readonly ConnectionState[],
  provider: string,
): ConnectionState {
  return states.find((state) => state.provider === provider)
    ?? { provider, status: 'disconnected', accountLabel: null, connectedAt: null };
}

/**
 * What the coworker says in chat once a connection lands.
 *
 * It goes through the normal chat surface rather than a banner because the
 * point of the journey is that the user ends up talking to the thing they just
 * connected. The closing sentence restates the destructive-action gate, since
 * that is the promise the safety sheet made a minute earlier and this is the
 * first moment it becomes real.
 */
export function connectedAnnouncement(
  service: ConnectableService,
  accountLabel: string | null,
): string {
  const who = accountLabel ? ` I am signed in as ${accountLabel}.` : '';
  const what = service.connectedSummary
    ? ` ${service.connectedSummary}`
    : ' Ask me to do something with it and I will get started.';
  const opener = service.firstPrompt ? ` Try me: "${service.firstPrompt}"` : '';
  return (
    `I am connected to ${service.name} now.${who}${what}${opener} I will always check ` +
    'with you first before anything that cannot be undone.'
  );
}

/**
 * The label on the button under that announcement. It has to name the move the
 * button actually makes, because "Ask it to find something" sat under a button
 * that would have asked about Dropbox no matter what had just been connected.
 */
export function firstPromptLabel(service: ConnectableService): string {
  return `Ask about ${service.name}`;
}

/**
 * The standing line under the Connections list, on both surfaces.
 *
 * Every grant is brokered: it stays on our servers, encrypted, and the
 * workspace is handed a short-lived token per command rather than the grant
 * itself. The old wording ("goes straight to your own private workspace")
 * described the typed-credential vault and stopped being true the moment the
 * first OAuth service landed, so it says the promise that holds instead.
 */
export const CONNECTIONS_CUSTODY_NOTE =
  'Everything you connect is encrypted, kept out of this app and never written into your chat. You can disconnect anything here at any time.';

/**
 * The sign-off under the list, on both surfaces.
 *
 * A short list reads as a finished list, so a reader who does not see their
 * tool assumes we decided against it. This sentence used to sit in the
 * intro paragraph at the top of the phone screen, where it was answering a
 * question nobody had yet; the foot of the list is where it gets asked. It
 * lives here so it cannot end up on one surface only, which is exactly what
 * happened while it was hard-coded into the phone's header line.
 */
export const CONNECTIONS_MORE_COMING_NOTE =
  'This is just the start. More things to connect are on the way.';

export interface ConnectionReturnNotice {
  readonly tone: 'info' | 'danger';
  readonly message: string;
}

/**
 * What we say when the browser comes back from the provider without a
 * connection. Backing out is a choice, not a fault, so a cancelled hand-off is
 * acknowledged in the calm tone rather than shown as a failure. The rest name
 * what to do next, because "something went wrong" leaves the reader with no
 * move to make.
 */
export function connectionReturnNotice(
  service: ConnectableService | null,
  code: string,
): ConnectionReturnNotice {
  const name = service?.name ?? 'that account';
  if (code === 'complete_unconfirmed') {
    return { tone: 'info', message: `We could not confirm whether ${name} finished connecting. Check its current status below before starting again.` };
  }
  if (code === 'declined') {
    return { tone: 'info', message: `No problem, nothing was connected. You can set ${name} up whenever you like.` };
  }
  if (code === 'invalid_state') {
    return { tone: 'danger', message: `That connection link had expired. Start ${name} again and it will only take a moment.` };
  }
  // Refused on purpose, and the only message here that is about safety rather
  // than about something going wrong. A hand-off belongs to the account that
  // started it; one finished by a different account is somebody being walked
  // through a link they did not begin, so nothing is connected and the reader is
  // told where the sound version of it starts. Written for the ordinary cause
  // too, which is having two accounts and being signed into the other one.
  if (code === 'wrong_account') {
    return {
      tone: 'danger',
      message: `That ${name} link was started from a different account, so nothing was connected. Start ${name} again from this account and you are done.`,
    };
  }
  return { tone: 'danger', message: `We could not finish connecting ${name}. Try again in a moment.` };
}

/**
 * The one line under the safety statements, immediately above the button that
 * leaves our app. Shared so the phone and the browser cannot drift on the most
 * consequential sentence in the flow.
 */
export function handoffNotice(service: ConnectableService): string {
  return `The next screen is ${service.name}'s own. You sign in to ${service.name}, not to us, and ${service.name} asks you to approve the permissions above.`;
}
