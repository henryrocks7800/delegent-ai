// What a surface says, above everything else, when the workspace behind the
// chat is not simply working.
//
// The rule this file exists to enforce: if the reader cannot tell from the
// screen that something is wrong, the screen has to tell them. A chat with a
// live composer and a blinking cursor is a promise, and these states cannot
// keep it. The phone had a chip for them and a wait notice for one; the web app
// had neither, so the same account in the same minute looked healthy in a
// browser and stuck on a phone.
//
// Only the states the surfaces do not already explain themselves belong here. A
// used-up month and a lapsed plan both disable the composer and say why, so
// repeating either above the chat would be the reader's second time reading it.
// A retained workspace is the one exception among the lapsed states: the
// composer explains why chat stopped and says nothing at all about the files,
// and "no active plan" on its own is the last thing someone worried about their
// files needs to read.

export type GateNoticeTone = 'accent' | 'warning' | 'danger';
export type ProvisioningSurface = 'app' | 'web';

export type GateNotice = {
  title: string;
  body: string;
  tone: GateNoticeTone;
};

export const PROVISIONING_NOTICE_TITLE = 'Your workspace is coming online';

// Cold provisioning is dominated by the golden image pull, which runs four to
// eight minutes cold and about one warm, so the copy quotes the upper bound
// rather than promising "setting up now" and being wrong for nine minutes.
export function provisioningNoticeBody(surface: ProvisioningSurface): string {
  // The only difference is what the reader would close. Telling a browser
  // reader to close the app is the kind of small wrongness that reads as
  // "this was not built for me".
  const leave = surface === 'web' ? 'close this tab' : 'close the app';
  return `This usually takes a few minutes, sometimes up to ten. You can ${leave} and come back, we'll keep going without you.`;
}

// The gates during which the workspace is still being built. Also the ones
// worth re-reading product state on a timer, since nothing pushes the change.
export const PROVISIONING_GATE_KINDS: readonly string[] = ['subscribed_pending_worker', 'provisioning_worker'];

export function isProvisioningGate(kind: string | null | undefined): boolean {
  return !!kind && PROVISIONING_GATE_KINDS.includes(kind);
}

// How long a workspace may sit in a provisioning gate before the surface stops
// promising it is on its way. Past the upper bound the notice above quotes, so
// reaching this means something is genuinely stuck rather than slow.
export const PROVISIONING_STALL_TIMEOUT_MS = 10 * 60 * 1000;

// Deliberately names no button: the phone's says "Retry" and the browser's says
// "Try again", and one sentence has to read correctly under both.
export const PROVISIONING_STALLED_MESSAGE =
  'Workspace setup is taking longer than expected. Try again, and contact support if it stays this way.';

export function gateNotice(
  gate: { kind: string; detail?: string | null } | null | undefined,
  surface: ProvisioningSurface,
): GateNotice | null {
  if (!gate) return null;

  if (isProvisioningGate(gate.kind)) {
    return { title: PROVISIONING_NOTICE_TITLE, body: provisioningNoticeBody(surface), tone: 'accent' };
  }

  // Stuck, not slow. The gate's own detail carries the operator's public status
  // message when there is one, which is the only place the real reason lives.
  if (gate.kind === 'error') {
    return {
      title: 'Your workspace needs attention',
      body: gate.detail ?? 'Something went wrong setting your workspace up. Contact support and we will look into it.',
      tone: 'danger',
    };
  }

  // The plan has lapsed but the workspace is still on disk. The composer says
  // "Subscribe to start chatting", which answers why chat stopped and leaves the
  // only question that actually worries a cancelled reader unanswered.
  if (gate.kind === 'workspace_retained') {
    return {
      title: 'Your files are still here',
      body: gate.detail ?? 'Files stay saved in your private workspace. Choose a plan to resume new chat and task work.',
      tone: 'warning',
    };
  }

  // Up and answering, but something underneath is unhappy. Worth saying before
  // the reader decides for themselves that the product is simply unreliable.
  if (gate.kind === 'degraded') {
    return {
      title: 'Your coworker is running with limits',
      body: gate.detail ?? 'Your coworker is online but something needs a check. Replies may be slower than usual.',
      tone: 'warning',
    };
  }

  return null;
}
