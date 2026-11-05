import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'vite';

const root=fileURLToPath(new URL('..',import.meta.url));

// Rollup cannot split multiple entries into IIFEs. Build self-contained scripts
// sequentially in one directory, without dynamic imports or a runtime loader.
export async function buildUi({outDir=resolve(root,'build/ui/react'),logLevel='info'}={}) {
  const outputs=[];
  for(const mode of ['production','card']) {
    const result=await build({configFile:resolve(root,'vite.config.mjs'),mode,logLevel,build:{outDir}});
    outputs.push(...(Array.isArray(result)?result:[result]));
  }
  return outputs;
}

if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2);
  if(args.length&&(args.length!==2||args[0]!=='--out-dir'))throw Error('Usage: node scripts/build-ui.mjs [--out-dir <directory>]');
  await buildUi(args.length?{outDir:resolve(args[1])}:{});
}
