// Haalt de actuele waterstanden, de officiële verwachtingen en de stroomrelaties op
// bij Rijkswaterstaat en schrijft daar compacte JSON-bestanden van weg voor de website.
//
// Bronnen:
//   - DD-API 2.0 (WaterWebservices) van Rijkswaterstaat: metingen en verwachtingen
//   - Waterinfo van Rijkswaterstaat: officiële klasse-indeling per meetpunt
//
// Er wordt niets geschat wat gemeten kan worden: vertraging en versterking tussen
// meetpunten volgen uit kruiscorrelatie van de werkelijke reeksen.

import { writeFile, mkdir } from 'node:fs/promises';
import { schakels, netwerkPunten, KETENS } from './netwerk.mjs';

const DDAPI = 'https://ddapi20-waterwebservices.rijkswaterstaat.nl';
const WATERINFO = 'https://waterinfo.rws.nl/api/point/latestmeasurement?parameterid=waterhoogte';
const UITVOER = new URL('../site/data/', import.meta.url);

const UUR = 3600e3;
const HISTORIE_UREN = 30;          // getoonde meetgeschiedenis
const IJK_UREN = 7 * 24;           // reeks voor het ijken van de stroomrelaties
const VERWACHTING_UREN = 54;       // vooruitblik
const VERS_UREN = 3;               // meetpunt telt als actief bij meting binnen deze tijd

const nu = new Date();
const tijdstempel = (d) => d.toISOString().replace('Z', '+00:00');

let aantalVerzoeken = 0;

async function api(pad, body, pogingen = 3) {
  for (let poging = 1; poging <= pogingen; poging++) {
    try {
      aantalVerzoeken++;
      const res = await fetch(DDAPI + pad, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(90000),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
      return await res.json();
    } catch (fout) {
      if (poging === pogingen) throw fout;
      await new Promise((r) => setTimeout(r, 800 * poging));
    }
  }
}

// Voert taken uit met een begrensd aantal gelijktijdige verzoeken.
async function parallel(items, grens, taak) {
  const uit = new Array(items.length);
  let volgende = 0;
  const werkers = Array.from({ length: Math.min(grens, items.length) }, async () => {
    while (true) {
      const i = volgende++;
      if (i >= items.length) return;
      try { uit[i] = await taak(items[i], i); } catch (fout) { uit[i] = { fout: String(fout.message || fout) }; }
    }
  });
  await Promise.all(werkers);
  return uit;
}

// ---------------------------------------------------------------- catalogus

console.log('Catalogus ophalen…');
const catalogus = await api('/METADATASERVICES/OphalenCatalogus', {
  CatalogusFilter: { Grootheden: true, ProcesTypes: true, Hoedanigheden: true, Eenheden: true, Compartimenten: true },
});

const metaIds = {};
for (const a of catalogus.AquoMetadataLijst) {
  if (a.Grootheid?.Code === 'WATHTE' && a.Hoedanigheid?.Code === 'NAP' && a.Eenheid?.Code === 'cm') {
    metaIds[a.ProcesType] = a.AquoMetadata_MessageID;
  }
}
console.log('Aquo-metadata:', JSON.stringify(metaIds));
if (!metaIds.meting) throw new Error('Geen metadata voor gemeten waterhoogte t.o.v. NAP gevonden');

const locatiePerId = new Map(catalogus.LocatieLijst.map((l) => [l.Locatie_MessageID, l]));
const codesPerProces = {};
for (const [proces, id] of Object.entries(metaIds)) codesPerProces[proces] = new Set();
for (const koppel of catalogus.AquoMetadataLocatieLijst) {
  for (const [proces, id] of Object.entries(metaIds)) {
    if (koppel.AquoMetaData_MessageID === id) {
      const loc = locatiePerId.get(koppel.Locatie_MessageID);
      if (loc) codesPerProces[proces].add(loc.Code);
    }
  }
}
for (const [proces, set] of Object.entries(codesPerProces)) console.log(`  ${proces}: ${set.size} meetpunten`);

const locatiePerCode = new Map();
for (const l of catalogus.LocatieLijst) if (!locatiePerCode.has(l.Code)) locatiePerCode.set(l.Code, l);

// ---------------------------------------------------------- actuele standen

console.log('Laatste standen ophalen…');
const meetCodes = [...codesPerProces.meting];
const brokken = [];
for (let i = 0; i < meetCodes.length; i += 60) brokken.push(meetCodes.slice(i, i + 60));

const laatste = new Map();
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
    const waarde = meting?.Meetwaarde?.Waarde_Numeriek;
    if (waarde == null || Math.abs(waarde) > 10000) continue;
    const tijd = new Date(meting.Tijdstip).getTime();
    const bestaand = laatste.get(w.Locatie.Code);
    if (!bestaand || tijd > bestaand.tijd) {
      laatste.set(w.Locatie.Code, { tijd, waarde, locatie: w.Locatie });
    }
  }
});
console.log(`  ${laatste.size} meetpunten met een laatste stand`);

const actief = [...laatste.entries()]
  .filter(([, v]) => nu - v.tijd < VERS_UREN * UUR)
  .map(([code]) => code)
  .sort();
console.log(`  ${actief.length} meetpunten met een verse meting (< ${VERS_UREN} uur)`);

// --------------------------------------------------- klasse-indeling van RWS

const klassePerCode = new Map();
try {
  const res = await fetch(WATERINFO, { signal: AbortSignal.timeout(60000) });
  const geo = await res.json();
  for (const f of geo.features || []) {
    const p = f.properties || {};
    const m = (p.measurements || []).find((x) => x.qualityCode === 'NAP') || (p.measurements || [])[0];
    if (p.locationCode && p.locationLabel) {
      klassePerCode.set(p.locationCode, { label: p.locationLabel, kleur: p.locationColor, verdacht: !!m?.possiblyFaulty });
    }
  }
  console.log(`Klasse-indeling van Waterinfo voor ${klassePerCode.size} meetpunten`);
} catch (fout) {
  console.warn('Waterinfo niet bereikbaar, doorgaan zonder klasse-indeling:', fout.message);
}

// ------------------------------------------------------------------ reeksen

const netwerkSet = new Set(netwerkPunten());

async function haalReeks(code, procesType, vanaf, tot) {
  const antwoord = await api('/ONLINEWAARNEMINGENSERVICES/OphalenWaarnemingen', {
    Locatie: { Code: code },
    AquoPlusWaarnemingMetadata: {
      AquoMetadata: {
        Eenheid: { Code: 'cm' }, Grootheid: { Code: 'WATHTE' },
        Hoedanigheid: { Code: 'NAP' }, ProcesType: procesType,
      },
    },
    Periode: { Begindatumtijd: tijdstempel(vanaf), Einddatumtijd: tijdstempel(tot) },
  });
  const punten = [];
  for (const w of antwoord.WaarnemingenLijst || []) {
    for (const m of w.MetingenLijst || []) {
      const waarde = m.Meetwaarde?.Waarde_Numeriek;
      if (waarde == null || Math.abs(waarde) > 10000) continue;
      punten.push([new Date(m.Tijdstip).getTime(), waarde]);
    }
  }
  punten.sort((a, b) => a[0] - b[0]);
  return punten;
}

console.log(`Meetreeksen ophalen voor ${actief.length} meetpunten…`);
const metingen = new Map();
await parallel(actief, 6, async (code) => {
  const uren = netwerkSet.has(code) ? IJK_UREN : HISTORIE_UREN;
  const reeks = await haalReeks(code, 'meting', new Date(nu - uren * UUR), nu);
  if (reeks.length) metingen.set(code, reeks);
});
console.log(`  ${metingen.size} reeksen opgehaald`);

const verwachtingCodes = actief.filter((c) => codesPerProces.verwachting?.has(c));
console.log(`Verwachtingen ophalen voor ${verwachtingCodes.length} meetpunten…`);
const verwachtingen = new Map();
await parallel(verwachtingCodes, 6, async (code) => {
  const reeks = await haalReeks(code, 'verwachting', new Date(nu - UUR), new Date(nu.getTime() + VERWACHTING_UREN * UUR));
  const toekomst = reeks.filter(([t]) => t > nu - 20 * 60e3);
  if (toekomst.length > 2) verwachtingen.set(code, toekomst);
});
console.log(`  ${verwachtingen.size} verwachtingen opgehaald`);

// ------------------------------------------------- rekenhulpen voor reeksen

// Waarde op een tijdstip, lineair geïnterpoleerd; null buiten het bereik of bij een te groot gat.
function waardeOp(reeks, t, maxGat = 90 * 60e3) {
  if (!reeks?.length) return null;
  if (t < reeks[0][0] - maxGat || t > reeks.at(-1)[0] + maxGat) return null;
  if (t <= reeks[0][0]) return reeks[0][1];
  if (t >= reeks.at(-1)[0]) return reeks.at(-1)[1];
  let lo = 0, hi = reeks.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (reeks[mid][0] <= t) lo = mid; else hi = mid; }
  const [t0, v0] = reeks[lo], [t1, v1] = reeks[hi];
  if (t1 - t0 > maxGat) return null;
  return v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
}

// Verandering in cm per uur over de laatste uren, via kleinste-kwadratenlijn.
function trendPerUur(reeks, uren = 3) {
  const grens = nu - uren * UUR;
  const punten = reeks.filter(([t]) => t >= grens);
  if (punten.length < 3) return null;
  const t0 = punten[0][0];
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const [t, v] of punten) { const x = (t - t0) / UUR; sx += x; sy += v; sxx += x * x; sxy += x * v; }
  const n = punten.length;
  const noemer = n * sxx - sx * sx;
  if (Math.abs(noemer) < 1e-9) return null;
  return (n * sxy - sx * sy) / noemer;
}

// Reeks op een vast raster van tien minuten.
function raster(reeks, vanaf, tot, stap = 10 * 60e3) {
  const uit = [];
  for (let t = vanaf; t <= tot; t += stap) uit.push(waardeOp(reeks, t));
  return uit;
}

function correlatie(a, b) {
  const paren = [];
  for (let i = 0; i < a.length; i++) if (a[i] != null && b[i] != null) paren.push([a[i], b[i]]);
  if (paren.length < 30) return null;
  const n = paren.length;
  const ma = paren.reduce((s, p) => s + p[0], 0) / n;
  const mb = paren.reduce((s, p) => s + p[1], 0) / n;
  let saa = 0, sbb = 0, sab = 0;
  for (const [x, y] of paren) { const dx = x - ma, dy = y - mb; saa += dx * dx; sbb += dy * dy; sab += dx * dy; }
  if (saa < 1e-9 || sbb < 1e-9) return null;
  return { r: sab / Math.sqrt(saa * sbb), helling: sab / saa, n };
}

function verschillen(rij) {
  const uit = [];
  for (let i = 1; i < rij.length; i++) uit.push(rij[i] == null || rij[i - 1] == null ? null : rij[i] - rij[i - 1]);
  return uit;
}

// ------------------------------------------- stroomrelaties tussen meetpunten

// Op tienminutenschaal is de ruis groter dan de werkelijke verandering. Daarom eerst
// glad strijken over een uur en pas daarna de verandering per uur bepalen; dat is het
// signaal waarin een verschuiving tussen twee meetpunten zichtbaar wordt.
const STAP = 10 * 60e3;
const VENSTER = 7;              // ongeveer een uur glad strijken
const DIFF_STAPPEN = 6;         // verandering over een uur

function gladstrijken(rij) {
  const uit = new Array(rij.length).fill(null);
  const halve = (VENSTER - 1) / 2;
  for (let i = 0; i < rij.length; i++) {
    let som = 0, aantal = 0;
    for (let k = -halve; k <= halve; k++) {
      const w = rij[i + k];
      if (w != null) { som += w; aantal++; }
    }
    if (aantal >= halve + 1) uit[i] = som / aantal;
  }
  return uit;
}

function veranderingPerUur(rij) {
  const uit = new Array(rij.length).fill(null);
  for (let i = DIFF_STAPPEN; i < rij.length; i++) {
    uit[i] = rij[i] == null || rij[i - DIFF_STAPPEN] == null ? null : rij[i] - rij[i - DIFF_STAPPEN];
  }
  return uit;
}

// Zoekt de verschuiving waarbij de veranderingen bovenstrooms en benedenstrooms het
// best samenvallen. Een positieve vertraging betekent: benedenstrooms loopt achter.
function ijkRelatie(bovenReeks, benedenReeks, { minUur = 0, maxUur = 24 } = {}) {
  const vanaf = Math.max(bovenReeks[0][0], benedenReeks[0][0]);
  const tot = Math.min(bovenReeks.at(-1)[0], benedenReeks.at(-1)[0]);
  if (tot - vanaf < 18 * UUR) return null;

  const dBoven = veranderingPerUur(gladstrijken(raster(bovenReeks, vanaf, tot, STAP)));
  const dBeneden = veranderingPerUur(gladstrijken(raster(benedenReeks, vanaf, tot, STAP)));

  const minStap = Math.round((minUur * UUR) / STAP);
  const maxStap = Math.round((maxUur * UUR) / STAP);
  let beste = null;
  for (let k = minStap; k <= maxStap; k++) {
    const a = k >= 0 ? dBoven.slice(0, dBoven.length - k) : dBoven.slice(-k);
    const b = k >= 0 ? dBeneden.slice(k) : dBeneden.slice(0, dBeneden.length + k);
    const c = correlatie(a, b);
    // Alleen een positief verband is fysisch zinnig: water dat bovenstrooms stijgt,
    // laat benedenstrooms het water stijgen. Bij getijdenwater levert het zoeken naar
    // de sterkste samenhang anders de tegenfase van het getij op, een halve golf ernaast.
    if (c && c.r > 0 && (!beste || c.r > beste.r)) beste = { ...c, stap: k };
  }
  if (!beste) return null;

  // Ligt het optimum op de rand van het doorzochte bereik, dan is de werkelijke
  // verschuiving waarschijnlijk groter en is deze uitkomst niet te vertrouwen.
  const opDeRand = beste.stap === maxStap || (minStap < 0 && beste.stap === minStap);
  if (opDeRand) return null;

  return {
    vertragingUur: Number(((beste.stap * STAP) / UUR).toFixed(2)),
    versterking: Number(beste.helling.toFixed(3)),
    correlatie: Number(beste.r.toFixed(3)),
    punten: beste.n,
  };
}

console.log('Stroomrelaties in de riviervakken ijken…');
const relaties = [];
for (const schakel of schakels()) {
  const boven = metingen.get(schakel.boven);
  const beneden = metingen.get(schakel.beneden);
  if (!boven || !beneden) continue;
  const ijking = ijkRelatie(boven, beneden, { minUur: 0, maxUur: 24 });
  if (!ijking) continue;
  relaties.push({ boven: schakel.boven, beneden: schakel.beneden, keten: schakel.keten, type: schakel.type, ...ijking });
}
relaties.sort((a, b) => b.correlatie - a.correlatie);
console.log(`  ${relaties.length} riviervakken doorgerekend, ${relaties.filter((r) => r.correlatie >= 0.6).length} bruikbaar`);

// ------------------------------------------- afgeleide verwachting doorgeven

// Meetpunten waarvoor Rijkswaterstaat geen verwachting publiceert, krijgen er een
// afgeleid van een meetpunt dat er wel een heeft. Eerst via de riviervakken hierboven,
// daarna via het best passende meetpunt in de omgeving. Wat niet goed genoeg past,
// krijgt geen verwachting.
const BETROUWBAAR = 0.6;
const BETROUWBAAR_AUTOMATISCH = 0.8;
const afgeleid = new Map();
const afgeleidBron = new Map();

function reeksVoor(code) {
  const v = verwachtingen.get(code) || afgeleid.get(code);
  const m = metingen.get(code);
  if (!v) return m;
  if (!m) return v;
  return [...m.filter(([t]) => t <= v[0][0]), ...v];
}

// Neemt de verandering bij het bronmeetpunt over, verschoven met de gemeten vertraging
// en geschaald met de gemeten doorwerking, verankerd aan de huidige eigen stand.
function leidAf(code, bronCode, ijking) {
  const bron = reeksVoor(bronCode);
  const eigen = metingen.get(code);
  if (!bron || !eigen) return false;
  const verschuiving = ijking.vertragingUur * UUR;
  const nuWaarde = eigen.at(-1)[1];
  const referentie = waardeOp(bron, nu - verschuiving);
  if (referentie == null) return false;

  const reeks = [];
  for (let t = nu.getTime() + STAP; t <= nu.getTime() + VERWACHTING_UREN * UUR; t += STAP) {
    const w = waardeOp(bron, t - verschuiving);
    if (w == null) break;
    reeks.push([t, Number((nuWaarde + ijking.versterking * (w - referentie)).toFixed(1))]);
  }
  if (reeks.length < 12) return false;
  afgeleid.set(code, reeks);
  afgeleidBron.set(code, { bron: bronCode, ...ijking, wijze: 'riviervak' });
  return true;
}

for (let ronde = 0; ronde < 4; ronde++) {
  for (const rel of relaties) {
    if (verwachtingen.has(rel.beneden) || afgeleid.has(rel.beneden)) continue;
    if (rel.correlatie < BETROUWBAAR || rel.versterking <= 0) continue;
    leidAf(rel.beneden, rel.boven, rel);
  }
}
console.log(`  ${afgeleid.size} verwachtingen afgeleid via de riviervakken`);

// Automatisch het best passende meetpunt zoeken voor wat er dan nog over is.
const metVerwachting = actief.filter((c) => verwachtingen.has(c) && metingen.has(c));
const zonder = actief.filter((c) => !verwachtingen.has(c) && !afgeleid.has(c) && metingen.has(c));
console.log(`Beste bronmeetpunt zoeken voor ${zonder.length} meetpunten zonder verwachting…`);

const plaatsVan = (code) => laatste.get(code)?.locatie || locatiePerCode.get(code);
const kmTussen = (a, b) => {
  const R = 6371, rad = (g) => (g * Math.PI) / 180;
  const dLat = rad(b.Lat - a.Lat), dLon = rad(b.Lon - a.Lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.Lat)) * Math.cos(rad(b.Lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
};

let automatisch = 0;
for (const code of zonder) {
  const hier = plaatsVan(code);
  if (!hier?.Lat) continue;
  const eigen = metingen.get(code);
  const kandidaten = metVerwachting
    .map((bron) => ({ bron, km: kmTussen(hier, plaatsVan(bron) || {}) }))
    .filter((k) => Number.isFinite(k.km) && k.km <= 75)
    .sort((a, b) => a.km - b.km)
    .slice(0, 12);

  let beste = null;
  for (const kandidaat of kandidaten) {
    const ijking = ijkRelatie(metingen.get(kandidaat.bron), eigen, { minUur: -6, maxUur: 6 });
    if (!ijking) continue;
    if (Math.abs(ijking.versterking) < 0.1 || Math.abs(ijking.versterking) > 3) continue;
    if (!beste || ijking.correlatie > beste.ijking.correlatie) beste = { ...kandidaat, ijking };
  }
  if (beste && beste.ijking.correlatie >= BETROUWBAAR_AUTOMATISCH) {
    if (leidAf(code, beste.bron, beste.ijking)) {
      afgeleidBron.set(code, { bron: beste.bron, ...beste.ijking, wijze: 'omgeving', afstandKm: Number(beste.km.toFixed(1)) });
      automatisch++;
    }
  }
}
console.log(`  ${automatisch} verwachtingen afgeleid van een meetpunt in de omgeving`);
console.log(`  ${afgeleid.size} afgeleide verwachtingen in totaal`);

// ---------------------------------------------------------------- uitschrijven

const basis = Math.floor((nu.getTime() - HISTORIE_UREN * UUR) / 60000) * 60000;
const inkorten = (reeks, vanaf) => reeks
  .filter(([t]) => t >= vanaf)
  .map(([t, v]) => [Math.round((t - basis) / 60000), Number(v.toFixed(1))]);

const stations = [];
const reeksen = {};

for (const code of actief) {
  const loc = laatste.get(code).locatie || locatiePerCode.get(code);
  if (!loc || loc.Lat == null || loc.Lon == null) continue;
  const meet = metingen.get(code);
  const laatsteWaarde = laatste.get(code);
  const klasse = klassePerCode.get(code);
  const getoond = meet ? meet.filter(([t]) => t >= nu - HISTORIE_UREN * UUR) : [];
  const waarden = getoond.map(([, v]) => v);
  const verw = verwachtingen.get(code);
  const afg = afgeleid.get(code);
  const bron = afgeleidBron.get(code);

  const trend = meet ? trendPerUur(meet) : null;
  const alles = (verw || afg || []).filter(([t]) => t >= nu.getTime()).map(([, v]) => v);
  stations.push({
    c: code,
    n: loc.Naam || code,
    lat: Number(loc.Lat.toFixed(6)),
    lon: Number(loc.Lon.toFixed(6)),
    v: laatsteWaarde.waarde,
    t: laatsteWaarde.tijd,
    tr: trend != null ? Number(trend.toFixed(1)) : null,
    kl: klasse?.label || null,
    kle: klasse?.kleur || null,
    min30: waarden.length ? Math.min(...waarden) : null,
    max30: waarden.length ? Math.max(...waarden) : null,
    vw: verw ? 'officieel' : afg ? 'afgeleid' : null,
    vwMax: alles.length ? Math.max(...alles) : null,
    bron: bron || null,
  });

  reeksen[code] = {
    m: inkorten(getoond, nu - HISTORIE_UREN * UUR),
    v: verw ? inkorten(verw, nu - UUR) : afg ? inkorten(afg, nu.getTime()) : null,
    vs: verw ? 'officieel' : afg ? 'afgeleid' : null,
  };
}

stations.sort((a, b) => a.n.localeCompare(b.n, 'nl'));

await mkdir(UITVOER, { recursive: true });
const schrijf = async (naam, data) => {
  const tekst = JSON.stringify(data);
  await writeFile(new URL(naam, UITVOER), tekst);
  console.log(`  ${naam}: ${(tekst.length / 1024).toFixed(0)} kB`);
};

await schrijf('meta.json', {
  gegenereerd: nu.toISOString(),
  basisTijd: basis,
  aantalStations: stations.length,
  aantalVerwachtingen: verwachtingen.size,
  aantalAfgeleid: afgeleid.size,
  historieUren: HISTORIE_UREN,
  verwachtingUren: VERWACHTING_UREN,
  verzoeken: aantalVerzoeken,
  bronnen: [
    { naam: 'Rijkswaterstaat WaterWebservices (DD-API 2.0)', url: 'https://rijkswaterstaatdata.nl/waterdata/' },
    { naam: 'Rijkswaterstaat Waterinfo', url: 'https://waterinfo.rws.nl/' },
  ],
});
await schrijf('stations.json', stations);
await schrijf('reeksen.json', reeksen);
await schrijf('netwerk.json', { ketens: KETENS, relaties });

console.log(`Klaar. ${aantalVerzoeken} verzoeken aan Rijkswaterstaat.`);
if (stations.length < 50) throw new Error(`Te weinig meetpunten (${stations.length}); publicatie afgebroken.`);
