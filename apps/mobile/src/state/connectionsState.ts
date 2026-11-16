import type { GatewayConnection, GatewayId, GatewayStatus, SidekickProductSnapshot } from '@sidekick/shared';
import { sidekickProductState } from './productState';

export type MobileConnectionIcon = 'send' | 'message-circle' | 'lock' | 'mail' | 'radio';
export type MobileConnectionBadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

export type MobileConnection = GatewayConnection & {
  icon: MobileConnectionIcon;
  badgeTone: MobileConnectionBadgeTone;
  stateLabel: string;
  isPaused: boolean;
  canChooseInSetup: boolean;
  action: string;
};

const connectionIcons: Record<GatewayId, MobileConnectionIcon> = {
  telegram: 'send',
  whatsapp: 'message-circle',
  signal: 'lock',
  email: 'mail',
};

function badgeToneForStatus(status: GatewayStatus): MobileConnectionBadgeTone {
  if (status === 'live') return 'accent';
  if (status === 'testing') return 'warning';
  return 'neutral';
}

function stateLabelForStatus(status: GatewayStatus): string {
  if (status === 'live') return 'Connected';
  if (status === 'ready') return 'Ready to connect';
  if (status === 'testing') return 'Coming next';
  return 'Waiting';
}

export function toMobileConnection(connection: GatewayConnection): MobileConnection {
  return {
    ...connection,
    icon: connectionIcons[connection.id] ?? 'radio',
    badgeTone: badgeToneForStatus(connection.status),
    stateLabel: stateLabelForStatus(connection.status),
    isPaused: connection.status === 'paused',
    canChooseInSetup: connection.status === 'ready',
    action: connection.actionLabel,
  };
}

export function buildMobileConnections(snapshot: Pick<SidekickProductSnapshot, 'connections'>): readonly MobileConnection[] {
  return snapshot.connections
    .filter((connection) => connection.id !== 'email')
    .map(toMobileConnection);
}

export function resolveActiveMobileConnection(connections: readonly MobileConnection[]): MobileConnection | null {
  return connections.find((connection) => connection.status === 'live') ?? null;
}

export function resolvePrimaryMobileConnection(connections: readonly MobileConnection[]): MobileConnection | null {
  return connections.find((connection) => connection.status === 'live') ?? connections.find((connection) => connection.status === 'ready') ?? null;
}

export const mobileConnections: readonly MobileConnection[] = sidekickProductState.connections
  .filter((connection) => connection.id !== 'email')
  .map(toMobileConnection);
export const activeMobileConnection = mobileConnections.find((connection) => connection.status === 'live') ?? null;
export const primaryMobileConnection = mobileConnections.find((connection) => connection.status === 'live') ?? mobileConnections.find((connection) => connection.status === 'ready') ?? null;
