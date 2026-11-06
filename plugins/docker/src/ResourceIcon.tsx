import type {Scope} from './api';

export function ResourceIcon({kind}:{kind:Scope}) {
  return <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind==='volumes'?<><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/></>:kind==='networks'?<><rect x="9" y="3" width="6" height="5" rx="1"/><rect x="2" y="16" width="6" height="5" rx="1"/><rect x="16" y="16" width="6" height="5" rx="1"/><path d="M12 8v4M5 16v-4h14v4"/></>:kind==='images'?<><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m4 18 5-5 3 3 4-5 5 7"/></>:kind==='compose'?<>{[4,14].flatMap(x=>[4,14].map(y=><rect key={x+':'+y} x={x} y={y} width="6" height="6" rx="1"/>))}</>:kind==='settings'?<><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2"/></>:<><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M4 10h16M9 10v10"/></>}
  </svg>;
}
