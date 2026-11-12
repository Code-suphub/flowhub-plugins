import {defineConfig,mergeConfig} from 'vite';
import ordinary from './vite.config.mjs';
import {layoutDevPlugin} from '../../scripts/plasmic/layout-engine.mjs';
export default defineConfig(env=>mergeConfig(typeof ordinary==='function'?ordinary(env):ordinary,{plugins:[layoutDevPlugin({root:import.meta.dirname})]}));
