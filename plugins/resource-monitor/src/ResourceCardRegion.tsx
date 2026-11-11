import type {HTMLAttributes} from 'react';

// Binding boundary for generated imports. The application supplies live content
// through ResourceCardFrame; fixture-only Plasmic regions never enter its bundle.
export default function ResourceCardRegion(props:HTMLAttributes<HTMLDivElement>){return <div {...props}/>;}
