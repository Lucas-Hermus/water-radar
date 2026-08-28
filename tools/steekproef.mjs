// Drukt een steekproef van de opgehaalde gegevens af, zodat te controleren is of
// waarden, tijden en eenheden kloppen.

import { readFile } from 'node:fs/promises';
const lees = async (n) => JSON.parse(await readFile(new URL(`../site/data/${n}`, import.meta.url), 'utf8'));

const meta = await lees('meta.json');
const stations = await lees('stations.json');
const reeksen = await lees('reeksen.json');
const netwerk = await lees('netwerk.json');

const tijd = (min) => new Date(meta.basisTijd + min * 60000).toISOString().slice(0, 16).replace('T', ' ');
const perCode = new Map(stations.map((s) => [s.c, s]));

console.log('META', JSON.stringify(meta));

console.log('\n--- BEKENDE MEETPUNTEN ---');
for (const code of ['lobith.bovenrijn.tolkamer', 'nijmegen.waal', 'tiel.waal', 'venlo', 'maastricht.sintpieter',
  'deventer', 'hoekvanholland', 'vlissingen', 'delfzijl', 'dordrecht.nieuwemerwede']) {
  const s = perCode.get(code);
  if (!s) { console.log(`${code}: ONTBREEKT`); continue; }
  console.log(`${s.n} | ${(s.v / 100).toFixed(2)} m NAP | trend ${s.tr} cm/u | ${s.kl} | ` +
    `30u ${(s.min30 / 100).toFixed(2)}–${(s.max30 / 100).toFixed(2)} | verwachting ${s.vw} ` +
    `${s.vwMax != null ? 'max ' + (s.vwMax / 100).toFixed(2) : ''} | ${s.lat},${s.lon}`);
}

console.log('\n--- REEKS lobith.bovenrijn.tolkamer ---');
for (const soort of ['m', 'v']) {
  const r = reeksen['lobith.bovenrijn.tolkamer']?.[soort];
  if (!r) { console.log(soort, 'ontbreekt'); continue; }
  console.log(`${soort} (${r.length} punten): begin ${r.slice(0, 2).map(([t, v]) => `${tijd(t)}=${v}`).join(' ')} ` +
    `… eind ${r.slice(-2).map(([t, v]) => `${tijd(t)}=${v}`).join(' ')}`);
}

console.log('\n--- STERKSTE RIVIERVAKKEN ---');
for (const r of netwerk.relaties.slice(0, 12)) {
  console.log(`${perCode.get(r.boven)?.n || r.boven} → ${perCode.get(r.beneden)?.n || r.beneden}: ` +
    `${r.vertragingUur} u | doorwerking ${r.versterking} | r=${r.correlatie}`);
}

console.log('\n--- ZWAKSTE RIVIERVAKKEN ---');
for (const r of netwerk.relaties.slice(-6)) {
  console.log(`${perCode.get(r.boven)?.n || r.boven} → ${perCode.get(r.beneden)?.n || r.beneden}: ` +
    `${r.vertragingUur} u | doorwerking ${r.versterking} | r=${r.correlatie}`);
}

console.log('\n--- AFGELEIDE VERWACHTINGEN ---');
const afg = stations.filter((s) => s.vw === 'afgeleid');
for (const s of afg.slice(0, 12)) {
  console.log(`${s.n} ← ${perCode.get(s.bron?.bron)?.n || s.bron?.bron} | ${s.bron?.wijze} | ` +
    `${s.bron?.vertragingUur} u | doorwerking ${s.bron?.versterking} | r=${s.bron?.correlatie}` +
    (s.bron?.afstandKm != null ? ` | ${s.bron.afstandKm} km` : ''));
}
console.log(`(${afg.length} afgeleid in totaal)`);

console.log('\n--- AANSLUITING METING OP VERWACHTING ---');
const sprongen = [];
for (const [code, r] of Object.entries(reeksen)) {
  if (!r.v?.length || !r.m?.length) continue;
  const laatsteMeting = r.m.at(-1)[1];
  const eersteVerwachting = r.v.find(([t]) => t >= r.m.at(-1)[0])?.[1] ?? r.v[0][1];
  sprongen.push({ code, sprong: Math.abs(eersteVerwachting - laatsteMeting), soort: r.vs });
}
sprongen.sort((a, b) => b.sprong - a.sprong);
console.log('grootste sprongen (cm):', sprongen.slice(0, 8).map((s) => `${s.code}=${s.sprong.toFixed(0)}(${s.soort})`).join(', '));
const mediaan = sprongen[Math.floor(sprongen.length / 2)];
console.log(`mediane sprong: ${mediaan?.sprong.toFixed(1)} cm over ${sprongen.length} meetpunten`);
