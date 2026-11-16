import React, { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { BackHandler, Pressable, ScrollView, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { AGENT_ENGINE_UNSUPPORTED_CONNECTIONS, CONNECTABLE_SERVICES, assistantWording } from '@sidekick/shared';
import { Badge, Button, Stack, Surface, Text, useThemeColors } from '../design/primitives';
import { space, radii } from '../design/tokens';
import { track } from '../analytics/analyticsClient';
import { ConnectionIdentity } from '../connections/ConnectionIdentity';
import { useIsAgentEngine } from '../state/coworkerEngine';
import { useConnectionInventory } from '../connections/useConnectionInventory';
import { fetchConnectionStates, fetchComposioConnections } from '../connections/connectionsApi';
import { canShowPurchaseUi, readApplePlanOffers, usesStoreKit } from '../billing/appleIap';
import type { ApplePlanOffer } from '../billing/appleOffer';
import { journeyInvitation, onboardingGroups, toggleApp } from './appJourney';
import { loadOnboardingApps, saveOnboardingApps } from './onboardingApps';
import type { OnboardingGoal } from './growthContent';
import { JobDemo } from './JobDemo';
import { AppOrbit, POPULAR_APPS, Pop, Rise, StepProgress } from './motion';
import { MoneyCheck, MoneyNudge, MoneyPlanCard } from './MoneyCheck';
import { saveMoneyIntent, useMoneyIntent } from './useMoneyIntent';
import { BrandMarkGlyph } from '../connections/ConnectionIdentity';

const sameWording = (text: string) => text;

/** Mount with the authenticated user's key so account changes discard local choices. */
export function GoalOnboarding({ renderNameStep, onSignOut, trialCandidate }: {
  renderNameStep: (goal: OnboardingGoal) => ReactNode;
  onSignOut: () => void | Promise<void>;
  trialCandidate: boolean;
}) {
  const colors = useThemeColors();
  const agentEngine = useIsAgentEngine();
  const say = agentEngine ? assistantWording : sameWording;
  const [step, setStep] = useState<'money' | 'apps' | 'summary' | 'name'>('apps');
  const [selected, setSelected] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showDemo, setShowDemo] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [readFailed, setReadFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [appleOffer, setAppleOffer] = useState<ApplePlanOffer>();
  const active = useRef(true);
  const busy = useRef(false);
  const scroll = useRef<ScrollView>(null);
  const { inventory, load: reloadInventory } = useConnectionInventory(fetchConnectionStates, fetchComposioConnections);
  // The money check (2026-09-27). Anyone who has not done it, on the sign-in
  // screen or here, meets it first; anyone who asked us to find their money
  // arrives with the email apps already open, and the summary names the job.
  const money = useMoneyIntent();
  const moneyRouted = useRef(false);
  const wantsMoney = Boolean(money.intent?.wants);
  const groups = onboardingGroups(inventory.available, agentEngine);
  const chosen = CONNECTABLE_SERVICES.filter((service) => selected.includes(service.id)
    && !(agentEngine && AGENT_ENGINE_UNSUPPORTED_CONNECTIONS.includes(service.id)));
  const invitation = journeyInvitation(trialCandidate, usesStoreKit(), appleOffer, agentEngine);
  const locked = loading || saving || readFailed;

  const restore = useCallback(async () => {
    setLoading(true); setReadFailed(false); setError(null);
    try {
      const ids = await loadOnboardingApps(() => active.current);
      if (active.current) setSelected(ids);
    } catch {
      if (active.current) { setReadFailed(true); setError('We could not load your app choices. Please try again.'); }
    } finally { if (active.current) setLoading(false); }
  }, []);

  useEffect(() => {
    active.current = true;
    void restore();
    return () => { active.current = false; };
  }, [restore]);
  useEffect(() => {
    let current = true;
    if (trialCandidate && usesStoreKit() && canShowPurchaseUi()) {
      void readApplePlanOffers().then((offers) => { if (current) setAppleOffer(offers.studio); }).catch(() => undefined);
    }
    return () => { current = false; };
  }, [trialCandidate]);

  const move = (next: typeof step) => { setStep(next); setShowDemo(false); scroll.current?.scrollTo({ y: 0, animated: false }); };
  const back = () => { if (!busy.current) move(step === 'name' ? 'summary' : 'apps'); };
  useEffect(() => {
    if (!money.loaded || moneyRouted.current) return;
    moneyRouted.current = true;
    if (!money.intent) setStep('money');
    else if (money.intent.wants) setExpanded('email');
  }, [money.loaded, money.intent]);
  useEffect(() => {
    if (step === 'apps' || step === 'money') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { back(); return true; });
    return () => sub.remove();
  }, [step]);

  async function continueWithApps() {
    if (busy.current || locked) return;
    busy.current = true; setSaving(true); setError(null);
    try {
      await saveOnboardingApps(selected, () => active.current);
      if (!active.current) return;
      track('onboarding_goal_selected', { goal: 'something_else' });
      move('summary');
    } catch {
      if (active.current) setError('Could not save your app choices. Please try again.');
    } finally { busy.current = false; if (active.current) setSaving(false); }
  }

  // A blank frame for the moment it takes to read the check off the device, so
  // nobody sees the apps step flash before the money check replaces it.
  if (!money.loaded) return <View style={{ flex: 1 }} />;
  if (step === 'money') return <MoneyCheck from="onboarding" onDone={(choice) => {
    void saveMoneyIntent(choice).then(money.setIntent);
    if (choice.wants) setExpanded('email');
    move('apps');
  }} />;

  if (step === 'name') return <View style={{ flex: 1 }}>
    <Button testID="onboarding.backToSummary" variant="ghost" onPress={back}>Back to my apps</Button>
    {renderNameStep('something_else')}
  </View>;

  // The orbit on the summary step shows the apps this person just chose, so the
  // picture they meet is the one they built; with none chosen, the popular ones.
  // Yours first and solid, then popular apps faded, so two picks still make a
  // full orbit and read as "these, and plenty more when you want them".
  const orbitServices = chosen.length
    ? [...chosen, ...POPULAR_APPS.filter((service) => !selected.includes(service.id))]
    : POPULAR_APPS;
  const orbitHighlight = chosen.length ? new Set(chosen.map((service) => service.id)) : undefined;
  const trayServices = CONNECTABLE_SERVICES.filter((service) => selected.includes(service.id));

  return <View style={{ flex: 1 }}>
    <ScrollView key={step} ref={scroll} contentContainerStyle={{ padding: 24, gap: 24, paddingBottom: 16 }}>
      <Rise>
        <Stack gap={3}>
          <StepProgress step={step === 'apps' ? 1 : 2} />
          <Badge tone="accent">{step === 'apps' ? '1 of 3 · Your apps' : say('2 of 3 · Your coworker')}</Badge>
          <Text variant="displayLg">{step === 'apps' ? 'What would you like help managing?' : chosen.length ? 'Your apps. A little less on your plate.' : 'A little less on your plate.'}</Text>
          <Text variant="body" color="textSecondary">{say(step === 'apps'
            ? 'An AI coworker that works with your apps. Choose the ones you use, then give it the everyday work you want off your plate.'
            : 'From answering questions to getting things done. Connect your chosen apps after setup, then ask your coworker to help with the work inside them.')}</Text>
        </Stack>
      </Rise>

      {step === 'apps' ? <Stack gap={3}>
        {wantsMoney ? <Rise delay={100}>
          <MoneyNudge testID="onboarding.moneyNudge" text="To find your money, pick the email your bookings and receipts go to. You connect it after setup." />
        </Rise> : null}
        <Rise delay={120}>
          <Text variant="caption" color="textSecondary">Open a category and choose as many apps as you like. You can connect them later.</Text>
        </Rise>
        {loading || inventory.pending ? <Text testID="onboarding.appsLoading" variant="caption" color="textSecondary">Loading your apps…</Text> : null}
        {inventory.error ? <Surface padding={3} radius="lg" border><Stack gap={2}>
          <Text variant="caption" color="textSecondary">Some apps could not be loaded. Retry to see the full list, or choose your apps later.</Text>
          <Button testID="onboarding.retryCatalogue" variant="secondary" disabled={inventory.pending} onPress={() => void reloadInventory()}>Retry app list</Button>
        </Stack></Surface> : null}
        {groups.map((group, index) => {
          const open = expanded === group.key;
          const count = group.rows.filter((row) => selected.includes(row.service.id)).length;
          {/* Only set the colour when there is one: an undefined borderColor
              resets the Surface's hairline to black. */}
          return <Rise key={group.key} delay={180 + index * 55}><Surface elevation="surfaceHigh" radius="lg" border style={[{ padding: space[4] }, count ? { borderColor: colors.accent } : null]}>
            <Pressable testID={`onboarding.category.${group.key}`} accessibilityRole="button"
              accessibilityLabel={group.label} accessibilityState={{ expanded: open, disabled: locked }}
              disabled={locked} onPress={() => setExpanded(open ? null : group.key)}>
              <Stack direction="horizontal" gap={3} align="center">
                <Pop on={count > 0}>
                  <View style={{ width: 42, height: 42, borderRadius: radii.md, backgroundColor: group.tint ?? colors.accentMuted, alignItems: 'center', justifyContent: 'center' }}>
                    <Text style={{ fontSize: 22 }}>{group.emoji}</Text>
                  </View>
                </Pop>
                <Stack gap={1} style={{ flex: 1 }}>
                  <Text variant="title">{group.label}</Text>
                  <Text variant="caption" color="textSecondary">{count ? `${count} selected · ` : ''}{group.rows.length} {group.rows.length === 1 ? 'app' : 'apps'}</Text>
                </Stack>
                <Feather name={open ? 'chevron-down' : 'chevron-right'} size={20} color={colors.textSecondary} />
              </Stack>
            </Pressable>
            {open ? <Stack gap={3} style={{ marginTop: space[3], paddingTop: space[3], borderTopWidth: 1, borderTopColor: colors.border }}>
              {group.rows.map(({ service }, rowIndex) => {
                const checked = selected.includes(service.id);
                return <Rise key={service.id} delay={rowIndex * 45} distance={10}><Pressable testID={`onboarding.app.${service.id}`}
                  accessibilityRole="checkbox" accessibilityLabel={service.name}
                  accessibilityHint={service.blurb} accessibilityState={{ checked, disabled: locked }}
                  disabled={locked} onPress={() => setSelected((ids) => toggleApp(ids, service.id))}
                  style={{ borderWidth: 1, borderColor: checked ? colors.accent : colors.border, borderRadius: radii.lg, padding: space[4], backgroundColor: checked ? colors.accentMuted : colors.surfaceHigh }}>
                  <ConnectionIdentity service={service} wording={say} trailing={<Pop on={checked}><View style={{ width: 24, height: 24, borderWidth: 1, borderColor: checked ? colors.accent : colors.borderStrong, borderRadius: 6, backgroundColor: checked ? colors.accent : colors.surfaceHigh, alignItems: 'center', justifyContent: 'center' }}>
                    {checked ? <Feather name="check" size={16} color={colors.accentText} /> : null}
                  </View></Pop>} />
                </Pressable></Rise>;
              })}
            </Stack> : null}
          </Surface></Rise>;
        })}
      </Stack> : <Stack gap={4}>
        <Rise delay={120} style={{ alignItems: 'center' }}>
          <AppOrbit services={orbitServices} highlight={orbitHighlight} size={260} />
        </Rise>
        {wantsMoney && money.intent ? <Rise delay={260}>
          <MoneyPlanCard testID="onboarding.moneyPlan" intent={money.intent} title="FIRST JOB, WHEN YOU START"
            footnote={selected.some((id) => ['gmail', 'microsoft_outlook'].includes(id))
              ? 'Connect your email after setup and ask: "Find money I might be owed". The report takes about 15 minutes.'
              : 'Connect Gmail or Outlook after setup and ask: "Find money I might be owed". The report takes about 15 minutes.'} />
        </Rise> : null}
        {chosen.length ? <Rise delay={320}><Surface elevation="surfaceHigh" padding={4} radius="lg" border><Stack gap={4}>
          <Text variant="title">Your chosen apps</Text>
          {chosen.map((service) => <View key={service.id} testID={`onboarding.selected.${service.id}`}><ConnectionIdentity service={service} wording={say} /></View>)}
          <Text variant="caption" color="textSecondary">Your choices are saved. Each app will ask your permission when you connect it.</Text>
        </Stack></Surface></Rise> : <Rise delay={320}><Text variant="body" color="textSecondary">No need to choose everything now. Explore your apps in Connections whenever you are ready.</Text></Rise>}
        <Rise delay={440}><Surface elevation="surfaceHigh" padding={4} radius="lg" border style={{ borderColor: colors.accent }}><Stack gap={2}>
          <Text variant="title">{invitation.title}</Text>
          <Text variant="bodySm" color="textSecondary">{say('Give your coworker a task. It can help across email, files, calendars and more, with the apps you connect.')}</Text>
          <Text testID="onboarding.trialCaption" variant="caption" color="textSecondary">{invitation.caption}</Text>
        </Stack></Surface></Rise>
        <Button testID="onboarding.preview" variant="ghost" onPress={() => setShowDemo(!showDemo)}>{showDemo ? 'Hide example' : 'See an example'}</Button>
        {/* An assistant account gets the inbox example: the receipts one files
            into FreeAgent, which its engine cannot use, and the connections one
            films the workspace Connections screen. */}
        {showDemo ? <JobDemo goal={agentEngine ? 'inbox' : selected.includes('freeagent') ? 'receipts' : selected.some((id) => ['gmail', 'microsoft_outlook'].includes(id)) ? 'inbox' : 'something_else'} /> : null}
      </Stack>}
      <Button testID="onboarding.goalSignOut" variant="ghost" disabled={saving} onPress={onSignOut}>Sign out</Button>
    </ScrollView>

    <View style={{ paddingHorizontal: 24, paddingVertical: 12, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: 'rgba(250, 250, 247, 0.94)' }}>
      <Stack gap={2}>
        {error ? <Text testID="onboarding.appsError" accessibilityRole="alert" variant="caption" color="danger">{error}</Text> : null}
        {readFailed ? <Button testID="onboarding.retryChoices" variant="secondary" onPress={() => void restore()}>Retry my choices</Button> : null}
        {step === 'apps' ? <>
          {/* The tray: every app you tick pops in here, so the choice feels like
              something you are building rather than a form you are filling. */}
          {trayServices.length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            {trayServices.slice(0, 9).map((service) => <Pop key={service.id} on>
              <View style={{ width: 30, height: 30, borderRadius: 9, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceHigh, alignItems: 'center', justifyContent: 'center' }}>
                {service.brandMark ? <BrandMarkGlyph mark={service.brandMark} size={16} /> : <Text variant="caption">{service.name.slice(0, 1)}</Text>}
              </View>
            </Pop>)}
            {trayServices.length > 9 ? <View style={{ height: 30, paddingHorizontal: 8, borderRadius: 9, backgroundColor: colors.accentMuted, alignItems: 'center', justifyContent: 'center' }}>
              <Text variant="caption" color="accent">{`+${trayServices.length - 9}`}</Text>
            </View> : null}
          </View> : null}
          <Text testID="onboarding.selectionCount" variant="caption" color="textSecondary">{selected.length ? `${selected.length} ${selected.length === 1 ? 'app' : 'apps'} selected` : 'Choose your apps, or explore them later.'}</Text>
          <Button testID="onboarding.appsContinue" variant="primary" fullWidth disabled={locked} onPress={() => void continueWithApps()}>{saving ? 'Saving…' : selected.length ? 'Continue with my apps' : 'Choose apps later'}</Button>
        </> : <>
          <Button testID="onboarding.summaryContinue" variant="primary" fullWidth onPress={() => move('name')}>{invitation.button}</Button>
          <Button testID="onboarding.editApps" variant="ghost" onPress={back}>Edit my apps</Button>
        </>}
      </Stack>
    </View>
  </View>;
}
