// 2026-07-23 (Alex): the "Commands" area in the ☰ menu — modelled on the Skills
// cards (emoji tile, tap-to-expand, warm explanation, one action). Data-driven.
// `mode` decides what a tap does:
//   'send'    — run the command immediately; its result appears in the chat.
//   'compose' — drop the user into the chat with the command pre-typed so they
//               finish it (e.g. "/goal " then their goal) and send it themselves.
// 'fresh-chat' is special-cased by the run handler (own reset + divider path).
//
// A command may carry `options` instead of a single action. Each option sends a
// plain natural-language instruction the durable coworker obeys (send mode). We
// use this for style/personality: the gateway's real `/personality` command only
// works when named personalities are seeded in the runner's config.yaml (they
// aren't), so bare `/personality` just returns a "none configured" message.
// Sending a plain style instruction the coworker acts on is the friendlier path.
// Same reasoning for a few other cards (goal, memory): the raw gateway command
// output is developer-facing, so we ask the coworker in plain language instead.
//
// Lives here rather than in the phone app so the web menu renders the same
// cards. Both surfaces dispatch them the same way, as a 'menu_command' message
// into the shared chat document.

export type ChatCommandOption = {
  key: string;
  label: string;
  instruction: string;
};

export type ChatCommand = {
  key: string;
  emoji: string;
  name: string;
  short: string;
  why: string;
  actionLabel: string;
  command: string;
  mode: 'send' | 'compose';
  options?: ChatCommandOption[];
};

export const DELEGENT_CHAT_COMMANDS: ChatCommand[] = [
  {
    key: 'fresh-chat',
    emoji: '✨',
    name: 'Start fresh chat',
    short: 'Begin a brand new conversation. Best when you’re moving on to something different.',
    why: 'This starts a clean, empty conversation. Your coworker stops carrying this chat’s back-and-forth, so replies are fast again and it’s a natural break when you switch to a new topic. Don’t worry, anything important is kept in long-term memory, so you won’t lose it. The difference from Tidy up this chat: that one keeps this same conversation going, this one starts a new one.',
    actionLabel: 'Start fresh chat',
    command: '/new',
    mode: 'send',
  },
  {
    key: 'compress',
    emoji: '🧹',
    name: 'Tidy up this chat',
    short: 'Keep this same conversation, just trimmed so replies stay fast.',
    why: 'This keeps your current conversation going, but neatly sums up everything so far so your coworker has less to re-read each time. Replies get quicker and lighter on your allowance, and you don’t lose the thread. The difference from Start fresh chat: that one begins a new conversation, this one keeps this one and simply tidies it.',
    actionLabel: 'Tidy up this chat',
    command: '/compress',
    mode: 'send',
  },
  {
    key: 'personality',
    emoji: '🎭',
    name: 'Change your coworker’s style',
    short: 'Make it warmer, chattier, or shorter and to the point.',
    why: 'Your coworker can take on different styles. Pick one below and it will carry that style through the rest of your conversation. You can change your mind any time, just pick another.',
    actionLabel: 'See the styles',
    command: '/personality',
    mode: 'send',
    options: [
      {
        key: 'warmer',
        label: 'Warmer and friendlier',
        instruction: 'For the rest of our conversation, please make your replies warmer and friendlier, with a bit more of a personal, encouraging tone.',
      },
      {
        key: 'briefer',
        label: 'Briefer and to the point',
        instruction: 'For the rest of our conversation, please keep your replies brief and to the point. Lead with the answer and leave out anything that is not essential.',
      },
      {
        key: 'chattier',
        label: 'Chattier and more detailed',
        instruction: 'For the rest of our conversation, please be a bit chattier and give me more detail and context in your replies.',
      },
      {
        key: 'professional',
        label: 'Professional and neutral',
        instruction: 'For the rest of our conversation, please keep a professional, neutral tone, clear and businesslike without extra chit-chat.',
      },
    ],
  },
  {
    key: 'goal',
    emoji: '🎯',
    name: 'Set a standing goal',
    short: 'Give your coworker something to keep working toward.',
    why: 'A goal is a bigger aim your coworker keeps in mind across the whole conversation, for example “help me launch my shop by Friday”. Tap below and your coworker will ask you what goal you’d like, then keep it in mind and let it steer what it does next, turn after turn.',
    actionLabel: 'Set a goal',
    command: 'I’d like to set a standing goal for you to keep working toward across our whole conversation. Please ask me what that goal should be, then hold onto it and let it steer what you do next.',
    mode: 'send',
  },
  {
    key: 'memory',
    emoji: '🧠',
    name: 'What your coworker remembers',
    short: 'See what it saves about you and change or remove anything.',
    why: 'Your coworker jots down useful things about you and your work between chats, so you don’t have to repeat yourself. Tap below and it will show you what it currently remembers, and you can ask it to update or forget anything. Nothing here is shared with anyone else.',
    actionLabel: 'Show what you remember',
    command: 'Please tell me what you currently remember about me and my work from your long-term memory. Show me the main things you’ve saved, and let me know how I can ask you to update or forget any of it.',
    mode: 'send',
  },
];
