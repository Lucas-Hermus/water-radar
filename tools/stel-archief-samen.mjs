// Voegt de jaarbestanden per meetpunt samen tot één bestand per meetpunt, zodat de browser
// voor een meetpunt precies één klein bestand hoeft te downloaden (een paar kilobyte per
// jaar). Dit draait bij het publiceren; het resultaat komt niet in de repository.

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const ARCHIEF = new URL('../archief/', import.meta.url);
const DOEL = new URL('../site/data/archief/', import.meta.url);
const DAG = 86400000;

await mkdir(DOEL, { recursive: true });

if (!existsSync(ARCHIEF)) {
  console.log('Nog geen archief aanwezig; deze stap wordt overgeslagen.');
  await writeFile(new URL('index.json', DOEL), JSON.stringify({ meetpunten: {}, van: null, tot: null }));
  process.exit(0);
}

const jaren = (await readdir(ARCHIEF, { withFileTypes: true }))
  .filter((d) => d.isDirectory() && /^\d{4}$/.test(d.name))
  .map((d) => Number(d.name))
  .sort((a, b) => a - b);

const perCode = new Map();
for (const jaar of jaren) {
  for (const bestand of await readdir(new URL(`${jaar}/`, ARCHIEF))) {
    if (!bestand.endsWith('.json')) continue;
    const code = bestand.slice(0, -5);
    const data = JSON.parse(await readFile(new URL(`${jaar}/${bestand}`, ARCHIEF), 'utf8'));
    if (!perCode.has(code)) perCode.set(code, []);
    perCode.get(code).push(data);
  }
}

const index = {};
let totaal = 0;

for (const [code, delen] of perCode) {
  delen.sort((a, b) => a.van - b.van);
  const van = delen[0].van;
  const tot = delen.at(-1).van + delen.at(-1).mn.length * DAG;
  const lengte = Math.round((tot - van) / DAG);
  const mn = new Array(lengte).fill(null);
  const mx = new Array(lengte).fill(null);
  for (const deel of delen) {
    const verschuiving = Math.round((deel.van - van) / DAG);
    for (let i = 0; i < deel.mn.length; i++) {
      const j = verschuiving + i;
      if (j >= 0 && j < lengte && deel.mn[i] != null) { mn[j] = deel.mn[i]; mx[j] = deel.mx[i]; }
    }
  }
  // Laatste gevulde dag bepaalt het echte einde; lege staarten weglaten.
  let eind = lengte;
  while (eind > 0 && mn[eind - 1] == null) eind--;
  let start = 0;
  while (start < eind && mn[start] == null) start++;

  const tekst = JSON.stringify({
    c: code, van: van + start * DAG, stap: DAG,
    mn: mn.slice(start, eind), mx: mx.slice(start, eind),
  });
  await writeFile(new URL(`${code}.json`, DOEL), tekst);
  index[code] = {
    van: van + start * DAG,
    tot: van + eind * DAG,
    dagen: eind - start,
    gevuld: mn.slice(start, eind).reduce((n, v) => n + (v == null ? 0 : 1), 0),
  };
  totaal += tekst.length;
}

const alleVan = Object.values(index).map((i) => i.van);
const alleTot = Object.values(index).map((i) => i.tot);
await writeFile(new URL('index.json', DOEL), JSON.stringify({
  meetpunten: index,
  van: alleVan.length ? Math.min(...alleVan) : null,
  tot: alleTot.length ? Math.max(...alleTot) : null,
}));

console.log(`Archief samengesteld: ${perCode.size} meetpunten, ${jaren.length} jaar, ${(totaal / 1024).toFixed(0)} kB` +
  ` (gemiddeld ${perCode.size ? Math.round(totaal / perCode.size / 1024) : 0} kB per meetpunt).`);
if (alleVan.length) console.log(`Bereik: ${new Date(Math.min(...alleVan)).toISOString().slice(0, 10)} tot ${new Date(Math.max(...alleTot)).toISOString().slice(0, 10)}.`);
