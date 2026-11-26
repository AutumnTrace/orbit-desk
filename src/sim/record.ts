// Writes the recorded missions the browser demo plays: public/missions/<id>.odr.
//   npm run missions
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeRecording } from '../telemetry/recording.ts';
import { generateMission, MISSION_IDS } from './missions.ts';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'missions');
mkdirSync(out, { recursive: true });
for (const id of MISSION_IDS) {
  const { meta, records } = generateMission(id);
  const bytes = writeRecording(meta, records);
  writeFileSync(join(out, `${id}.odr`), bytes);
  console.log(`${id}.odr  ${records.length} records  ${bytes.length} bytes`);
}
