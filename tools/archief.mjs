// Bouwt het meetarchief op en houdt het bij.
//
// Rijkswaterstaat levert metingen per tien minuten en bewaart ze jarenlang. Die dichtheid
// is voor een jarenlang archief onbetaalbaar: één jaar per meetpunt is ruwweg 15 MB, en
// dat zou de repository laten ontploffen. De browser kan de dienst niet zelf bevragen —
// er komen geen CORS-headers terug — dus alles wat de site nodig heeft moet vooraf klaar
// staan.
//
// Daarom bewaart het archief per dag alleen de hoogste en de laagste gemeten stand. Dat is
// precies wat de vraag "stond het water hier ooit boven mijn maaiveld" nodig heeft, en het
// kost ongeveer 4 kB per meetpunt per jaar: het hele archief van alle meetpunten over zes
// jaar blijft daarmee onder de tien megabyte.
//
// Eén bestand per meetpunt per jaar. Afgesloten jaren veranderen daarna niet meer, dus de
// dagelijkse bijwerking raakt alleen het lopende jaar.

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { haalCatalogus, meetpuntenPerProces, haalReeks, parallel, api, teller, UUR } from './rws.mjs';

const ARCHIEF = new URL('../archief/', import.meta.url);
const DAG = 24 * UUR;

const DIEPTE_DAGEN = Number(process.env.ARCHIEF_DIEPTE_DAGEN || 2200);  // ruim zes jaar
const STAP_DAGEN = Number(process.env.ARCHIEF_STAP_DAGEN || 365);       // hoeveel er per beurt bij komt
const GELIJKTIJDIG = Number(process.env.ARCHIEF_GELIJKTIJDIG || 4);
const ALLEEN = (process.env.ARCHIEF_ALLEEN_CODES || '').split(',').map((s) => s.trim()).filter(Boolean);

const nu = new Date();
const dagBegin = (ms) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };
const jaarVan = (ms) => new Date(ms).getUTCFullYear();
const jaarBegin = (jaar) => Date.UTC(jaar, 0, 1);
const dagenInJaar = (jaar) => (Date.UTC(jaar + 1, 0, 1) - Date.UTC(jaar, 0, 1)) / DAG;

// Gisteren is de laatste hele dag; vandaag zit al in de actuele momentopname.
const eindeArchief = dagBegin(nu.getTime());
const doelBegin = eindeArchief - DIEPTE_DAGEN * DAG;

const datum = (ms) => new Date(ms).toISOString().slice(0, 10);
console.log(`Archief bijwerken. Doel: ${datum(doelBegin)} tot ${datum(eindeArchief)}.`);
if (ALLEEN.length) console.log(`Beperkt tot: ${ALLEEN.join(', ')}`);

// ------------------------------------------------------------- meetpunten bepalen

const catalogus = await haalCatalogus();
const { codes } = meetpuntenPerProces(catalogus);

let stations;
if (ALLEEN.length) {
  stations = ALLEEN.filter((c) => codes.meting.has(c));
  const onbekend = ALLEEN.filter((c) => !codes.meting.has(c));
  if (onbekend.length) console.warn(`Onbekende meetpunten overgeslagen: ${onbekend.join(', ')}`);
} else {
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
      if (meting && nu - new Date(meting.Tijdstip).getTime() < 3 * UUR) actief.add(w.Locatie.Code);
    }
  });
  stations = [...actief].sort();
}
console.log(`${stations.length} meetpunten.`);

// --------------------------------------------------------- bestaand archief inlezen

const leesJaar = async (code, jaar) => {
  try { return JSON.parse(await readFile(new URL(`${jaar}/${code}.json`, ARCHIEF), 'utf8')); }
  catch { return null; }
};

let aanwezigeJaren = [];
if (existsSync(ARCHIEF)) {
  aanwezigeJaren = (await readdir(ARCHIEF, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && /^\d{4}$/.test(d.name))
    .map((d) => Number(d.name))
    .sort((a, b) => a - b);
}
console.log(`Aanwezig: ${aanwezigeJaren.length ? aanwezigeJaren.join(', ') : 'nog niets'}`);

// ------------------------------------------------------ te vullen periode bepalen

// Vooruit: de laatste dagen altijd opnieuw, want metingen worden later nog gecontroleerd.
const vooruitVanaf = eindeArchief - 5 * DAG;

// Terug: verder dan wat er al is. Bij een gerichte aanvulling telt alleen het doel.
let terugVanaf = null, terugTot = null;
const oudsteAanwezig = aanwezigeJaren.length && !ALLEEN.length ? jaarBegin(aanwezigeJaren[0]) : null;
const startpunt = oudsteAanwezig ?? vooruitVanaf;
if (startpunt > doelBegin) {
  terugTot = startpunt;
  terugVanaf = Math.max(doelBegin, terugTot - STAP_DAGEN * DAG);
}

const perioden = [{ naam: 'vooruit', vanaf: vooruitVanaf, tot: eindeArchief }];
if (terugVanaf != null && terugTot > terugVanaf) perioden.push({ naam: 'terug', vanaf: terugVanaf, tot: terugTot });
for (const p of perioden) console.log(`  ${p.naam}: ${datum(p.vanaf)} tot ${datum(p.tot)}`);
if (terugVanaf == null) console.log('  De gewenste diepte is bereikt; alleen bijwerken.');

// --------------------------------------------------- ophalen en per dag samenvatten

function perDag(punten) {
  const dagen = new Map();
  for (const [t, v] of punten) {
    const dag = dagBegin(t);
    const bestaand = dagen.get(dag);
    if (!bestaand) dagen.set(dag, [v, v]);
    else { if (v < bestaand[0]) bestaand[0] = v; if (v > bestaand[1]) bestaand[1] = v; }
  }
  return dagen;
}

const teSchrijven = new Map();
let mislukt = 0;

async function verwerk(code) {
  const dagen = new Map();
  for (const periode of perioden) {
    // In stukken van hoogstens 60 dagen, zodat elk antwoord hanteerbaar blijft.
    for (let start = periode.vanaf; start < periode.tot; start += 60 * DAG) {
      const eind = Math.min(periode.tot, start + 60 * DAG);
      const reeks = await haalReeks(code, 'meting', start, eind);
      for (const [dag, paar] of perDag(reeks)) {
        const bestaand = dagen.get(dag);
        if (!bestaand) dagen.set(dag, paar);
        else { bestaand[0] = Math.min(bestaand[0], paar[0]); bestaand[1] = Math.max(bestaand[1], paar[1]); }
      }
    }
  }
  if (!dagen.size) return;

  const perJaar = new Map();
  for (const [dag, paar] of dagen) {
    const jaar = jaarVan(dag);
    if (!perJaar.has(jaar)) perJaar.set(jaar, []);
    perJaar.get(jaar).push([dag, paar]);
  }

  for (const [jaar, lijst] of perJaar) {
    const lengte = dagenInJaar(jaar);
    const begin = jaarBegin(jaar);
    const sleutel = `${jaar}|${code}`;
    let data = teSchrijven.get(sleutel)?.data || (await leesJaar(code, jaar));
    if (!data || data.mn?.length !== lengte) {
      data = { c: code, jaar, van: begin, stap: DAG, mn: new Array(lengte).fill(null), mx: new Array(lengte).fill(null) };
    }
    let veranderd = false;
    for (const [dag, paar] of lijst) {
      const i = Math.round((dag - begin) / DAG);
      if (i < 0 || i >= lengte) continue;
      const lo = Math.round(paar[0]), hi = Math.round(paar[1]);
      if (data.mn[i] !== lo || data.mx[i] !== hi) { data.mn[i] = lo; data.mx[i] = hi; veranderd = true; }
    }
    if (veranderd) teSchrijven.set(sleutel, { code, jaar, data });
  }
}

const uitkomsten = await parallel(stations, GELIJKTIJDIG, async (code) => { await verwerk(code); return true; });
for (const u of uitkomsten) if (u?.fout) { mislukt++; if (mislukt <= 5) console.warn('  mislukt:', u.fout.slice(0, 140)); }

for (const { code, jaar, data } of teSchrijven.values()) {
  await mkdir(new URL(`${jaar}/`, ARCHIEF), { recursive: true });
  await writeFile(new URL(`${jaar}/${code}.json`, ARCHIEF), JSON.stringify(data));
}

console.log(`\n${teSchrijven.size} jaarbestanden bijgewerkt, ${mislukt} meetpunten mislukt.`);
console.log(`${teller.verzoeken} verzoeken, ${(teller.bytes / 1048576).toFixed(0)} MB opgehaald bij Rijkswaterstaat.`);
if (mislukt > stations.length / 4) throw new Error('Te veel meetpunten mislukt; archief niet betrouwbaar bijgewerkt.');
