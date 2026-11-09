import type {Config,Sort} from './types';

export const cardSortOptions = [
  {value:'cpu',label:'CPU'},
  {value:'footprint',label:'活跃足迹'},
  {value:'memory',label:'RSS'},
  {value:'accounting',label:'系统归属记账'},
] as const;
export const cardLimits = [3,5,8,10] as const;

export function cardPreferences(config: Config = {}) {
  const sort = cardSortOptions.find(option=>option.value===config.sort)?.value??'cpu';
  return {
    sort,
    showFootprint: config.showFootprint ?? (sort === 'footprint'),
    showRss: config.showRss ?? (sort === 'memory'),
  };
}

export function sortCardBy(sort: Sort): Partial<Config> {
  return {sort,...(sort==='footprint'?{showFootprint:true}:sort==='memory'?{showRss:true}:{})};
}
