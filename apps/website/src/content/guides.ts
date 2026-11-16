import { AGENT_HOWTO_INTRO, AGENT_HOWTO_SECTIONS } from '@sidekick/shared';
import { WEB_APP_DISPLAY_URL } from '../components/webAppLink';

export interface GuideSection {
  readonly title: string;
  readonly body: readonly string[];
}

export interface Guide {
  readonly slug: string; // path under /guides, '' for the index
  readonly title: string;
  readonly intro: string;
  readonly sections: readonly GuideSection[];
  readonly relatedHref?: string;
  readonly relatedLabel?: string;
}

// Both guides are the app's own how-to guide for the coworker plan
// (AGENT_HOWTO_SECTIONS in packages/shared), split in two, so the website and
// the product explain it the same way.
const [JUST_ASK, EVERYDAY, BUILT_IN, CONNECTING, KNOW_YOU, TALK, ALLOWANCE, IN_CONTROL] = AGENT_HOWTO_SECTIONS;

// Quick, practical getting-started guide. Lives at /guides.
export const GUIDE_QUICK: Guide = {
  slug: '',
  title: 'Getting started with your coworker',
  intro: AGENT_HOWTO_INTRO,
  sections: [
    JUST_ASK,
    EVERYDAY,
    BUILT_IN,
    CONNECTING,
    {
      title: 'Phone, computer, or both',
      body: [
        `Your coworker is not stuck on your phone. Open ${WEB_APP_DISPLAY_URL} in any browser on your laptop or desktop and sign in the same way you sign in on the app: same coworker, same conversation.`,
        'Most people use both. The phone is for asking on the move, and the browser is the easier place to read a long document or type a detailed request.',
      ],
    },
  ],
  relatedHref: '/guides/how-it-works',
  relatedLabel: 'Go deeper: Understanding your coworker',
};

// The deeper guide. Lives at /guides/how-it-works.
export const GUIDE_DEEP: Guide = {
  slug: 'how-it-works',
  title: 'Understanding your coworker',
  intro: 'How your coworker learns about you, what Talk does, how the monthly allowance works, and where it always checks with you first.',
  sections: [
    KNOW_YOU,
    TALK,
    ALLOWANCE,
    IN_CONTROL,
    {
      title: 'What it cannot do',
      body: [
        'It never books, pays for or buys anything itself: it finds and compares, and you make the booking through the link.',
        'It cannot run code, run anything on a schedule, make phone calls, or click through websites for you. When a job needs one of those, it says so plainly and tells you the next step.',
        'AI can get things wrong, so check anything important before you rely on it.',
      ],
    },
  ],
  relatedHref: '/guides',
  relatedLabel: 'Back to Getting started',
};

export const GUIDES: readonly Guide[] = [GUIDE_QUICK, GUIDE_DEEP];
