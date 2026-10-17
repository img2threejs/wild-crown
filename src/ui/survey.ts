import type { AreaMapPoint, AreaMapViewModel, GameViewModel, QuestLogEntry, QuestLogViewModel } from '../game/contracts.js';
import { icon, type IconName } from './icons.js';
import { button, esc } from './markup.js';

type Marker = AreaMapViewModel['markers'][number];
type Step = QuestLogEntry['objectives'][number];

const STATE_LABEL: Record<Step['state'], string> = { done: 'Done', current: 'Now', active: 'Open', upcoming: 'Later' };

/** Nearest point on a trail segment, so the route can join the authored trails where the player actually stands. */
function closestOnSegment(p: AreaMapPoint, a: AreaMapPoint, b: AreaMapPoint): AreaMapPoint {
  const du = b.u - a.u, dv = b.v - a.v, len = du * du + dv * dv;
  const t = len ? Math.max(0, Math.min(1, ((p.u - a.u) * du + (p.v - a.v) * dv) / len)) : 0;
  return { u: a.u + du * t, v: a.v + dv * t };
}
const dist = (a: AreaMapPoint, b: AreaMapPoint) => Math.hypot(a.u - b.u, a.v - b.v);
const key = (p: AreaMapPoint) => p.u.toFixed(2) + ',' + p.v.toFixed(2);

/**
 * The overprinted route from Aren to the current objective along the region's own trails (Dijkstra over the trail graph,
 * entering and leaving it at the closest trail points). Falls back to the straight bearing when the trails do not connect.
 */
export function surveyRoute(map: AreaMapViewModel): AreaMapPoint[] {
  const goal = map.markers.find(marker => marker.kind === 'current');
  if (!map.player || !goal) return [];
  const start = map.player, end = goal.at;
  const nodes = new Map<string, AreaMapPoint>();
  const edges = new Map<string, { to: string; w: number }[]>();
  const link = (a: AreaMapPoint, b: AreaMapPoint) => {
    const ka = key(a), kb = key(b);
    nodes.set(ka, a); nodes.set(kb, b);
    const w = dist(a, b);
    (edges.get(ka) ?? edges.set(ka, []).get(ka)!).push({ to: kb, w });
    (edges.get(kb) ?? edges.set(kb, []).get(kb)!).push({ to: ka, w });
  };
  for (const [a, b] of map.paths) link(a, b);
  const attach = (p: AreaMapPoint): AreaMapPoint | null => {
    let best: { at: AreaMapPoint; a: AreaMapPoint; b: AreaMapPoint } | null = null;
    for (const [a, b] of map.paths) {
      const at = closestOnSegment(p, a, b);
      if (!best || dist(p, at) < dist(p, best.at)) best = { at, a, b };
    }
    if (!best) return null;
    link(best.at, best.a); link(best.at, best.b);
    return best.at;
  };
  const entry = attach(start), exit = attach(end);
  if (!entry || !exit) return [start, end];
  const costs = new Map<string, number>([[key(entry), 0]]);
  const previous = new Map<string, string>();
  const open = new Set<string>([key(entry)]);
  while (open.size) {
    let current = '';
    for (const id of open) if (!current || costs.get(id)! < costs.get(current)!) current = id;
    open.delete(current);
    if (current === key(exit)) break;
    for (const edge of edges.get(current) ?? []) {
      const next = costs.get(current)! + edge.w;
      if (next < (costs.get(edge.to) ?? Infinity)) { costs.set(edge.to, next); previous.set(edge.to, current); open.add(edge.to); }
    }
  }
  if (!costs.has(key(exit))) return [start, end];
  const trail: AreaMapPoint[] = [];
  for (let id: string | undefined = key(exit); id; id = previous.get(id)) trail.unshift(nodes.get(id)!);
  return [start, ...trail, end];
}

/** Top-down survey sheet of the current region: tinted ground, trails, lettered grid, markers and the route overprint. */
export function areaMapMarkup(map: AreaMapViewModel): string {
  const { minU, maxU, minV, maxV } = map.bounds;
  const width = maxU - minU, height = maxV - minV;
  const x = (p: AreaMapPoint) => (p.u - minU).toFixed(2), y = (p: AreaMapPoint) => (maxV - p.v).toFixed(2);
  const pct = (p: AreaMapPoint) => `left:${((p.u - minU) / width * 100).toFixed(2)}%;top:${((maxV - p.v) / height * 100).toFixed(2)}%`;
  // Bounds are snapped to whole squares upstream (ChapterFlow.areaMapOf); round away float drift.
  const columns = Math.max(1, Math.round(width / map.gridStep)), rows = Math.max(1, Math.round(height / map.gridStep));
  const grid = [
    ...Array.from({ length: columns + 1 }, (_, i) => `<line x1="${i * map.gridStep}" y1="0" x2="${i * map.gridStep}" y2="${height.toFixed(2)}"/>`),
    ...Array.from({ length: rows + 1 }, (_, i) => `<line x1="0" y1="${i * map.gridStep}" x2="${width.toFixed(2)}" y2="${i * map.gridStep}"/>`),
  ].join('');
  const colLabels = Array.from({ length: columns }, (_, i) => `<span style="left:${((i + .5) * map.gridStep / width * 100).toFixed(2)}%">${String.fromCharCode(65 + Math.min(25, i))}</span>`).join('');
  const rowLabels = Array.from({ length: rows }, (_, i) => `<span style="top:${((i + .5) * map.gridStep / height * 100).toFixed(2)}%">${i + 1}</span>`).join('');
  const surfaces = map.surfaces.map(surface => `<polygon class="${surface.water ? 'wc-areamap__water' : 'wc-areamap__land'}" points="${surface.points.map(p => x(p) + ',' + y(p)).join(' ')}"/>`).join('');
  const trails = map.paths.map(([a, b]) => `<line x1="${x(a)}" y1="${y(a)}" x2="${x(b)}" y2="${y(b)}"/>`).join('');
  const route = surveyRoute(map);
  const routeMarkup = route.length > 1 ? `<polyline class="wc-areamap__route" pathLength="1" points="${route.map(p => x(p) + ',' + y(p)).join(' ')}"/>` : '';
  const markerIcon: Record<Marker['kind'], IconName> = { current: 'pin', objective: 'pin', exit: 'exit' };
  const markers = map.markers.map(marker => `<div class="wc-areamap__marker" data-marker="${esc(marker.id)}" data-kind="${marker.kind}" data-available="${marker.available}" data-flip="${(marker.at.u - minU) / width > .55}" style="${pct(marker.at)}">${icon(marker.kind === 'exit' && !marker.available ? 'lock' : markerIcon[marker.kind])}<span><strong>${esc(marker.label)}</strong><small>${esc(marker.grid)}${marker.kind === 'exit' && marker.detail ? ' · ' + esc(marker.detail) : ''}</small></span></div>`).join('');
  const player = map.player ? `<div class="wc-areamap__player" style="${pct(map.player)}" aria-label="You are here, grid ${esc(map.player.grid)}"><span style="transform:rotate(${map.player.headingDegrees.toFixed(1)}deg)">${icon('heading')}</span></div>` : '';
  return `<div class="wc-areamap" role="img" aria-label="Area map of ${esc(map.regionName)}${map.player ? ', you are in grid ' + esc(map.player.grid) : ''}">
    <div class="wc-areamap__sheet" style="--ratio:${(width / height).toFixed(4)}">
      <div class="wc-areamap__cols" aria-hidden="true">${colLabels}</div><div class="wc-areamap__rows" aria-hidden="true">${rowLabels}</div>
      <svg viewBox="0 0 ${width.toFixed(2)} ${height.toFixed(2)}" preserveAspectRatio="none" aria-hidden="true"><g class="wc-areamap__ground">${surfaces}</g><g class="wc-areamap__grid">${grid}</g><g class="wc-areamap__trails">${trails}</g>${routeMarkup}</svg>
      ${markers}${player}
    </div>
  </div>`;
}

/** The legend printed under the sheet, drawn with the same marks the map uses. */
export function areaLegendMarkup(map: AreaMapViewModel): string {
  return `<ul class="wc-legend" aria-label="Map legend"><li data-kind="player">${icon('heading')}You</li><li data-kind="current">${icon('pin')}Current objective</li><li data-kind="objective">${icon('pin')}Other objective</li><li data-kind="exit">${icon('exit')}Exit</li><li data-kind="route"><i></i>Route</li><li data-kind="trail"><i></i>Trail</li><li>Grid ${map.gridStep} m</li></ul>`;
}

/** Grid code of an objective on the current area map, when it resolves in this region. */
export const gridOf = (map: AreaMapViewModel | undefined, objectiveId: string): string | null =>
  map?.markers.find(marker => marker.id === objectiveId)?.grid ?? null;

/** One quest's steps with line-form state: struck when done, solid route when current, dashed when it comes later. */
export function questStepsMarkup(entry: QuestLogEntry, map: AreaMapViewModel | undefined, tracked: string | null, trackable: boolean): string {
  return `<ol class="wc-steps">${entry.objectives.map(step => {
    const grid = gridOf(map, step.id);
    const canTrack = trackable && step.state === 'active';
    return `<li class="wc-step" data-state="${step.state}" data-locate="${esc(step.id)}"><span class="wc-step__mark" aria-hidden="true">${step.state === 'done' ? icon('check') : ''}</span><span class="wc-step__text"><span class="wc-step__title">${esc(step.title)}${step.optional ? ' <em>Optional</em>' : ''}</span>${step.state === 'current' ? `<span class="wc-step__how">${esc(step.description)}</span>` : ''}</span><span class="wc-step__meta"><span class="wc-sr">${STATE_LABEL[step.state]}</span>${grid ? `<span class="wc-grid-ref">${esc(grid)}</span>` : ''}${canTrack ? button(`${tracked === step.id ? 'Tracked' : 'Track'}<span class="wc-sr"> ${esc(step.title)}</span>`, 'track-objective', `data-objective="${esc(step.id)}" aria-pressed="${tracked === step.id}"`, 'wc-action--small') : ''}</span></li>`;
  }).join('')}</ol>`;
}

/** The first thing every menu shows: the quest, the objective in large type, how to do it, its grid square and distance. */
export function currentObjectiveMarkup(log: QuestLogViewModel | undefined, map: AreaMapViewModel | undefined): string {
  const quest = log?.active.find(entry => entry.id === log.currentQuestId);
  const step = quest?.objectives.find(item => item.id === log?.currentObjectiveId);
  if (!quest || !step) return `<section class="wc-current" aria-label="Current objective"><h2 class="wc-current__title">No objective right now</h2><p class="wc-lore">Explore freely; new paths appear as the story moves.</p></section>`;
  const required = quest.objectives.filter(item => !item.optional);
  const index = required.findIndex(item => item.id === step.id);
  const marker = map?.markers.find(item => item.id === step.id);
  const distance = map?.player && marker ? Math.round(dist(map.player, marker.at)) : null;
  return `<section class="wc-current" aria-label="Current objective">
    <p class="wc-current__quest">${esc(quest.title)}${index >= 0 ? ` <span>Step ${index + 1} of ${required.length}</span>` : ''}</p>
    <h2 class="wc-current__title">${esc(step.title)}</h2>
    <p class="wc-lore">${esc(step.description)}</p>
    ${marker ? `<dl class="wc-current__facts"><div><dt>Grid</dt><dd><span class="wc-grid-ref">${esc(marker.grid)}</span></dd></div>${distance !== null ? `<div><dt>Distance</dt><dd>${distance} m</dd></div>` : ''}</dl>` : ''}
  </section>`;
}

/** Exits of the region: open routes, or the exact objective that opens a locked one. */
export function exitsMarkup(act: GameViewModel['chapterAct']): string {
  if (!act?.exits.length) return '';
  return `<section class="wc-exits" aria-label="Exits from this region"><h3>Exits</h3><ul>${act.exits.map(exit => `<li data-available="${exit.available}">${icon(exit.available ? 'exit' : 'lock')}<span><strong>${esc(exit.label)}</strong><small>${esc(exit.available ? 'Open' : exit.reason ?? 'Unavailable')}</small></span></li>`).join('')}</ul>${act.actTwoNotice ? `<p class="wc-lore">${esc(act.actTwoNotice)}</p>` : ''}</section>`;
}
