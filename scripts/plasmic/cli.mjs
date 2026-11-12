import {fileURLToPath} from 'node:url';
import {runLayoutCli} from './layout-engine.mjs';
const id=process.argv[2];
if(!['resource-monitor','twofa','device-center','docker','machines','social-hub'].includes(id))throw Error('Specify a supported plugin ID.');
runLayoutCli(fileURLToPath(new URL(`../../plugins/${id}/`,import.meta.url)),process.argv.slice(3)).then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error.message);process.exitCode=1;});
