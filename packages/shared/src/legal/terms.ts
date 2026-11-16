export type TermsSection = {
  readonly title: string;
  readonly body: readonly string[];
};

export const DELEGENT_TERMS_TITLE = 'Delegent AI Terms of Service';
export const DELEGENT_TERMS_UPDATED = '28 September 2026';

export const DELEGENT_TERMS_INTRO =
  "These Terms of Service form a legally binding agreement between you and Delegent AI, a UK company registered in England and Wales under (\"Delegent AI\", \"we\", \"us\", or \"our\"). They govern your access to and use of Delegent AI and its related mobile apps, websites, messenger integrations, files, paid subscriptions, and AI coworker (together, the \"Services\"). By accessing or using the Services, you agree to be bound by these Terms. If you do not agree, do not use the Services.";

export const DELEGENT_TERMS_SECTIONS: readonly TermsSection[] = [
  {
    title: '1. Who we are and what Delegent AI does',
    body: [
      "Delegent AI is the provider of Delegent AI. We are a private limited company registered in England and Wales under, with our registered office at [registered office address] We operate under the laws of England and Wales.",
      "Delegent AI gives you an AI coworker that you message through the Delegent AI app and web app. They can draft, research, organise, summarise, prepare files, chase follow-ups, and carry out other digital admin work for you.",
      "Your coworker runs on our cloud infrastructure, provided by Cloudflare, rather than on a computer of its own. It works in the apps you connect, uses built-in tools such as web search, news, weather, travel and price comparisons, makes documents such as PDFs, and remembers your preferences. It does not keep a separate file store and does not run tasks on a schedule.",
      "These Terms cover the Delegent AI mobile app, our websites, the billing system, and the related services. For information on how we collect and use your personal information, please read the Delegent AI Privacy Policy.",
    ],
  },
  {
    title: '2. Eligibility and your account',
    body: [
      "You must be at least 18 years old and have the legal capacity in your country to enter into a contract to use Delegent AI. The Services are not designed for, marketed to, or intended to be used by children.",
      "Delegent AI is offered in the United Kingdom, the United States, Canada, Australia, and New Zealand. We do not offer the Services in the European Economic Area. If you use the Services from a country where they are not offered, you do so on your own initiative and at your own risk, and these Terms still apply.",
      "To use the full Services you need to sign in (Google sign-in or email magic link). You are responsible for keeping your sign-in details secure and for everything that happens under your account. You agree to provide accurate and complete information when signing up, to keep that information up to date, and to not share your account, sell access, or operate multiple accounts to evade limits or moderation.",
      "You can stop using Delegent AI at any time, sign out from the app, and ask us to close your account by emailing admin@example.com. When your account is closed we will delete your personal information except where we are required to retain it for legal, tax, accounting, fraud-prevention, or other lawful purposes (see the Privacy Policy).",
    ],
  },
  {
    title: '3. Acceptable use',
    body: [
      "Use Delegent AI only for lawful purposes. You promise that the instructions, files, accounts, and information you provide are yours to provide, do not infringe anyone else's rights, and comply with all laws that apply to you.",
      "You must not use the Services to: break any law that applies to you; harm, threaten, harass, defame, or stalk any person; produce, promote, or distribute child sexual abuse material or content that exploits or endangers children; create or share terrorist or extreme-violence content; engage in fraud, deception, or unfair business practices; infringe intellectual property, trade secrets, or confidentiality obligations; or distribute spam.",
      "You must not: gain unauthorised access to any network, system, server, or account; interfere with the normal functioning, security, or stability of the Services; intercept, tamper with, or steal data; reverse-engineer, decompile, disassemble, scrape, or otherwise attempt to extract our source code, model weights, training data, prompts, or proprietary system architecture; bypass or undermine our safety filters, watermarks, AI-generated content labels, or content-moderation controls; develop, train, deploy, or make available products or services that compete with the Services using output you obtain from us; or copy, sell, sublicense, or redistribute the Services without our prior written consent.",
      "You must not use automated tools (bots, scrapers, scheduled tasks, or similar) to access or simulate human use of the Services, except where we expressly permit it. You must not send the same or substantially similar requests at high volume in a way that disrupts the Services for others or abuses system capacity.",
      "You must not use the Services to take regulated decisions about people (credit, employment, insurance, housing, education, healthcare, social welfare) based only on AI output without independent human judgement, to perform real-time remote biometric identification in public spaces, to create or expand facial-recognition or biometric databases without informed consent, to impersonate any person without their consent, or to generate forged or fraudulent documents such as government IDs, certificates, medical reports, or legal notices.",
      "We may restrict, suspend, or terminate access where we reasonably believe these Terms or applicable law have been breached, or to comply with a binding legal obligation. Where it is lawful and practical to do so, we will tell you first.",
    ],
  },
  {
    title: '4. Connected messengers, files, and third-party services',
    body: [
      "Delegent AI works with third-party services to deliver the Services, including: Google (sign-in), Stripe (payments on the web and Android), Apple (payments and subscription management for purchases made on iPhone or iPad), Telegram and other messengers as they are added, and our hosting and AI inference providers. Each of these is governed by its own terms and privacy notice.",
      "When you connect a messenger, you allow Delegent AI to receive messages, attachments, and context from that chat to carry out the tasks you brief, and to send replies, drafts, and files back to you through that same chat. Only connect accounts and chats that you own or are authorised to use.",
      "Files, drafts, summaries, and other results created for you are returned to you in the chat, where a PDF comes as a download link. There is no separate file store, so save anything you want to keep, for example to your own Google Drive, Dropbox or OneDrive.",
      "Built-in tools search third-party sources for you, for example flight, hotel, event and price-comparison services. Delegent AI finds and compares options and gives you links; it never books, reserves, or pays for anything. Prices and availability come from those sources, can change, and are not guaranteed by us. Any booking or purchase you make through a link is between you and that third party, under its terms.",
      "We rely on commercially reasonable contracts and security measures with our providers, but we are not responsible for the availability, accuracy, security, or behaviour of third-party services we do not control. Third-party outages, changes, or restrictions may affect the Services.",
    ],
  },
  {
    title: '5. Content, AI output, autonomous actions, and your responsibility',
    body: [
      "\"Input\" means anything you submit to the Services (prompts, instructions, files, audio, images, attachments). \"Output\" means anything generated for you in response. Together, they are \"Content\".",
      "You keep the rights you already have in your Input. As between you and us, and subject to your compliance with these Terms, you may use Output for any lawful purpose. Because outputs are generated probabilistically, similar or identical Output may be produced for other users, we do not promise originality.",
      "By submitting Input you confirm that you have all rights and consents needed to give us that Input and to let our infrastructure providers process it on our behalf. Do not submit personal information about other people, regulated personal data, confidential third-party material, copyrighted material you do not have the right to share, or anything you do not have the right to share with an AI service and any providers involved in delivering the Services.",
      "AI output can be inaccurate, incomplete, biased, or otherwise unsuitable. Output is not professional legal, medical, financial, tax, employment, safety, or other regulated advice. You must independently check Output before using it for any important decision, and you remain responsible for the actions that you, your coworker, or anyone you authorise take using Output.",
      "Delegent AI is an autonomous AI coworker. Where you ask it to, and within the accounts and tools you connect, it can take actions on your behalf, including creating, editing, sending, moving, and deleting messages, files, and other content. You authorise your coworker to take these actions as your agent, and you are responsible for the instructions you give and any standing permissions you grant. Some actions, such as deleting data, sending messages, or changing settings in a connected account, can be immediate and irreversible. You are responsible for reviewing and confirming actions before they are carried out, in particular destructive or irreversible ones, and for using any confirmation, approval, or review controls we make available. Do not give your coworker instructions, access, or standing permissions whose consequences you are not willing to accept.",
      "Delegent AI is not a backup service. You are responsible for keeping your own independent copies of anything important, including your conversations, the files your coworker makes for you, and content in any account you connect. To the maximum extent permitted by law, and subject to section 9 and to the rights that cannot be excluded under UK law, we are not responsible for loss of, damage to, or unwanted changes to data in your connected third-party accounts (such as email, messaging, or file-storage accounts) that result from instructions you, your coworker, or anyone you authorise gave, or from your use of the autonomous features described above.",
      "We may use your Content to operate, maintain, secure, and improve the Services, to comply with legal obligations, to enforce our policies, and to investigate abuse. You may opt out of having your Content used to improve our service or train models by emailing admin@example.com. We will honour that choice in line with applicable law.",
    ],
  },
  {
    title: '6. Plans, billing, and capacity',
    body: [
      "Some features of the Services require a paid subscription. The available plans, prices, billing frequency, capacity, and any free or paid trial details are shown at checkout. On the web and on Android, by choosing a plan you authorise us and our payment processor, Stripe, to charge your selected payment method for the recurring fees and applicable taxes; Stripe handles payment processing under its own terms and we do not store full card details. On iPhone and iPad, subscriptions are purchased through Apple's In-App Purchase, Apple is the merchant of record, and your purchase, renewal, cancellation, and refund are governed by Apple's own Media Services Terms and Conditions rather than by Stripe.",
      "Subscriptions renew automatically at the end of each billing cycle (for example, monthly) until you cancel. You can cancel from the Manage Plan / Billing Portal screen in the app at any time. Cancellation stops the next renewal; the plan remains active until the end of the current paid period, after which capacity ends. If your subscription was bought through an app store, that store's billing, cancellation, and refund rules also apply.",
      "Because Delegent AI is digital content and digital services that start immediately on purchase, by completing checkout you ask us to start the Services straight away and acknowledge that you lose the 14-day right of withdrawal under the Consumer Contracts (Information, Cancellation and Additional Charges) Regulations 2013 once performance has begun. Your statutory rights under the Consumer Rights Act 2015, including the right to a digital service performed with reasonable care and skill, are unaffected.",
      "Fees already paid for the current billing period are non-refundable except where required by law. If we change prices we will give you at least 30 days' notice before any new price applies to your plan. You can cancel before the new price takes effect to avoid the change; continued use after the notice period accepts the new price.",
      "If payment fails we may pause the Services until payment succeeds. If your monthly capacity is reached, Delegent AI may pause new work until you upgrade, top up, or your next billing period begins.",
      "The Delegent AI coworker plan includes a monthly allowance of use, shown in the app under Manage plan. It refreshes at the start of each billing period and unused allowance does not roll over. A free month, where offered, comes with a smaller allowance and fewer minutes of Talk. We do not describe the plan as unlimited: the allowance keeps the plan fast and affordable for everyone.",
      "Top-ups. On the Delegent AI coworker plan you can buy extra use in the app. A top-up is added to your account straight away, is used only once your monthly allowance for the current billing period has been used, and expires 12 months after you buy it; any part not used by then is lost. Top-ups have no cash value, cannot be transferred or exchanged, and are not refundable except where the law requires. Because a top-up is digital content supplied straight away, when you buy one you ask us to supply it immediately and acknowledge that you lose your 14-day right to cancel that purchase once it has been added to your account; your statutory rights under the Consumer Rights Act 2015 are unaffected. If your subscription ends, any unexpired top-up stays on your account and can be used if you subscribe again before it expires.",
    ],
  },
  {
    title: '7. Our intellectual property and your licence',
    body: [
      "Except for content owned by you, your contributors, or third-party rights-holders, all intellectual property in the Services, including the Delegent AI brand, software, AI prompts and pipelines, user-interface designs, documentation, and the underlying technology, belongs to Delegent AI or our licensors.",
      "We grant you a limited, personal, non-exclusive, non-transferable, revocable licence to use the Services as expressly permitted by these Terms. You must not remove, hide, or interfere with any AI-generated content labels, watermarks, or notices we apply to Output.",
      "If you publish Output, you remain responsible for ensuring it complies with applicable law and any third-party rights. Any references to third-party products, services, or organisations in Output do not imply endorsement, affiliation, or recommendation by Delegent AI.",
    ],
  },
  {
    title: '8. Availability, changes, and our responsibility',
    body: [
      "We provide the Services with reasonable care and skill. Delegent AI may occasionally be unavailable, delayed, rate-limited, or changed as we improve the product, respond to third-party-provider changes, or carry out maintenance. We may add, remove, or alter features, integrations, plans, and usage limits.",
      "Delegent AI is a new and evolving service. Features, integrations, and behaviour may change, and the Services, including AI behaviour and automation, may contain errors or behave unexpectedly. None of this reduces the statutory rights you have that cannot be excluded under UK law.",
      "Some features are marked beta in the app, currently Talk, the spoken conversation with your coworker. A beta feature is still being tested: it may mishear you, pause, stop, give shorter or less complete answers than the chat, or be changed or withdrawn at any time. Anything you ask for in Talk is also recorded in your chat, where you can check it, and beta features never change what you pay.",
      "We do not warrant that the Services or any Output will be uninterrupted, error-free, always available, accurate, complete, or fit for any particular purpose, except where the law gives you rights that cannot be excluded.",
    ],
  },
  {
    title: '9. Limits on our liability',
    body: [
      "To the maximum extent permitted by law, neither party is liable to the other for indirect, special, consequential, or exemplary losses (including loss of profit, business, goodwill, anticipated savings, or business opportunity) arising from these Terms or your use of the Services.",
      "Subject to the next paragraph, our total liability to you under or in connection with these Terms in any 12-month period is limited to the greater of (a) the fees you paid us in that period and (b) £100.",
      "Nothing in these Terms limits or excludes any liability that cannot be limited or excluded under UK law, including: death or personal injury caused by negligence; fraud or fraudulent misrepresentation; statutory consumer rights that cannot be excluded under the Consumer Rights Act 2015; and any other liability that cannot lawfully be excluded.",
    ],
  },
  {
    title: '10. Indemnity',
    body: [
      "If a third party brings a claim against Delegent AI that arises from (a) your breach of these Terms, (b) Content you submit to the Services in breach of these Terms or applicable law, or (c) decisions you, your coworker, or anyone you authorise take using Output, you agree to indemnify Delegent AI against the losses, claims, demands, fines, and reasonable legal costs that result. This does not apply to losses caused by our negligence or our breach of these Terms, or to any liability that cannot be excluded under UK law.",
    ],
  },
  {
    title: '11. Suspension and termination',
    body: [
      "You may stop using Delegent AI at any time and ask us to delete your account by emailing admin@example.com. Once your account is deleted, your access to the Services ends and your conversation, your coworker's memory and your files are erased.",
      "We may suspend or terminate your access if: you break these Terms or applicable law; we are required to do so by law or by a third-party provider; you owe fees that we have not been able to collect; or we reasonably believe your account is compromised, fraudulent, or being used to harm others. Where lawful and practical, we will give you advance notice and a chance to put things right.",
      "Sections of these Terms that, by their nature, are intended to survive termination, including our intellectual property, disclaimers, liability limits, indemnity, governing law, and dispute resolution, will continue to apply after the Services end.",
    ],
  },
  {
    title: '12. Changes to these Terms',
    body: [
      "We may update these Terms to reflect product changes, legal updates, or operational changes. If a change materially affects your rights or how the Services work, we will give you reasonable notice, typically by an in-app notice or by email, before the new version takes effect. Continued use of the Services after the change takes effect means you accept the updated Terms. If you do not accept them, you should stop using the Services and may cancel your subscription as set out in section 6.",
    ],
  },
  {
    title: '13. Governing law and disputes',
    body: [
      "These Terms, and any non-contractual obligations arising out of or in connection with them, are governed by UK law, specifically the law of England and Wales.",
      "If you are a UK consumer, you and we agree that the courts of England and Wales have non-exclusive jurisdiction to hear disputes, and you can still bring proceedings in the part of the UK where you live (for example, Scotland or Northern Ireland) if you are entitled to do so. If you are a consumer resident in the European Economic Area, nothing in these Terms deprives you of the protection of the mandatory consumer-protection laws of the country where you live, and you may be able to bring proceedings there where the law gives you that right. If you are otherwise based outside the UK, the courts of England and Wales have exclusive jurisdiction.",
      "Before going to court, we encourage you to contact us at admin@example.com so we can try to resolve things with you directly. If we cannot resolve it, you may be able to use an Online Dispute Resolution platform (where it remains available to UK residents) or another alternative dispute-resolution scheme; we will tell you if any specific scheme applies.",
    ],
  },
  {
    title: '14. Contact and general',
    body: [
      "General queries: support@example.com. Privacy queries (including data-subject requests): admin@example.com. Registered office: Delegent AI (), [registered office address]",
      "These Terms, together with the Delegent AI Privacy Policy and any specific terms shown at checkout, are the entire agreement between you and us regarding the Services. If any part of these Terms is held invalid by a court, the remaining parts will continue in force. Our failure to enforce any part of these Terms is not a waiver of our rights.",
    ],
  },
];
