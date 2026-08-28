// Controleert de opgehaalde gegevens voordat de site wordt gepubliceerd.
// Bij een fout gaat de publicatie niet door en blijft de vorige versie staan.

import { readFile } from 'node:fs/promises';

const lees = async (naam) => JSON.parse(await readFile(new URL(`../site/data/${naam}`, import.meta.url), 'utf8'));

const meta = await lees('meta.json');
const stations = await lees('stations.json');
const reeksen = await lees('reeksen.json');
const netwerk = await lees('netwerk.json');

const fouten = [];
const eis = (voorwaarde, bericht) => { if (!voorwaarde) fouten.push(bericht); };

eis(stations.length >= 50, `te weinig meetpunten: ${stations.length}`);
eis(Date.now() - new Date(meta.gegenereerd) < 3600e3, 'de momentopname is ouder dan een uur');

const zonderReeks = stations.filter((s) => !reeksen[s.c]).length;
eis(zonderReeks === 0, `${zonderReeks} meetpunten zonder reeks`);

const buitenNederland = stations.filter((s) => s.lat < 50 || s.lat > 54 || s.lon < 2.5 || s.lon > 7.5);
eis(buitenNederland.length === 0, `meetpunten buiten Nederland: ${buitenNederland.map((s) => s.c).join(', ')}`);

// De Maas ligt bij de Belgische grens ruim 44 meter boven NAP; pas daarboven is een
// waarde onwaarschijnlijk. Aan de lage kant is -700 cm NAP (diepe polder) de ondergrens.
const onzin = stations.filter((s) => s.v > 6000 || s.v < -700);
eis(onzin.length === 0, `onwaarschijnlijke waterstanden: ${onzin.map((s) => `${s.c}=${s.v}`).join(', ')}`);

const oud = stations.filter((s) => Date.now() - s.t > 4 * 3600e3);
eis(oud.length === 0, `${oud.length} meetpunten met een meting ouder dan vier uur`);

const metVerwachting = stations.filter((s) => s.vw).length;
eis(metVerwachting >= 20, `te weinig verwachtingen: ${metVerwachting}`);

const raar = netwerk.relaties.filter((r) => r.correlatie > 1.001 || r.correlatie < -1.001 || r.vertragingUur < 0);
eis(raar.length === 0, `onmogelijke stroomrelaties: ${raar.length}`);

console.log(`Meetpunten: ${stations.length}`);
console.log(`Met verwachting: ${metVerwachting} (officieel ${meta.aantalVerwachtingen}, afgeleid ${meta.aantalAfgeleid})`);
console.log(`Stroomrelaties: ${netwerk.relaties.length}, waarvan bruikbaar: ${netwerk.relaties.filter((r) => r.correlatie >= 0.6).length}`);
const nul = stations.filter((s) => s.tr == null).length;
console.log(`Zonder trend: ${nul}`);

if (fouten.length) {
  console.error('\nControle mislukt:');
  for (const f of fouten) console.error('  - ' + f);
  process.exit(1);
}
console.log('\nControle geslaagd.');
