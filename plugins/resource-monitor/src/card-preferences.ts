import type {Config} from './types';

export const cardSortOptions = [
  {value:'cpu',label:'CPU'},
  {value:'footprint',label:'活跃足迹'},
  {value:'memory',label:'RSS'},
  {value:'accounting',label:'系统归属记账'},
] as const;
export const cardLimits = [3,5,8,10] as const;
export const cardMetricFields = {footprint:'showFootprint',memory:'showRss',accounting:'showAccounting'} as const;

export function cardPreferences(config: Config = {}) {
  const savedSort = cardSortOptions.find(option=>option.value===config.sort)?.value??'cpu';
  const sort = savedSort!=='cpu'&&config[cardMetricFields[savedSort]]===false?'cpu':savedSort;
  return {
    sort,
    showFootprint: config.showFootprint ?? (sort === 'footprint'),
    showRss: config.showRss ?? (sort === 'memory'),
    showAccounting: config.showAccounting ?? (sort === 'accounting'),
  };
}

export function cardRowLimit(limit: number | undefined) {
  return typeof limit==='number'&&Number.isFinite(limit)?Math.max(3,Math.min(10,Math.floor(limit))):5;
}

export function cardLimitOptions(limit: number) {
  return [...new Set([...cardLimits,limit])].sort((a,b)=>a-b);
}
