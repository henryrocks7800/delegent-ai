// Legal page — Privacy Policy for Delegent AI (data controller).
// Content sourced from @sidekick/shared/legal.
import {
  DELEGENT_PRIVACY_TITLE,
  DELEGENT_PRIVACY_UPDATED,
  DELEGENT_PRIVACY_INTRO,
  DELEGENT_PRIVACY_SECTIONS,
} from '@sidekick/shared';
import { LegalPage } from '../Legal';

export default function PrivacyPage() {
  return (
    <LegalPage
      title={DELEGENT_PRIVACY_TITLE}
      updated={DELEGENT_PRIVACY_UPDATED}
      intro={DELEGENT_PRIVACY_INTRO}
      sections={DELEGENT_PRIVACY_SECTIONS}
    />
  );
}
