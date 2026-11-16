// The connected part of "your connected AI coworker": the apps it works in and
// the tools built into it, grouped exactly as the app's Connections screen
// groups them (AGENT_CONNECTION_CATEGORIES in packages/shared), so the site and
// the product list the same things.
//
// 2026-09-26 redesign: the real app logos (the same brand marks the app draws
// on its Connections cards) fly in from the edges as you scroll and settle
// into two slow orbits round the brain. Tapping a group lights up its apps.

import { useMemo, useState, type CSSProperties } from 'react';
import { AGENT_CONNECTION_CATEGORIES, AGENT_EVERYDAY_TOOLS, CONNECTABLE_SERVICES, agentConnectableServices } from '@sidekick/shared';
import { Reveal, SplitWords } from '../motion/Reveal';
import { useProgress } from '../motion/hooks';
import { hasFinePointer } from '../motion/scroll';

const APPS = agentConnectableServices();
const APP_COUNT = APPS.length;
const WITH_MARKS = APPS.filter((app) => app.brandMark);

function groupItems(services: readonly string[], builtIn: readonly string[]): string {
  const tools = builtIn.map((id) => AGENT_EVERYDAY_TOOLS.find((tool) => tool.id === id)?.title).filter(Boolean);
  const apps = services.map((id) => CONNECTABLE_SERVICES.find((service) => service.id === id)?.name).filter(Boolean);
  return [...tools, ...apps].join(', ');
}

// A stable pseudo-random scatter, so the fly-in looks organic but is the same
// on every load (and on the server-rendered snapshot the tests take).
function scatter(i: number) {
  const a = Math.sin(i * 12.9898) * 43758.5453;
  const b = Math.sin(i * 78.233) * 12345.6789;
  return { x: ((a - Math.floor(a)) * 2 - 1) * 420, y: ((b - Math.floor(b)) * 2 - 1) * 320 };
}

export function ConnectedApps() {
  // A tap pins a group; a mouse hover previews one. Kept apart because a tap on
  // a phone fires a synthetic hover AND a click, which would switch it on and
  // straight back off.
  const [pinned, setPinned] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const fine = useMemo(() => hasFinePointer(), []);
  const active = hovered ?? pinned;
  const stageRef = useProgress<HTMLDivElement>('enter');

  const activeIds = useMemo(() => {
    const cat = AGENT_CONNECTION_CATEGORIES.find((c) => c.key === active);
    return cat ? new Set<string>(cat.services) : null;
  }, [active]);

  const inner = WITH_MARKS.slice(0, 12);
  const outer = WITH_MARKS.slice(12);

  return (
    <section id="connected" className="relative overflow-hidden">
      <div className="container-page py-24 md:py-32">
        <div className="grid items-center gap-14 md:grid-cols-12 md:gap-12">
          <div className="md:col-span-5">
            <Reveal>
              <p className="eyebrow mb-4">Connected</p>
            </Reveal>
            <h2 className="section-title">
              <SplitWords text={`${APP_COUNT} apps,`} className="brand-serif" />{' '}
              <SplitWords text="one coworker, and tools built in." start={2} />
            </h2>
            <Reveal delay={2}>
              <p className="mt-6 text-body-lg text-ink-muted max-w-prose">
                Connect the apps you already use and your coworker works in them. Flights, hotels, the news, the
                weather and live web search are built in, with nothing to set up.
              </p>
            </Reveal>
            <Reveal delay={3}>
              <p className="mt-5 text-[13.5px] text-ink-muted max-w-prose">
                You sign in on each app&apos;s own website, so we never see your password. Connections are held
                encrypted by our broker, Composio, and you can disconnect any app at any time. Anything that sends,
                posts, deletes or spends comes back to you for review first.
              </p>
            </Reveal>

            <Reveal delay={4}>
              <p className="mt-8 text-[12.5px] text-ink-faint">Tap a group to light up its apps</p>
              <ul className="mt-3 flex flex-wrap gap-2">
                {AGENT_CONNECTION_CATEGORIES.map((category) => {
                  const on = active === category.key;
                  return (
                    <li key={category.key}>
                      <button
                        type="button"
                        onClick={() => setPinned((current) => (current === category.key ? null : category.key))}
                        onMouseEnter={fine ? () => setHovered(category.key) : undefined}
                        onMouseLeave={fine ? () => setHovered(null) : undefined}
                        aria-pressed={pinned === category.key}
                        title={groupItems(category.services, category.builtIn)}
                        className={`inline-flex items-center gap-2 rounded-pill px-3 py-1.5 text-[13px] ring-1 transition duration-300 ease-quiet ${
                          on ? 'bg-sage text-white ring-sage shadow-quiet' : 'bg-white/80 text-ink ring-divider hover:ring-sage/40'
                        }`}
                      >
                        <span aria-hidden>{category.emoji}</span>
                        {category.title}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </Reveal>
          </div>

          <div className="md:col-span-7">
            <div ref={stageRef} className="relative mx-auto aspect-square w-full max-w-[540px]" aria-hidden>
              <div className="absolute inset-[6%] rounded-full ring-1 ring-divider" />
              <div className="absolute inset-[21%] rounded-full ring-1 ring-divider/80" />
              <div className="absolute inset-[34%] rounded-full bg-[radial-gradient(closest-side,rgba(79,97,82,0.18),transparent)]" />

              <div className="absolute inset-[37%] flex items-center justify-center rounded-full bg-white shadow-lift ring-1 ring-divider">
                <img src="/brand-mark-384.webp" alt="" width={192} height={192} className="h-[72%] w-[72%] object-contain" />
              </div>

              <Ring apps={inner} radius={29} spin="orbit-reverse" activeIds={activeIds} offset={0} />
              <Ring apps={outer} radius={44} spin="orbit" activeIds={activeIds} offset={inner.length} />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function Ring({
  apps,
  radius,
  spin,
  activeIds,
  offset,
}: {
  apps: typeof WITH_MARKS;
  radius: number;
  spin: 'orbit' | 'orbit-reverse';
  activeIds: Set<string> | null;
  offset: number;
}) {
  return (
    <div className={`absolute inset-0 ${spin}`}>
      {apps.map((app, i) => {
        const angle = (i / apps.length) * Math.PI * 2 - Math.PI / 2;
        const left = 50 + radius * Math.cos(angle);
        const top = 50 + radius * Math.sin(angle);
        const { x, y } = scatter(offset + i);
        const dim = activeIds && !activeIds.has(app.id);
        const lit = activeIds && activeIds.has(app.id);
        return (
          <div key={app.id} className="absolute" style={{ left: `${left}%`, top: `${top}%` }}>
            <div className="orbit-slot" style={{ '--sx': `${x}px`, '--sy': `${y}px` } as CSSProperties}>
              <div className="orbit-upright">
                <div
                  title={app.name}
                  className={`flex h-9 w-9 items-center justify-center rounded-xl bg-white shadow-quiet ring-1 transition duration-500 ease-quiet md:h-11 md:w-11 ${
                    lit ? 'scale-125 ring-sage shadow-lift' : 'ring-divider'
                  } ${dim ? 'opacity-25 scale-90' : ''}`}
                >
                  {app.brandMark ? (
                    <svg viewBox={app.brandMark.viewBox} className="h-[52%] w-[52%]" aria-hidden>
                      <path d={app.brandMark.path} fill={app.brandMark.color} />
                    </svg>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
