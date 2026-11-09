import {bytes} from './model';
import type {RankingSnapshot} from './types';

const windowMs = 5 * 60 * 1000;
const sampleMs = 5000;

export interface FootprintSample {
  at: number;
  groups: ReadonlyMap<string, number>;
}

export function recordFootprints(history: FootprintSample[], snapshot: RankingSnapshot) {
  if (!snapshot.at || snapshot.error || snapshot.stale) return;
  const last = history.at(-1);
  if (last && snapshot.at <= last.at) return;
  while (history[0] && history[0].at < snapshot.at - windowMs) history.shift();
  const groups = new Map<string, number>();
  for (const group of snapshot.groups) {
    if (!group.footprintIncomplete && group.footprint != null) groups.set(group.id, group.footprint);
  }
  if (last && Math.floor(last.at / sampleMs) === Math.floor(snapshot.at / sampleMs)) history.pop();
  history.push({at: snapshot.at, groups});
}

export function FootprintTrend({history, groupId}: {history: readonly FootprintSample[]; groupId: string}) {
  const end = history.at(-1)?.at ?? 0;
  const points = history.map(sample => ({at: sample.at, value: sample.groups.get(groupId)}));
  const values = points.flatMap(point => point.value == null ? [] : [point.value]);
  const ceiling = Math.max(1, ...values);
  const floor = Math.min(...values, ceiling * 0.75);
  let previousAt: number | undefined;
  const path = points.map(({at, value}) => {
    if (value == null) {
      previousAt = undefined;
      return '';
    }
    const command = previousAt !== undefined && at - previousAt <= sampleMs * 2 ? 'L' : 'M';
    previousAt = at;
    const x = 400 * (1 - (end - at) / windowMs);
    const y = 58 - 52 * (value - floor) / (ceiling - floor);
    return `${command}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  return <figure className="footprint-trend">
    <figcaption className="flex flex-wrap items-baseline justify-between gap-2">
      <strong>应用活跃足迹</strong><span className="muted text-xs">最近 5 分钟</span>
    </figcaption>
    {!path.includes('L') ? <p className="muted text-xs py-3">正在积累连续采样</p> : <>
      <div className="footprint-trend-plot">
        <div className="muted text-xs flex flex-col justify-between" aria-hidden="true"><span>{bytes(ceiling)}</span><span>{bytes(floor)}</span></div>
        <svg viewBox="0 0 400 64" preserveAspectRatio="none" role="img" aria-label={`应用活跃足迹趋势，最近记录 ${bytes(values.at(-1))}`}>
          <line x1="0" x2="400" y1="6" y2="6"/><line x1="0" x2="400" y1="58" y2="58"/>
          <path d={path}/>
        </svg>
      </div>
      <div className="footprint-trend-time muted text-xs flex justify-between"><span>5 分钟前</span><span>最近采样</span></div>
    </>}
  </figure>;
}
