import keywordsYaml from '../../../spec/keywords.yaml?raw'
import { parseSchema, type Schema } from './schema'

/** The keyword schema this build ships with (`spec/keywords.yaml`, see `just sync-spec`). */
export const ITEM_SCHEMA: Schema = parseSchema(keywordsYaml)
