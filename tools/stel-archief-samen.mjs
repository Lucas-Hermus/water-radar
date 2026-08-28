// Voegt de maandbestanden per meetpunt samen tot een bestand per meetpunt, zodat de
// browser voor een meetpunt maar een keer hoeft te downloaden. Dit draait bij het
// publiceren; het resultaat komt niet in de repository.

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const ARCHIEF = new URL('../archief/', import.meta.url);
const DOEL = new URL('../site/data/archief/', import.meta.url);
const UUR = 3600e3;

if (!existsSync(ARCHIEF)) {
  console.log('Nog geen archief aanwezig; deze stap wordt overgeslagen.');
  await mkdir(DOEL, { recursive: true });
  await writeFile(new URL('index.json', DOEL), JSON.stringify({ meetpunten: {}, van: null, tot: null }));
  process.exit(0);
}

const maanden = (await readdir(ARCHIEF, { withFileTypes: true }))
  .filter((d) => d.isDirectory() && /^\d{4}-\d{2}$/.test(d.name))
  .map((d) => d.name)
  .sort();

const perCode = new Map();
for (const maand of maanden) {
  for (const bestand of await readdir(new URL(`${maand}/`, ARCHIEF))) {
    if (!bestand.endsWith('.json')) continue;
    const code = bestand.slice(0, -5);
    const data = JSON.parse(await readFile(new URL(`${maand}/${bestand}`, ARCHIEF), 'utf8'));
    if (!perCode.has(code)) perCode.set(code, []);
    perCode.get(code).push(data);
  }
}

await mkdir(DOEL, { recursive: true });
const index = {};
let totaal = 0;

for (const [code, delen] of perCode) {
  delen.sort((a, b) => a.van - b.van);
  const van = delen[0].van;
  const tot = delen.at(-1).van + delen.at(-1).mn.length * UUR;
  const lengte = Math.round((tot - van) / UUR);
  const mn = new Array(lengte).fill(null);
  const mx = new Array(lengte).fill(null);
  for (const deel of delen) {
    const verschuiving = Math.round((deel.van - van) / UUR);
    for (let i = 0; i < deel.mn.length; i++) {
      const j = verschuiving + i;
      if (j >= 0 && j < lengte) { mn[j] = deel.mn[i]; mx[j] = deel.mx[i]; }
    }
  }
  const gevuld = mn.reduce((n, v) => n + (v == null ? 0 : 1), 0);
  const tekst = JSON.stringify({ c: code, van, stap: UUR, mn, mx });
  await writeFile(new URL(`${code}.json`, DOEL), tekst);
  index[code] = { van, tot, uren: lengte, gevuld };
  totaal += tekst.length;
}

const alleVan = Object.values(index).map((i) => i.van);
const alleTot = Object.values(index).map((i) => i.tot);
await writeFile(new URL('index.json', DOEL), JSON.stringify({
  meetpunten: index,
  van: alleVan.length ? Math.min(...alleVan) : null,
  tot: alleTot.length ? Math.max(...alleTot) : null,
}));

console.log(`Archief samengesteld: ${perCode.size} meetpunten, ${maanden.length} maanden, ${(totaal / 1048576).toFixed(1)} MB.`);
if (alleVan.length) {
  console.log(`Bereik: ${new Date(Math.min(...alleVan)).toISOString().slice(0, 10)} tot ${new Date(Math.max(...alleTot)).toISOString().slice(0, 10)}.`);
}
