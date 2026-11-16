import { useEffect, useState } from 'react';
import { Header } from './sections/Header';
import { Hero } from './sections/Hero';
import { Ticker } from './sections/Ticker';
import { MoneyStory } from './sections/MoneyStory';
import { VoiceHook } from './sections/VoiceHook';
import { ValueProps } from './sections/ValueProps';
import { ConnectedApps } from './sections/ConnectedApps';
import { HowItWorks } from './sections/HowItWorks';
import { BuiltInSkills } from './sections/BuiltInSkills';
import { Pricing } from './sections/Pricing';
import { Trust } from './sections/Trust';
import { FAQ } from './sections/FAQ';
import { CTA } from './sections/CTA';
import { Footer } from './sections/Footer';
import { LegalPage } from './pages/Legal';
import { GuidePage } from './pages/Guide';
import { GUIDE_QUICK, GUIDE_DEEP } from './content/guides';
import {
  DELEGENT_PRIVACY_TITLE,
  DELEGENT_PRIVACY_UPDATED,
  DELEGENT_PRIVACY_INTRO,
  DELEGENT_PRIVACY_SECTIONS,
  DELEGENT_TERMS_TITLE,
  DELEGENT_TERMS_UPDATED,
  DELEGENT_TERMS_INTRO,
  DELEGENT_TERMS_SECTIONS,
  DELEGENT_DELETION_TITLE,
  DELEGENT_DELETION_UPDATED,
  DELEGENT_DELETION_INTRO,
  DELEGENT_DELETION_SECTIONS,
  DELEGENT_NOTICES_TITLE,
  DELEGENT_NOTICES_UPDATED,
  DELEGENT_NOTICES_INTRO,
  DELEGENT_NOTICES_SECTIONS,
} from '@sidekick/shared';

function getRoute(): string {
  if (typeof window === 'undefined') return '/';
  return window.location.pathname.replace(/\/$/, '') || '/';
}

export function App() {
  const [route, setRoute] = useState<string>(getRoute);

  useEffect(() => {
    const onPop = () => setRoute(getRoute());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Scroll to the "#section" target when arriving with a hash (e.g. following a
  // header/burger link like "/#pricing" from a sub-page such as /guides). The
  // homepage sections are rendered by React after the initial HTML, so the
  // browser's native hash scroll fires before they exist and leaves you at the
  // top. Retry across a few frames until the target mounts, and offset by the
  // sticky header so the heading isn't tucked underneath it.
  useEffect(() => {
    const scrollToHash = () => {
      const id = decodeURIComponent(window.location.hash.slice(1));
      if (!id) return;
      let frames = 0;
      const tick = () => {
        const el = document.getElementById(id);
        if (el) {
          const header = document.querySelector('header');
          const offset = (header?.getBoundingClientRect().height ?? 64) + 8;
          const top = el.getBoundingClientRect().top + window.scrollY - offset;
          window.scrollTo({ top: Math.max(0, top), behavior: 'auto' });
        } else if (frames++ < 20) {
          requestAnimationFrame(tick);
        }
      };
      requestAnimationFrame(tick);
    };
    scrollToHash();
    window.addEventListener('hashchange', scrollToHash);
    return () => window.removeEventListener('hashchange', scrollToHash);
  }, [route]);

  if (route === '/legal/privacy') {
    return (
      <LegalPage
        title={DELEGENT_PRIVACY_TITLE}
        updated={DELEGENT_PRIVACY_UPDATED}
        intro={DELEGENT_PRIVACY_INTRO}
        sections={DELEGENT_PRIVACY_SECTIONS}
      />
    );
  }

  if (route === '/legal/terms') {
    return (
      <LegalPage
        title={DELEGENT_TERMS_TITLE}
        updated={DELEGENT_TERMS_UPDATED}
        intro={DELEGENT_TERMS_INTRO}
        sections={DELEGENT_TERMS_SECTIONS}
      />
    );
  }

  if (route === '/legal/delete') {
    return (
      <LegalPage
        title={DELEGENT_DELETION_TITLE}
        updated={DELEGENT_DELETION_UPDATED}
        intro={DELEGENT_DELETION_INTRO}
        sections={DELEGENT_DELETION_SECTIONS}
      />
    );
  }

  if (route === '/legal/notices') {
    return (
      <LegalPage
        title={DELEGENT_NOTICES_TITLE}
        updated={DELEGENT_NOTICES_UPDATED}
        intro={DELEGENT_NOTICES_INTRO}
        sections={DELEGENT_NOTICES_SECTIONS}
      />
    );
  }

  if (route === '/guides') {
    return <GuidePage guide={GUIDE_QUICK} />;
  }

  if (route === '/guides/how-it-works') {
    return <GuidePage guide={GUIDE_DEEP} />;
  }

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1">
        <Hero />
        <Ticker />
        <MoneyStory />
        <ValueProps />
        <VoiceHook />
        <ConnectedApps />
        <HowItWorks />
        <BuiltInSkills />
        <Pricing />
        <Trust />
        <FAQ />
        <CTA />
      </main>
      <Footer />
    </div>
  );
}
