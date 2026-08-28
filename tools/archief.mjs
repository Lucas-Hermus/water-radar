// Bouwt het meetarchief op en houdt het bij.
//
// Rijkswaterstaat levert de metingen per tien minuten en bewaart ze jarenlang, maar een
// jaar aan data is ongeveer 15 MB per meetpunt. Alles in een keer ophalen zou onbeleefd
// zijn tegenover een openbare dienst, dus het archief groeit met elke draaibeurt een stuk
// verder terug tot de gewenste diepte bereikt is.
//
// Opslag: per maand een bestand per meetpunt met het hoogste en het laagste kwartier-
// gemiddelde per uur. Afgeronde maanden veranderen daarna niet meer, zodat de repository
// niet volloopt.

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { haalCatalogus, meetpuntenPerProces, haalReeks, parallel, api, teller, UUR } from './rws.mjs';

const ARCHIEF = new URL('../archief/', import.meta.url);
const DIEPTE_DAGEN = Number(process.env.ARCHIEF_DIEPTE_DAGEN || 730);   // hoe ver terug uiteindelijk
const STAP_DAGEN = Number(process.env.ARCHIEF_STAP_DAGEN || 30);        // hoeveel er per beurt bij komt
const GELIJKTIJDIG = Number(process.env.ARCHIEF_GELIJKTIJDIG || 4);

const nu = new Date();
const dagBegin = (d) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
const maandSleutel = (ms) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
const maandBegin = (ms) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); };
const volgendeMaand = (ms) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); };
const urenInMaand = (ms) => (volgendeMaand(ms) - maandBegin(ms)) / UUR;

// Gisteren is de laatste hele dag; vandaag staat nog in de actuele momentopname.
const eindeArchief = dagBegin(nu);
const doelBegin = eindeArchief - DIEPTE_DAGEN * 24 * UUR;

console.log(`Archief bijwerken. Doel: ${new Date(doelBegin).toISOString().slice(0, 10)} tot ${new Date(eindeArchief).toISOString().slice(0, 10)}.`);

// ------------------------------------------------------------- meetpunten bepalen

const catalogus = await haalCatalogus();
const { codes } = meetpuntenPerProces(catalogus);
const locatiePerCode = new Map();
for (const l of catalogus.LocatieLijst) if (!locatiePerCode.has(l.Code)) locatiePerCode.set(l.Code, l);

const meetCodes = [...codes.meting];
const brokken = [];
for (let i = 0; i < meetCodes.length; i += 60) brokken.push(meetCodes.slice(i, i + 60));

const actief = new Set();
await parallel(brokken, 4, async (brok) => {
  const antwoord = await api('/ONLINEWAARNEMINGENSERVICES/OphalenLaatsteWaarnemingen', {
    AquoPlusWaarnemingMetadataLijst: [{
      AquoMetadata: {
        Compartiment: { Code: 'OW' }, Eenheid: { Code: 'cm' },
        Grootheid: { Code: 'WATHTE' }, Hoedanigheid: { Code: 'NAP' },
      },
    }],
    LocatieLijst: brok.map((Code) => ({ Code })),
  });
  for (const w of antwoord.WaarnemingenLijst || []) {
    if (w.AquoMetadata?.ProcesType && w.AquoMetadata.ProcesType !== 'meting') continue;
    const meting = (w.MetingenLijst || []).at(-1);
    if (!meting) continue;
    if (nu - new Date(meting.Tijdstip).getTime() < 3 * UUR) actief.add(w.Locatie.Code);
  }
});
const stations = [...actief].sort();
console.log(`${stations.length} actieve meetpunten.`);

// --------------------------------------------------------- bestaand archief inlezen

async function leesMaand(code, sleutel) {
  const pad = new URL(`${sleutel}/${code}.json`, ARCHIEF);
  try { return JSON.parse(await readFile(pad, 'utf8')); } catch { return null; }
}

async function schrijfMaand(code, sleutel, data) {
  await mkdir(new URL(`${sleutel}/`, ARCHIEF), { recursive: true });
  await writeFile(new URL(`${sleutel}/${code}.json`, ARCHIEF), JSON.stringify(data));
}

// Welke maanden staan er al in het archief?
let aanwezigeMaanden = [];
if (existsSync(ARCHIEF)) {
  aanwezigeMaanden = (await readdir(ARCHIEF, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && /^\d{4}-\d{2}$/.test(d.name))
    .map((d) => d.name)
    .sort();
}
const oudsteAanwezig = aanwezigeMaanden[0];
console.log(`Aanwezig in het archief: ${aanwezigeMaanden.length} maanden` +
  (oudsteAanwezig ? ` (${oudsteAanwezig} tot ${aanwezigeMaanden.at(-1)})` : ''));

// ------------------------------------------------------ te vullen periode bepalen

// Vooruit: altijd de laatste dagen opnieuw, want metingen worden later nog gecontroleerd
// en bijgesteld.
const vooruitVanaf = eindeArchief - 4 * 24 * UUR;

// Terug: een stuk verder dan wat er al is, tot de gewenste diepte.
let terugTot = null, terugVanaf = null;
const alOudste = oudsteAanwezig ? Date.parse(oudsteAanwezig + '-01T00:00:00Z') : null;
if (alOudste == null) {
  terugTot = vooruitVanaf;
  terugVanaf = Math.max(doelBegin, terugTot - STAP_DAGEN * 24 * UUR);
} else if (alOudste > doelBegin) {
  terugTot = alOudste;
  terugVanaf = Math.max(doelBegin, terugTot - STAP_DAGEN * 24 * UUR);
}

const perioden = [{ naam: 'vooruit', vanaf: vooruitVanaf, tot: eindeArchief }];
if (terugVanaf != null && terugTot > terugVanaf) perioden.push({ naam: 'terug', vanaf: terugVanaf, tot: terugTot });
for (const p of perioden) {
  console.log(`  ${p.naam}: ${new Date(p.vanaf).toISOString().slice(0, 10)} tot ${new Date(p.tot).toISOString().slice(0, 10)}`);
}
if (terugVanaf == null) console.log('  De gewenste diepte is bereikt; alleen bijwerken.');

// --------------------------------------------------- ophalen en per uur samenvatten

// Voor elk uur het hoogste en het laagste tienminutengemiddelde. Voor de vraag of het
// water ooit boven het maaiveld stond is de piek binnen het uur bepalend, niet het
// gemiddelde; het laagste geeft bij getijdenwater de andere kant van de golf.
function perUur(punten) {
  const uren = new Map();
  for (const [t, v] of punten) {
    const uur = Math.floor(t / UUR) * UUR;
    const bestaand = uren.get(uur);
    if (!bestaand) uren.set(uur, [v, v]);
    else { if (v < bestaand[0]) bestaand[0] = v; if (v > bestaand[1]) bestaand[1] = v; }
  }
  return uren;
}

let gewijzigd = 0, mislukt = 0;
const teSchrijven = new Map(); // "sleutel|code" -> maandobject

async function verwerk(code) {
  const uren = new Map();
  for (const periode of perioden) {
    // In stukken van hoogstens 45 dagen, zodat een antwoord hanteerbaar blijft.
    for (let start = periode.vanaf; start < periode.tot; start += 45 * 24 * UUR) {
      const eind = Math.min(periode.tot, start + 45 * 24 * UUR);
      const reeks = await haalReeks(code, 'meting', start, eind);
      for (const [uur, paar] of perUur(reeks)) {
        const bestaand = uren.get(uur);
        if (!bestaand) uren.set(uur, paar);
        else { bestaand[0] = Math.min(bestaand[0], paar[0]); bestaand[1] = Math.max(bestaand[1], paar[1]); }
      }
    }
  }
  if (!uren.size) return;

  // Verdeel over maandbestanden.
  const perMaand = new Map();
  for (const [uur, paar] of uren) {
    const sleutel = maandSleutel(uur);
    if (!perMaand.has(sleutel)) perMaand.set(sleutel, []);
    perMaand.get(sleutel).push([uur, paar]);
  }

  for (const [sleutel, lijst] of perMaand) {
    const begin = maandBegin(lijst[0][0]);
    const lengte = urenInMaand(begin);
    let data = await leesMaand(code, sleutel);
    if (!data || data.van !== begin || data.mn?.length !== lengte) {
      data = { c: code, van: begin, stap: UUR, mn: new Array(lengte).fill(null), mx: new Array(lengte).fill(null) };
    }
    let veranderd = false;
    for (const [uur, paar] of lijst) {
      const i = Math.round((uur - begin) / UUR);
      if (i < 0 || i >= lengte) continue;
      const lo = Math.round(paar[0]), hi = Math.round(paar[1]);
      if (data.mn[i] !== lo || data.mx[i] !== hi) { data.mn[i] = lo; data.mx[i] = hi; veranderd = true; }
    }
    if (veranderd) teSchrijven.set(`${sleutel}|${code}`, { code, sleutel, data });
  }
}

const uitkomsten = await parallel(stations, GELIJKTIJDIG, async (code) => {
  await verwerk(code);
  return true;
});
for (const u of uitkomsten) if (u?.fout) { mislukt++; if (mislukt <= 5) console.warn('  mislukt:', u.fout.slice(0, 120)); }

for (const { code, sleutel, data } of teSchrijven.values()) {
  await schrijfMaand(code, sleutel, data);
  gewijzigd++;
}

console.log(`\n${gewijzigd} maandbestanden bijgewerkt, ${mislukt} meetpunten mislukt.`);
console.log(`${teller.verzoeken} verzoeken, ${(teller.bytes / 1048576).toFixed(0)} MB opgehaald bij Rijkswaterstaat.`);
if (mislukt > stations.length / 4) throw new Error('Te veel meetpunten mislukt; archief niet betrouwbaar bijgewerkt.');
