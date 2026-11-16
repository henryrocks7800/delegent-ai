// Help articles for search (growth plan row 7, 2026-09-23): pages that answer
// what people actually type, prerendered to static HTML at /help/<slug> by
// scripts/prerender-articles.mjs so search engines read the real title and text.
//
// Rules, checked by test/help-articles.test.mjs: British English, no em or en
// dashes, every product claim is something the app does today (nothing files
// mail into folders, nothing books, pays or sends without the person's yes),
// and every page carries Jess's byline (Alex, 2026-09-23: "anything you do has
// to be under Jess's name").

export const ARTICLE_AUTHOR = { name: 'The Delegent AI team', role: 'Delegent AI' };

export const ARTICLES = [
  {
    slug: 'ai-assistant-for-your-inbox',
    title: 'How to get on top of your email with an AI assistant',
    description:
      'A practical way to clear an overflowing inbox: what to ask an AI assistant, what to check yourself, and how Delegent AI helps with Gmail and Outlook.',
    published: '2026-09-23',
    intro:
      'An overflowing inbox is rarely about the number of emails. It is about not knowing which of them need you. An AI assistant is good at exactly that part: reading everything, telling you what matters, and drafting the replies. Here is a simple routine that works, with or without us.',
    sections: [
      {
        title: 'Start with what needs you',
        body: [
          'Before tidying anything, find the handful of messages that genuinely need a decision or a reply. Everything else can wait, or can go.',
          'With an AI assistant connected to your email, one question does this: "What needs a reply from me this week?" You get a short list, one line per message, instead of scrolling through hundreds.',
        ],
      },
      {
        title: 'Let it draft, you decide',
        body: [
          'Most replies are short and predictable: yes, no, Thursday works, here is the document. Ask for a draft in your own words, such as "Reply to Sarah and say Thursday at ten works", and edit it if you need to.',
          'Keep one rule: nothing goes out until you have read it. Delegent AI works this way by design. Anything that sends, deletes or spends waits for your yes and shows you exactly what will happen first.',
        ],
      },
      {
        title: 'Cut the noise at the source',
        body: [
          'Ask which senders email you most. Newsletters and shop offers you never open are usually most of the pile, and unsubscribing from the worst few does more than any folder system.',
          'Then set yourself two short email slots a day. Checking constantly is what makes an inbox feel endless.',
        ],
      },
      {
        title: 'Keep your account safe',
        body: [
          'Only connect your email to a service that signs you in on Google\'s or Microsoft\'s own page, so it never sees your password, and that lets you disconnect at any time.',
          'With Delegent AI you connect Gmail or Outlook that way, you can disconnect whenever you like, and your conversations are never used to train AI models. AI can make mistakes, so check anything important before you rely on it.',
        ],
      },
      {
        title: 'Try it on your own inbox',
        body: [
          'Delegent AI is an AI assistant for everyday admin. Connect your email in the app and ask "What needs a reply from me this week?" Your first month is free.',
        ],
      },
    ],
  },
  {
    slug: 'ai-assistant-for-sole-traders',
    title: 'An AI assistant for sole traders and the self-employed',
    description:
      'What an AI assistant can take off a sole trader\'s plate today: emails, quotes and invoices as PDFs, letters and research, with you approving anything that goes out.',
    published: '2026-09-23',
    intro:
      'When you work for yourself, the admin nobody pays you for eats the evenings: replying to enquiries, sending quotes, chasing invoices, booking travel for a job. An AI assistant will not run your business, but it can take a surprising amount of that pile off you. Here is what works today, and what to keep for yourself.',
    sections: [
      {
        title: 'What you can hand over today',
        body: [
          'Quotes and invoices: describe the job and the price, and get a tidy PDF back to check and send.',
          'Customer emails: ask for a reply to an enquiry or a polite reminder about a late payment, drafted in your tone for you to approve.',
          'Letters and forms: a complaint to a supplier, a note to your landlord, a cover letter for a tender.',
          'Research and travel: compare suppliers and prices, or find a hotel near a job for Tuesday night, with links to book yourself.',
          'Receipts and bills: photograph one and ask what it says.',
        ],
      },
      {
        title: 'What to keep for yourself',
        body: [
          'An AI assistant is not an accountant or a solicitor. It does not file your tax return or give financial or legal advice, and it can make mistakes, so check figures and anything important.',
          'Delegent AI never sends, pays for or books anything on its own. Anything that sends, posts, deletes or spends waits for your yes.',
        ],
      },
      {
        title: 'Use the tools you already have',
        body: [
          'Delegent AI connects to 35 popular apps for email, calendars, cloud storage, documents and spreadsheets, accounting and online shops. Most connect by signing in on the app\'s own website, so we never see your password.',
        ],
      },
      {
        title: 'What it costs',
        body: [
          'Your first month is free, then £3.99 a month for one simple plan with a generous monthly allowance. Cancel any time.',
        ],
      },
    ],
  },
  {
    slug: 'letter-to-landlord-about-repairs',
    title: 'Letter to your landlord about repairs: a free template',
    description:
      'A free, plain-English template for asking your landlord in England to fix a repair, what to include, and what to do if nothing happens.',
    published: '2026-09-23',
    intro:
      'If something in your home needs fixing, putting the request in writing is the most useful thing you can do. It gives your landlord a clear record of what is wrong and when you told them, and it is what you will need if you have to take it further. This is general information for tenants in England, not legal advice.',
    sections: [
      {
        title: 'What your landlord usually has to fix',
        body: [
          'In most tenancies in England your landlord is responsible for the structure and outside of the home, and for keeping the water, gas, electricity, sanitation, heating and hot water in working order. You are usually responsible for small jobs and for damage you cause.',
          'Your tenancy agreement may say more, but it cannot take those basic responsibilities away.',
        ],
      },
      {
        title: 'What to put in your letter',
        body: [
          'Your name, the address of the property and the date.',
          'What is wrong, where it is, when it started and how it affects you. Be specific: "the boiler has not produced hot water since 12 September" beats "the heating is broken".',
          'What you are asking for, and a reasonable date to hear back, such as 14 days for something that is not urgent.',
          'When you can give access for a visit, and photos if you have them. Keep a copy of everything you send.',
        ],
      },
      {
        title: 'The template',
        body: [
          'Dear [landlord or agent name],',
          'Re: repair needed at [your address]',
          'I am writing to report a problem at the property. Since [date], [describe the problem, for example the boiler has not produced hot water]. This means [how it affects you, for example we have no hot water for washing].',
          'Please arrange for this to be repaired. I would be grateful if you could let me know by [date, for example 14 days from today] when the work will be done.',
          'I can give access on [days and times]. I have attached photos of the problem.',
          'Thank you. I look forward to hearing from you.',
          'Yours sincerely,',
          '[Your name]',
        ],
      },
      {
        title: 'If nothing happens',
        body: [
          'Send a short reminder that refers to your first letter and its date.',
          'If your landlord still does not act and you rent privately, contact your local council\'s private housing or environmental health team, who can inspect and require repairs. Council and housing association tenants can use their landlord\'s complaints process and then the Housing Ombudsman.',
          'Do not stop paying rent without advice, as it can put your tenancy at risk. Shelter and Citizens Advice have free guidance. If you smell gas, call the National Gas Emergency Service on 0800 111 999 straight away.',
        ],
      },
      {
        title: 'Let Delegent AI write it for you',
        body: [
          'Tell Delegent AI what is wrong in your own words and ask: "Write to my landlord about the boiler, polite but firm." It drafts the letter with your details, you check it, and nothing is sent until you say yes. Your first month is free.',
        ],
      },
    ],
  },
];
