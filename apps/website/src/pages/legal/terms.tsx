// Legal page — Terms of Service for Delegent AI (contracting party).
// Content sourced from @sidekick/shared/legal.
import {
  DELEGENT_TERMS_TITLE,
  DELEGENT_TERMS_UPDATED,
  DELEGENT_TERMS_INTRO,
  DELEGENT_TERMS_SECTIONS,
} from '@sidekick/shared';
import { LegalPage } from '../Legal';

export default function TermsPage() {
  return (
    <LegalPage
      title={DELEGENT_TERMS_TITLE}
      updated={DELEGENT_TERMS_UPDATED}
      intro={DELEGENT_TERMS_INTRO}
      sections={DELEGENT_TERMS_SECTIONS}
    />
  );
}
