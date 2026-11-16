// Agent engine readiness: an account on the agent engine (apps/agent) gets a
// Chat-only app with one plan and copy for what that engine does, and every
// other account keeps the app exactly as it was.
//
// Which engine comes from the Worker (GET /api/account/engine). These pin the
// gate on both sides of every difference, so a later edit cannot quietly show a
// workspace account the agent app, or an agent account a Files tab it cannot use.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const mobile = new URL('../../../../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, mobile), 'utf8');

const app = read('App.tsx');
const engineHook = read('src/state/coworkerEngine.ts');
const chatScreen = read('src/chat/WebViewChatScreen.tsx');
const chatHtml = read('assets/chat-webview/index.html');
const chatHtmlTs = read('src/chat/chatWebViewHtml.ts');

function between(source, start, end) {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `${start} not found`);
  const to = source.indexOf(end, from + start.length);
  assert.ok(to > from, `${end} not found after ${start}`);
  return source.slice(from, to);
}

test('the engine answer comes from the Worker, defaults to the workspace app, and is remembered per account', () => {
  assert.match(engineHook, /const ENGINE_PATH = '\/api\/account\/engine';/);
  assert.match(engineHook, /export const CoworkerEngineContext = createContext<CoworkerEngine>\('runner'\);/);
  assert.match(engineHook, /return engine === 'agent' \|\| engine === 'runner' \? engine : null;/, 'only the two known answers are accepted');
  assert.match(engineHook, /const CACHE_PREFIX = 'delegent\.coworkerEngine\.v1\.';/);
  assert.match(engineHook, /A remembered answer never overwrites the Worker's live one\.\s*\n\s*if \(cancelled \|\| answered\) return;/);
  assert.match(engineHook, /return state\.userId === userId \? state\.engine : 'runner';/, 'another account never inherits the answer');
  assert.match(app, /const coworkerEngine = useCoworkerEngineForUser\(authState\.status === 'authenticated' \? authState\.user\.id : null\);/);
  assert.match(app, /<CoworkerEngineContext\.Provider value=\{coworkerEngine\}>/);
});

test('an agent account has Chat only: no Files tab, no tab bar, and no file refresh', () => {
  const shell = between(app, 'function Shell({', '\ntype SidekickAppProps');
  assert.match(shell, /const shellTabs: readonly Tab\[\] = agentEngine \? \['dashboard'\] : bottomTabs;/);
  assert.match(shell, /\{shellTabs\.length > 1 \? \(\s*<Surface elevation="surface" radius="xl" border style=\{styles\.tabBar\}>/);
  assert.match(shell, /if \(agentEngine && activeTab === 'artifacts'\) setActiveTab\('dashboard'\);/);
  assert.match(shell, /if \(agentEngine\) return;\s*\n\s*void refreshRunnerFiles\(\);/);
  assert.match(shell, /\/\/ Agent engine: no Files tab to open a file in\.\s*\n\s*if \(agentEngine\) return;/);
  assert.match(app, /const bottomTabs = \['dashboard', 'artifacts'\] as const;/, 'a workspace account keeps both tabs');
});

test('the agent menu offers Chat, Connections and a fresh chat, and nothing that needs a workspace', () => {
  const menu = between(app, 'function MenuDrawer({', "menu.section.learn");
  const agentBranch = between(menu, '{agentEngine ? (', ') : (');
  assert.match(agentBranch, /testID="menu\.connectionsRow"/);
  assert.match(agentBranch, /testID="menu\.freshChatRow"[\s\S]{0,400}DeviceEventEmitter\.emit\('delegent:startFreshChat'\)/);
  for (const row of ['menu.filesRow', 'menu.commandsRow', 'menu.routinesRow']) {
    assert.doesNotMatch(agentBranch, new RegExp(row.replace('.', '\\.')), `${row} is not in the agent menu`);
  }
  const workspaceBranch = menu.slice(menu.indexOf(') : (', menu.indexOf('{agentEngine ? (')));
  for (const row of ['menu.filesRow', 'menu.commandsRow', 'menu.routinesRow', 'menu.connectionsRow']) {
    assert.match(workspaceBranch, new RegExp(row.replace('.', '\\.')), `${row} stays for a workspace account`);
  }
  assert.match(app, /\{agentEngine \? null : \(\s*<>\s*<MenuRow testID="menu\.capacityRow"/);
  assert.match(app, /\{agentEngine \? 'Delegent AI' : 'Also available on'\}/);
  assert.match(app, /\{agentEngine \? null : \(<>\s*\{\/\* 2026-07-24 \(Alex, roadmap #12\): first-class Telegram opt-in\./);
});

test('one plan at the agent price, with a strong "what you get", on every plan surface', () => {
  assert.match(app, /const agentTiers: Tier\[\] = tiers\s*\n\s*\.filter\(\(tier\) => tier\.id === AGENT_PLAN\.tierId\)/);
  assert.match(app, /price: formatAgentPlanPrice\(\),/);
  assert.match(app, /function buildProductView\(snapshot: SidekickProductSnapshot, agentEngine = false\): ProductViewModel \{/);
  assert.match(app, /if \(agentEngine\) return <AgentPlanCard tier=\{tier\} isCurrent=\{isCurrent\} offerPriceLine=\{offerPriceLine\} \/>;/);
  assert.match(app, /function AgentPlanHighlights\(\{ testID \}: \{ testID\?: string \}\) \{[\s\S]*?agentPlanHighlights\(\)\.map[\s\S]*?fontFamily: fontFamilies\.geistSemiBold/, 'each highlight leads with a bold claim');

  const paywall = between(app, 'function SetupWizardScreen({', '\nfunction ');
  assert.match(paywall, /\? \(agentEngine \? AGENT_PLAN_TRIAL_CTA : 'Start 3-day free trial'\)/);
  // On iPhone the assistant plan is quoted from StoreKit (Apple's £3.99 product
  // with its free first month, 2026-09-16); everywhere else from the Stripe copy.
  assert.match(paywall, /\? usesStoreKit\(\)\s*\n\s*\? nativeOffer\.priceLine\s*\n\s*: \(trialCandidate \? agentFreeTrialTermsLine\(\) : `\$\{formatAgentPlanPrice\(\)\} a month\. Cancel anytime\.`\)/);
  assert.match(paywall, /\(agentEngine \? appleOffers\.assistant : appleOffers\[selectedTier\]\)/, 'the assistant plan reads its own Apple product, never Studio');
  assert.match(paywall, /\? \(agentEngine \? nativeOffer\.hasFreeMonth : SIDEKICK_FREE_TRIAL\.enabled && nativeOffer\.hasThreeDayTrial\)/);
  assert.match(app, /assistant: agentEngine,\s*\n\s*\/\/ Never open StoreKit/, 'the purchase itself buys the assistant product');
  // After paying, an assistant account is not told to wait for a workspace it
  // does not have (Alex saw "spinning up your private workspace", 2026-09-16).
  assert.match(app, /const subtitle = agentEngine \? AGENT_CHECKOUT_THANK_YOU : checkoutThankYouBody\(tierName, 'app'\);/);
  assert.match(paywall, /\{agentEngine \? null : <TierSegment selectedTier=\{selectedTier\} onChange=\{chooseTier\} \/>\}/);
  assert.match(paywall, /<Text variant="caption" color="textTertiary">What you get<\/Text>\s*\n\s*<AgentPlanHighlights testID="paywall\.agentHighlights" \/>/);
  assert.match(paywall, /<FeatureRow>Files your receipts into FreeAgent<\/FeatureRow>/, 'a workspace account keeps its paywall');
  // The plan card sits on the same page as that list, so it must not repeat it
  // (it did, and the page showed all eight highlights twice).
  const agentCard = between(app, 'function AgentPlanCard({', '\nfunction PlanCard({');
  assert.doesNotMatch(agentCard, /<AgentPlanHighlights/);
  assert.match(paywall, /\{showAllPlans \? 'Hide plan details' : agentEngine \? 'See plan details' : 'See all plans'\}/, 'one plan, so no "all plans"');
  assert.match(paywall, /\{agentEngine \? 'Your connected AI coworker' : 'Your AI coworker'\}/);

  const profile = between(app, 'function ProfileScreen({', '\nfunction TabButton(');
  assert.match(profile, /\{productView\.cancelAtPeriodEnd \|\| agentEngine \? null : \(\s*<> Upgrade in a tap/, 'no upgrade nudge with only one plan');

  const capacity = between(app, 'function CapacityDrawer({', 'function checkoutErrorTitle');
  const gate = capacity.indexOf('if (!productView.hasCapacityAllowance) {');
  const agentView = capacity.indexOf('if (agentEngine) {');
  assert.ok(gate >= 0 && agentView > gate, 'the agent plan view sits behind the allowance gate');
  assert.match(capacity, /testID="capacity\.agentHighlights"/);
});

test('Connections: no FreeAgent, Skills-style categories, and the built-in tools as cards inside them', () => {
  const drawer = between(app, 'function ConnectionsDrawer({', '\n  function renderRow(');
  assert.match(drawer, /\.filter\(\(row\) => !agentEngine \|\| !AGENT_ENGINE_UNSUPPORTED_CONNECTIONS\.includes\(row\.service\.id\)\);/);
  // Alex, 2026-09-15: categories with emojis and chevrons, like Skills, and the
  // built-in tools are more connections inside them, not a block of their own.
  assert.match(drawer, /\{agentEngine \? \(\s*<Stack gap=\{3\} testID="connections\.categories">\s*\{buildAgentConnectionSections\(rows, chosenIds\)\.map\(\(section\) => \(\s*<ConnectionCategoryRow/);
  assert.match(drawer, /<BuiltInConnectionCard key=\{tool\.id\} tool=\{tool\} onTry=\{\(\) => onStartInChat\(tool\.prompt\)\} \/>/);
  assert.doesNotMatch(drawer, /connections\.everyday/, 'no separate built-in block');
  const row = between(app, 'function ConnectionCategoryRow({', '\nfunction BuiltInConnectionCard(');
  assert.match(row, /<Text style=\{\{ fontSize: 20 \}\}>\{category\.emoji\}<\/Text>/);
  assert.match(row, /<Feather name="chevron-right"/);
  assert.match(row, /backgroundColor: category\.tint/, 'coloured tiles');
  const card = between(app, 'function BuiltInConnectionCard(', '\nfunction ConnectionsDrawer(');
  assert.match(card, /backgroundColor: tool\.tint/);
  assert.match(card, /<Badge tone="accent">\{AGENT_BUILT_IN_BADGE\}<\/Badge>/);
  // The workspace layout is untouched.
  assert.match(drawer, /\{group\.label\.toUpperCase\(\)\}/);
  // An assistant, not a coworker, on the cards and the consent sheet.
  assert.match(drawer, /const say = agentEngine \? assistantWording : sameWording;/);
  assert.match(app, /<ConnectionIdentity service=\{service\} wording=\{say\}/);
});

test('skills, guides and FAQs follow the engine', () => {
  assert.match(app, /function useUseCaseCategories\(\): readonly UseCaseCategory\[\] \{\s*\n\s*return useIsAgentEngine\(\) \? agentUseCases : useCaseCategories;/);
  assert.match(app, /\{agentEngine \? AGENT_HOWTO_SECTIONS\.map\(renderSection\) : DELEGENT_HOWTO_SECTIONS\.map\(renderSection\)\}/);
  assert.match(app, /\{agentEngine \? AGENT_FAQ_ORDERED\.map\(renderItem\) : DELEGENT_FAQ_ORDERED\.map\(renderItem\)\}/);
  assert.match(app, /\{agentEngine \? null : <ProfileInfoRow label="Coworker engine" value=\{RUNNER_ENGINE_VERSION\} \/>\}/);
  // The emulator pass on 2026-09-15 found the guide's heading still said
  // "coworker" to an assistant account. And "Want to go deeper?" opened the
  // website's guide, which still describes the workspace coworker (Alex, same
  // day), so an assistant account gets no link: the guide covers it all.
  const guides = between(app, 'function HowToGuides() {', '\nfunction TermsModal(');
  assert.match(guides, /\{agentEngine \? AGENT_HOWTO_TITLE : DELEGENT_HOWTO_TITLE\}/);
  assert.doesNotMatch(guides, /\{DELEGENT_HOWTO_TITLE\}/);
  assert.match(guides, /\{agentEngine \? null : \(\s*<Surface[^>]*>\s*<Stack gap=\{2\}>\s*<Text variant="title">\{DELEGENT_HOWTO_DEEPER_TITLE\}<\/Text>/);
  assert.equal(guides.match(/testID="howto\.deepGuideLink"/g)?.length, 1);
  // So did the note under Export my data, which also promised a workspace.
  assert.match(app, /\{agentEngine \? AGENT_DATA_COPY_NOTE : DELEGENT_EXPORT_SCOPE_NOTE\}/);
  // No Export button for an assistant account (Alex, 2026-09-15); the note says
  // how to ask for a copy instead. Workspace accounts keep the button.
  assert.match(app, /\{agentEngine \? null : \(\s*<Button\s*testID="profile\.exportDataButton"/);
  assert.match(app, /testID="profile\.deleteAccountButton"/);
  // Skills tiles take the category's colour when it has one, like Connections.
  assert.equal(app.match(/backgroundColor: category\.muted \? themeColors\.surface : category\.tint \?\? themeColors\.accentMuted,/g)?.length, 2);
});

test('a new assistant subscriber is ready straight away, on a plan called Delegent AI', () => {
  // No workspace is ever built for an assistant account, so waiting for one
  // would leave a new subscriber on "Preparing" for ever.
  const productState = read('src/state/productState.ts');
  assert.match(app, /const coworkerEngine = useCoworkerEngineForUser\([^\n]+\);\s*\n\s*const productState = useMobileProductState\(authState, coworkerEngine === 'agent'\);/);
  assert.match(productState, /const gate = useMemo\(\(\) => resolveSidekickGate\(snapshot, \{ agentEngine \}\), \[snapshot, agentEngine\]\);/);
  // One name for the one plan: the app, the website and Stripe agree.
  assert.match(app, /\.\.\.tier,\s*\n\s*\/\/ One plan, called what the website and Stripe call it, not its tier's name\.\s*\n\s*name: AGENT_PLAN\.name,/);
  assert.equal(app.match(/agentEngine && profile\.plan !== 'No active plan' \? AGENT_PLAN\.name : profile\.plan/g)?.length, 2);
});

test('onboarding speaks to an assistant account about its assistant and its free month', () => {
  // Alex wants to test onboarding as a new assistant user (2026-09-15); it said
  // "AI coworker", "3-day free trial" and "Name your personal Agent".
  const goal = read('src/onboarding/GoalOnboarding.tsx');
  const demo = read('src/onboarding/JobDemo.tsx');
  assert.match(goal, /const agentEngine = useIsAgentEngine\(\);\s*\n\s*const say = agentEngine \? assistantWording : sameWording;/);
  assert.match(goal, /const groups = onboardingGroups\(inventory\.available, agentEngine\);/);
  assert.match(goal, /journeyInvitation\(trialCandidate, usesStoreKit\(\), appleOffer, agentEngine\)/);
  assert.match(goal, /say\('2 of 3 · Your coworker'\)/);
  assert.match(goal, /say\('Give your coworker a task\./);
  assert.match(goal, /backgroundColor: group\.tint \?\? colors\.accentMuted/);
  assert.match(goal, /<JobDemo goal=\{agentEngine \? 'inbox' :/);
  assert.equal(goal.match(/wording=\{say\}/g)?.length, 2, 'both app identities read as an assistant');
  assert.match(goal, /\{say\(step === 'apps'\s*\n\s*\? 'An AI coworker that works with your apps\./);
  // Every coworker sentence in the file sits inside one of those say() calls.
  assert.equal(goal.match(/\bcoworker\b/g)?.length, 4);
  assert.match(demo, /agentEngine \? 'Connect your own accounts to put your coworker to work\.' : 'Connect your own accounts to put your coworker to work\.'/);
  const nameStep = between(app, 'function NameOnboardingScreen(', '\nfunction ');
  assert.match(nameStep, /\{agentEngine \? 'Name your coworker' : 'Name your personal Agent'\}/);
  assert.match(nameStep, /\{say\(ACKNOWLEDGEMENT_TEXT\)\}/);
  assert.match(nameStep, /setErrorMessage\(say\('Give your coworker a short name to continue\.'\)\);/);
});

test('a sent photo or file shows as what the person sent, not the note written for the coworker', () => {
  // Alex, 2026-09-15: after a reload his photo read "[The user attached 1 file to
  // your workspace ...]\n\nPlease take a look...", with a literal \n\n.
  const block = chatHtml.slice(chatHtml.indexOf('const ATTACHMENT_NOTE'), chatHtml.indexOf('// One message -> its wrapper element.'));
  const userBubbleText = new Function(`${block}; return userBubbleText;`)();
  const note = (n, name) => `[The user attached ${n} file${n > 1 ? 's' : ''} to your workspace (in your files, under uploads/): ${name}. Open and read ${n > 1 ? 'them' : 'it'} from your files before replying.]`;
  assert.equal(userBubbleText(`${note(1, 'photo.jpg')}\\n\\nPlease take a look at the attached file and tell me what you find.`), 'Sent 1 file', 'the stored literal separator');
  assert.equal(userBubbleText(`${note(2, 'a.pdf, b.pdf')}\n\nPlease take a look at the attached files and tell me what you find.`), 'Sent 2 files');
  assert.equal(userBubbleText(`${note(1, 'receipt.jpg')}\n\nWhat do I owe?`), 'What do I owe?');
  assert.equal(userBubbleText('Plain message'), 'Plain message');
  assert.match(chatHtml, /<div class="msg-body">\$\{esc\(userBubbleText\(m\.content\)\)\}<\/div>/);
  // Real line breaks from now on.
  assert.match(chatHtml, /\? \(preamble \+ '\\n\\n' \+ text\)/);
  assert.doesNotMatch(chatHtml, /preamble \+ '\\\\n\\\\n'/);
  // And the chip naming the file survives a reload: history carries it.
  const norm = new Function(`${between(chatHtml, 'function norm(m) {', '\n}\n')}\n}; return norm;`)();
  const fromHistory = norm({ id: 'u1', role: 'user', content: 'Sent', created_at: '2026-09-15T17:04:00Z', attachments: [{ id: 'a1', name: 'photo.jpg', mimeType: 'image/jpeg', sizeBytes: 1 }] });
  assert.deepEqual(fromHistory.attachments, [{ id: 'a1', name: 'photo.jpg', mimeType: 'image/jpeg', sizeBytes: 1 }]);
  assert.deepEqual(norm({ id: 'u2', role: 'user', content: 'Hi' }).attachments, []);
  assert.ok(chatHtmlTs.includes("attachments: Array.isArray(m.attachments) ? m.attachments : []"), 'chatWebViewHtml.ts regenerated from index.html');
});

test('the chat is told the engine: no Telegram card, and welcome and fresh-chat copy without files', () => {
  assert.match(chatScreen, /\.\.\.\(agentEngine \? \{ pilotFeatures: \{ telegramConnect: false, voiceMode: true, voiceCapture: Platform\.OS !== 'ios' \} \} : \{\}\),\s*\n\s*agentEngine,/);
  assert.match(chatScreen, /agentEngine = false,/, 'absent means a workspace account');
  assert.match(chatHtml, /agentEngine: msg\.agentEngine === true,/);
  assert.match(chatHtml, /resetBody\.textContent = bridge\.config\.agentEngine \? AGENT_RESET_MODAL_BODY : WORKSPACE_RESET_MODAL_BODY;/);
  assert.match(chatHtml, /const AGENT_RESET_MODAL_BODY = 'This stops anything in progress and starts a new conversation\. Your coworker keeps its memory of you, and your chat history stays on screen\.';/);
  assert.match(chatHtml, /\$\{bridge\.config\.agentEngine \? 'Your connected AI coworker' : 'Your AI coworker'\}/);
  assert.match(chatHtml, /function addError\(msg, preserveRun = false\) \{ messages\.push\(\{id:'err-'\+Date\.now\(\),role:'assistant',content:say\(msg\),/);
  assert.match(chatHtml, /\$\{bridge\.config\.agentEngine \? 'Works in the apps you connect, with travel and the web built in' : '28 tools · 67 skills'\}/);
  assert.match(chatHtml, /return bridge\.config\.agentEngine \? AGENT_WELCOME_STARTERS : WELCOME_STARTERS;/);
  assert.ok(chatHtmlTs.includes('AGENT_RESET_MODAL_BODY'), 'chatWebViewHtml.ts regenerated from index.html');
  // Headlines for the engine's everyday tools, matched by exact name only.
  assert.match(chatHtml, /if \(Object\.prototype\.hasOwnProperty\.call\(everyday, n\)\) \{/);
});

test('an assistant account sees its allowance and can buy a top-up where it manages its plan', () => {
  const card = between(app, 'function AgentAllowanceCard({', '\nfunction AgentPlanCard(');
  assert.match(card, /const \{ allowance \} = useAgentAllowance\(true\);[\s\S]*?if \(!allowance\) return null;/, 'no made-up numbers before the Worker answers');
  assert.match(card, /agentTopUpConsentBody\(allowance\.topUpValidMonths\),/, 'consent before digital content starts straight away (wording held in packages/shared)');
  assert.match(card, /<CapacityProgressBar ratio=\{allowance\.allowanceUsedRatio\} hardLimited=\{allowance\.hardLimited\} nearLimit=\{percent >= 80\} showLabel=\{false\} \/>/, 'no "Monthly capacity" caption inside the allowance card');
  assert.match(card, /void startTopUpCheckout\(1\)\.then\(async \(result\) => \{[\s\S]*?Linking\.openURL\(result\.url\)/);
  assert.match(app, /<AgentAllowanceCard testID="capacity\.agentAllowance" \/>/);
  assert.match(app, /\{agentEngine && productView\.hasActiveSubscription \? <AgentAllowanceCard testID="paywall\.agentAllowance" \/> : null\}/);
  assert.match(app, /\{agentEngine && productView\.hasCapacityAllowance \? \(\s*<Entry index=\{2\}>\s*<AgentAllowanceCard testID="profile\.agentAllowance" \/>/);
  assert.match(chatHtml, /if \(quotaCta\) quotaCta\.textContent = 'Top up';/);
});

test('the chat banner measures an assistant account on its allowance, and offers a top-up, not an upgrade', () => {
  // Alex saw "close to this month's assistant-time limit" over an allowance
  // card reading 8% used (2026-09-16): the banner was reading the workspace
  // quota in the product snapshot, which still carried runner usage.
  const dashboard = between(app, 'function Dashboard({', '\nfunction ArtifactCard(');
  assert.match(dashboard, /const \{ allowance, refresh: refreshAllowance \} = useAgentAllowance\(agentEngine\);/);
  assert.match(dashboard, /useEffect\(\(\) => \{ refreshAllowance\(\); \}, \[refreshAllowance, productView\.usageSummary\.usedTokens\]\);/, 're-read after every turn');
  assert.match(dashboard, /const quota = agentEngine\s*\?\s*\{\s*hardLimited: allowance\?\.hardLimited \?\? false,\s*nearLimit: allowance \? allowanceNearLimit\(allowance\) : false,\s*nextResetAtIso: allowance\?\.nextResetAt \?\? productView\.nextResetAtIso,\s*\}/);
  assert.match(dashboard, /hardLimited=\{quota\.hardLimited\}\s*nearLimit=\{quota\.nearLimit\}\s*nextResetAtIso=\{quota\.nextResetAtIso\}/);
  assert.doesNotMatch(dashboard, /usageSummary\.nearLimit\}/, 'the chat host never hands the snapshot figure straight to the WebView');
  for (const html of [chatHtml, chatHtmlTs]) {
    const banner = between(html, 'function renderQuotaBanner()', '\nfunction showQuotaModal(');
    assert.match(banner, /const assistant = !!bridge\.config\.agentEngine;/);
    assert.match(banner, /"You're close to this month's allowance\."/);
    assert.match(banner, /"You've used this month's allowance"/);
    assert.match(banner, /Buy a top-up from £1 to keep going now, or wait for the refresh\./);
    assert.equal((banner.match(/cta\.textContent = assistant \? 'Top up' : 'Upgrade';/g) ?? []).length, 2, 'both the warning and the cap offer a top-up');
    for (const line of banner.split('\n').filter((entry) => /^\s*\? "/.test(entry))) {
      assert.doesNotMatch(line, /\btime\b/, `no "time" wording for an allowance: ${line.trim()}`);
    }
    assert.match(html, /bridge\.config\.agentEngine \? 'Top up to keep chatting' : 'Upgrade to keep chatting'/);
  }
});

test('referrals (2026-09-23): invite for Android members, code box for Android newcomers, nothing on iPhone', () => {
  const app = read('App.tsx');
  const client = read('src/billing/referral.ts');
  // Who sees what. The reward is a Stripe credit, and a free month outside
  // Apple's billing is a Guideline 3.1.1 risk, so both gates name Android.
  assert.match(app, /useReferral\(visible && Platform\.OS === 'android' && agentEngine && productView\.hasActiveSubscription\)/);
  assert.match(app, /const inviteBoxAvailable = Platform\.OS === 'android' && agentEngine && !productView\.hasActiveSubscription;/);
  assert.match(app, /\{referral \? \([\s\S]*?testID="menu\.inviteRow"[\s\S]*?Share\.share\(\{ message: referral\.shareText \}\)/);
  assert.match(app, /\{inviteBoxAvailable \? \([\s\S]*?testID="paywall\.inviteCodeInput"[\s\S]*?testID="paywall\.inviteCodeApply"/);
  // The plan screen returns early for builds that may not sell; its hooks must
  // stay above that return or the hook count changes between renders.
  const wizard = app.slice(app.indexOf('function SetupWizardScreen('), app.indexOf('function MenuDrawer('));
  assert.ok(wizard.indexOf('const [inviteCode, setInviteCode] = useState') < wizard.indexOf('if (!canShowPurchaseUi())'), 'invite hooks above the early return');
  assert.match(client, /'\/api\/referral'/);
  assert.match(client, /'\/api\/referral\/redeem'/);
});
