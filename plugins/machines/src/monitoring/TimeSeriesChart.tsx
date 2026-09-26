import { useMemo, useState, type PointerEvent } from 'react';
import './time-series-chart.css';

type Row = readonly (number | null)[];

interface Props {
  rows: readonly Row[];
  series: readonly string[];
  unit?: string;
  colors?: readonly string[];
  label: string;
}

const WIDTH = 760;
const HEIGHT = 240;
const LEFT = 48;
const RIGHT = 18;
const TOP = 20;
const BOTTOM = 204;
const DEFAULT_COLORS = ['#69b7e8', '#e9a05d', '#8dcc9b', '#d394ca'];

function nearestSample(rows: readonly Row[], time: number): number {
  let low = 0, high = rows.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((rows[middle][0] as number) < time) low = middle + 1;
    else high = middle;
  }
  return low > 0 && Math.abs((rows[low - 1][0] as number) - time) < Math.abs((rows[low][0] as number) - time) ? low - 1 : low;
}

export function TimeSeriesChart({ rows, series, unit = '', colors = DEFAULT_COLORS, label }: Props) {
  const [cursor, setCursor] = useState<number | null>(null);
  const samples = useMemo(() => rows
    .filter((row) => Number.isFinite(row[0]))
    .slice()
    .sort((a, b) => (a[0] as number) - (b[0] as number)), [rows]);
  const valid = samples.filter((row) => row.slice(1).some((value) => Number.isFinite(value)));
  if (!valid.length) return <div className="fh-time-series__empty" role="status">此范围没有历史采样</div>;

  const first = samples[0][0] as number;
  const last = samples.at(-1)![0] as number;
  const values = samples.flatMap((row) => row.slice(1)).filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const min = Math.min(0, ...values);
  const max = Math.max(1, ...values);
  const x = (time: number) => LEFT + (time - first) / (last - first || 1) * (WIDTH - LEFT - RIGHT);
  const y = (value: number) => BOTTOM - (value - min) / (max - min || 1) * (BOTTOM - TOP);
  const selected = cursor === null ? null : valid[Math.min(cursor, valid.length - 1)];
  const selectedX = selected ? x(selected[0] as number) : null;
  const primary = selected?.slice(1).find((value): value is number => typeof value === 'number' && Number.isFinite(value));

  function move(event: PointerEvent<SVGSVGElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const position = Math.max(LEFT, Math.min(WIDTH - RIGHT, (event.clientX - bounds.left) / bounds.width * WIDTH));
    const time = first + (position - LEFT) / (WIDTH - LEFT - RIGHT) * (last - first);
    setCursor(nearestSample(valid, time));
  }

  return <div className="fh-time-series">
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" tabIndex={0} aria-label={`${label}，悬浮或使用左右方向键查看采样数值`} onPointerMove={move} onPointerLeave={() => setCursor(null)} onFocus={() => setCursor((current) => current ?? valid.length - 1)} onBlur={() => setCursor(null)} onKeyDown={(event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      setCursor((current) => Math.max(0, Math.min(valid.length - 1, (current ?? valid.length - 1) + (event.key === 'ArrowRight' ? 1 : -1))));
    }}>
      {[0, 1, 2, 3, 4].map((step) => <g key={step} className="fh-time-series__grid"><line x1={LEFT} x2={WIDTH - RIGHT} y1={TOP + step * (BOTTOM - TOP) / 4} y2={TOP + step * (BOTTOM - TOP) / 4} /><text x="4" y={TOP + step * (BOTTOM - TOP) / 4 + 4}>{(max - (max - min) * step / 4).toFixed(1)}</text></g>)}
      {series.map((name, index) => {
        let path = '', pen = false;
        for (const row of samples) {
          const value = row[index + 1];
          if (!Number.isFinite(value)) { pen = false; continue; }
          path += `${pen ? 'L' : 'M'}${x(row[0] as number).toFixed(1)},${y(value as number).toFixed(1)} `;
          pen = true;
        }
        return <path key={name} d={path} stroke={colors[index % colors.length]} />;
      })}
      {selected && selectedX !== null ? <g className="fh-time-series__cursor">
        <line x1={selectedX} x2={selectedX} y1={TOP} y2={BOTTOM} />
        {primary !== undefined ? <line x1={LEFT} x2={WIDTH - RIGHT} y1={y(primary)} y2={y(primary)} /> : null}
        {series.map((name, index) => Number.isFinite(selected[index + 1]) ? <circle key={name} cx={selectedX} cy={y(selected[index + 1] as number)} r="4" fill={colors[index % colors.length]} /> : null)}
      </g> : null}
      <text x={LEFT} y="231">{new Date(first * 1000).toLocaleString()}</text>
      <text x={WIDTH - RIGHT} y="231" textAnchor="end">{new Date(last * 1000).toLocaleString()}</text>
    </svg>
    {selected && selectedX !== null ? <div className="fh-time-series__tooltip" style={{ left: `clamp(80px, ${selectedX / WIDTH * 100}%, calc(100% - 80px))` }}>
      <time>{new Date((selected[0] as number) * 1000).toLocaleString()}</time>
      {series.map((name, index) => <div key={name}><i style={{ background: colors[index % colors.length] }} /><span>{name}</span><strong>{Number.isFinite(selected[index + 1]) ? (selected[index + 1] as number).toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : '—'} {unit}</strong></div>)}
    </div> : null}
  </div>;
}
