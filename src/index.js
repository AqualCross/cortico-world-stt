/**
 * 扩展入口：默认导出必须是 WorldDefinition。
 * `cortico.kind = world`、`api = 5` 与 `keywords` 里的 `cortico-world` 见 package.json。
 */
import definition, { sttDefinition } from './definition.js';

export default definition;
export { sttDefinition };
export { SttWorld } from './world.js';
export { ID as STT_WORLD_ID, DEFAULTS as STT_DEFAULTS } from './config.js';
