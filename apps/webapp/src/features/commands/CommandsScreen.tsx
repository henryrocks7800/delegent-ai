import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DELEGENT_CHAT_COMMANDS, type ChatCommand, type ChatCommandOption } from '@sidekick/shared';
import { Screen } from '../../components/ui';
import { queueChatCommand } from '../chat/pendingChatCommand';

// The web half of the phone's ☰ menu "Commands" area, from the same shared
// catalogue. Running one parks it and sends the reader to Chat, where it plays
// once the conversation has loaded, which is the same place the phone lands.

export function CommandsScreen() {
  const navigate = useNavigate();
  const [expandedKey, setExpandedKey] = useState<string | null>(DELEGENT_CHAT_COMMANDS[0]?.key ?? null);

  function run(command: ChatCommand, option?: ChatCommandOption) {
    if (command.key === 'fresh-chat') queueChatCommand({ kind: 'fresh' });
    else if (option) queueChatCommand({ kind: 'run', command: option.instruction, mode: 'send' });
    else queueChatCommand({ kind: 'run', command: command.command, mode: command.mode });
    navigate('/chat');
  }

  return (
    <Screen title="Commands" subtitle="Quick actions you can run any time.">
      <p className="mb-4 text-body-sm text-textSecondary">
        Open one to see what it does, then run it. Some, like a fresh chat, keep your coworker quick and easy on your
        monthly allowance.
      </p>

      {DELEGENT_CHAT_COMMANDS.map((command) => (
        <CommandCard
          key={command.key}
          command={command}
          expanded={expandedKey === command.key}
          onToggle={() => setExpandedKey((prev) => (prev === command.key ? null : command.key))}
          onRun={(option) => run(command, option)}
        />
      ))}
    </Screen>
  );
}

function CommandCard({
  command,
  expanded,
  onToggle,
  onRun,
}: {
  command: ChatCommand;
  expanded: boolean;
  onToggle: () => void;
  onRun: (option?: ChatCommandOption) => void;
}) {
  const panelId = `command-panel-${command.key}`;

  return (
    <article className="card mb-3 overflow-hidden">
      <button
        type="button"
        className="flex w-full items-center gap-3 p-4 text-left hover:bg-bg"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={panelId}
      >
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-accentMuted text-2xl" aria-hidden="true">
          {command.emoji}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-body font-medium text-textPrimary">{command.name}</span>
          <span className="mt-0.5 block text-body-sm text-textSecondary">{command.short}</span>
        </span>
        <span aria-hidden="true" className={`shrink-0 text-textSecondary transition-transform ${expanded ? 'rotate-180' : ''}`}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </span>
      </button>

      {expanded ? (
        <div id={panelId} className="border-t border-border p-4">
          <p className="text-body-sm text-textSecondary">{command.why}</p>

          {command.options ? (
            <div className="mt-4 flex flex-wrap gap-2">
              {command.options.map((option) => (
                <button key={option.key} type="button" className="chip-off" onClick={() => onRun(option)}>
                  {option.label}
                </button>
              ))}
            </div>
          ) : (
            <button type="button" className="btn-primary mt-4 w-full" onClick={() => onRun()}>
              {command.actionLabel}
            </button>
          )}
        </div>
      ) : null}
    </article>
  );
}
