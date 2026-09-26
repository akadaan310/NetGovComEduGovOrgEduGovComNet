/** npm run schemas — regenerate schemas/*.schema.json from src/protocol/schemas.ts (a test checks they are in sync). */
import { writeFileSync } from 'node:fs';
import { jsonSchemaOf, PUBLISHED_SCHEMAS, type SchemaName } from '../src/protocol/schemas';

for (const name of Object.keys(PUBLISHED_SCHEMAS) as SchemaName[]) {
  writeFileSync(`schemas/${name}.schema.json`, JSON.stringify(jsonSchemaOf(name), null, 2) + '\n');
  console.log(`schemas/${name}.schema.json`);
}
