import type {CSSProperties,ReactNode} from 'react';
import {PlasmicResourceMonitorCardLayout} from './plasmic/PlasmicResourceMonitorCardLayout';

/** Only this adapter knows Plasmic's node bindings. Sampling and host actions
 * stay in Card, so a design sync cannot replace them with fixture data. */
export function ResourceCardFrame({header,alerts,list,footer,style}:{header:ReactNode;alerts:ReactNode;list:ReactNode;footer:ReactNode;style:CSSProperties}){
  return <PlasmicResourceMonitorCardLayout
    root={{className:'widget widget--card',style,'data-layout-source':'plasmic'}}
    header={{as:'div',props:{children:header}}}
    alerts={{as:'div',props:{children:alerts}}}
    list={{as:'div',props:{children:list,style:{display:'flex',flexDirection:'column'}}}}
    footer={{as:'div',props:{children:footer}}}
  />;
}
