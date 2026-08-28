/* Waterradar — actuele waterstanden, verwachtingen en de marge tot het maaiveld.
   Alle waterdata komt van Rijkswaterstaat; de hoogte van de grond uit het AHN via PDOK. */

'use strict';

const PDOK_ZOEK = 'https://api.pdok.nl/bzk/locatieserver/search/v3_1';
const AHN_WMS = 'https://service.pdok.nl/rws/ahn/wms/v1_0';
const MINUUT = 60000;

const gegevens = { meta: null, stations: [], reeksen: {}, netwerk: null };
let huidigAdres = null;

const el = (id) => document.getElementById(id);
const maakEl = (naam, klasse, tekst) => {
  const knoop = document.createElement(naam);
  if (klasse) knoop.className = klasse;
  if (tekst != null) knoop.textContent = tekst;
  return knoop;
};

/* ------------------------------------------------------------ opmaakhulpjes */

const nlGetal = (waarde, decimalen = 0) =>
  waarde == null || Number.isNaN(waarde)
    ? '–'
    : waarde.toLocaleString('nl-NL', { minimumFractionDigits: decimalen, maximumFractionDigits: decimalen });

const meter = (waarde, decimalen = 2) => (waarde == null ? '–' : `${nlGetal(waarde, decimalen)} m`);

function tijdTekst(datum) {
  return datum.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
}

function datumTijdTekst(datum) {
  return datum.toLocaleString('nl-NL', {
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

function geledenTekst(datum) {
  const minuten = Math.round((Date.now() - datum.getTime()) / MINUUT);
  if (minuten < 1) return 'zojuist';
  if (minuten < 60) return `${minuten} minuut${minuten === 1 ? '' : 'en'} geleden`;
  const uren = Math.floor(minuten / 60);
  if (uren < 24) return `${uren} uur geleden`;
  const dagen = Math.floor(uren / 24);
  return `${dagen} dag${dagen === 1 ? '' : 'en'} geleden`;
}

function duurTekst(uren) {
  if (uren == null) return '–';
  if (uren < 1) return `${Math.round(uren * 60)} minuten`;
  const heel = Math.floor(uren);
  const minuten = Math.round((uren - heel) * 60);
  if (heel < 24) return minuten ? `${heel} uur en ${minuten} min` : `${heel} uur`;
  const dagen = Math.floor(heel / 24);
  const rest = heel % 24;
  return rest ? `${dagen} dag${dagen === 1 ? '' : 'en'} en ${rest} uur` : `${dagen} dag${dagen === 1 ? '' : 'en'}`;
}

function trendTekst(cmPerUur) {
  if (cmPerUur == null) return 'onbekend';
  if (Math.abs(cmPerUur) < 0.5) return 'vrijwel gelijk';
  const richting = cmPerUur > 0 ? 'stijgt' : 'daalt';
  return `${richting} ${nlGetal(Math.abs(cmPerUur), 1)} cm per uur`;
}

function trendPijl(cmPerUur) {
  if (cmPerUur == null || Math.abs(cmPerUur) < 0.5) return '→';
  return cmPerUur > 0 ? '↑' : '↓';
}

function afstandTekst(km) {
  return km < 1 ? `${Math.round(km * 1000)} m` : `${nlGetal(km, 1)} km`;
}

function afstandKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const naarRad = (g) => (g * Math.PI) / 180;
  const dLat = naarRad(lat2 - lat1);
  const dLon = naarRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(naarRad(lat1)) * Math.cos(naarRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/* -------------------------------------------------------------- gegevens laden */

async function haalJson(pad) {
  const res = await fetch(pad, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${pad}: ${res.status}`);
  return res.json();
}

async function ladenGegevens() {
  const [meta, stations] = await Promise.all([haalJson('data/meta.json'), haalJson('data/stations.json')]);
  gegevens.meta = meta;
  gegevens.stations = stations;

  const moment = new Date(meta.gegenereerd);
  el('ververst').textContent = `Bijgewerkt ${tijdTekst(moment)} · ${geledenTekst(moment)}`;
  el('voetstempel').textContent =
    `Momentopname van ${datumTijdTekst(moment)} met ${meta.aantalStations} actieve meetpunten, ` +
    `waarvan ${meta.aantalVerwachtingen} met een officiële verwachting van Rijkswaterstaat ` +
    `en ${meta.aantalAfgeleid} met een verwachting die is afgeleid van bovenstroomse meetpunten.`;

  toonStijgers();
  toonLandkaart();

  const [reeksen, netwerk] = await Promise.all([haalJson('data/reeksen.json'), haalJson('data/netwerk.json')]);
  gegevens.reeksen = reeksen;
  gegevens.netwerk = netwerk;
  toonNetwerk();
  if (huidigAdres) beoordeel(huidigAdres);
}

/* Zet de compacte reeksen om naar punten met echte tijdstippen en meters t.o.v. NAP. */
function reeksVan(code, soort) {
  const rij = gegevens.reeksen[code]?.[soort];
  if (!rij) return null;
  const basis = gegevens.meta.basisTijd;
  return rij.map(([minuten, cm]) => ({ t: basis + minuten * MINUUT, m: cm / 100 }));
}

/* ------------------------------------------------------------------- zoeken */

let zoekTeller = 0;
let suggestieLijst = [];
let gemarkeerd = -1;

async function zoekSuggesties(tekst) {
  const eigenTeller = ++zoekTeller;
  const url = `${PDOK_ZOEK}/free?q=${encodeURIComponent(tekst)}&rows=6` +
    `&fq=type:(adres OR postcode OR woonplaats OR weg)&fl=id,weergavenaam,centroide_ll,type`;
  const data = await haalJson(url);
  if (eigenTeller !== zoekTeller) return null;
  return (data.response?.docs || [])
    .map((doc) => {
      const punt = /POINT\(([-\d.]+) ([-\d.]+)\)/.exec(doc.centroide_ll || '');
      if (!punt) return null;
      return { naam: doc.weergavenaam, soort: doc.type, lon: parseFloat(punt[1]), lat: parseFloat(punt[2]) };
    })
    .filter(Boolean);
}

function toonSuggesties(lijst) {
  const bak = el('suggesties');
  bak.replaceChildren();
  suggestieLijst = lijst || [];
  gemarkeerd = -1;
  if (!suggestieLijst.length) {
    bak.hidden = true;
    el('adres').setAttribute('aria-expanded', 'false');
    return;
  }
  suggestieLijst.forEach((item, i) => {
    const regel = maakEl('li');
    regel.id = `suggestie-${i}`;
    regel.setAttribute('role', 'option');
    regel.append(document.createTextNode(item.naam), maakEl('span', 'soort', item.soort));
    regel.addEventListener('mousedown', (e) => { e.preventDefault(); kiesAdres(item); });
    bak.append(regel);
  });
  bak.hidden = false;
  el('adres').setAttribute('aria-expanded', 'true');
}

function markeer(richting) {
  if (!suggestieLijst.length) return;
  gemarkeerd = (gemarkeerd + richting + suggestieLijst.length) % suggestieLijst.length;
  [...el('suggesties').children].forEach((knoop, i) =>
    knoop.setAttribute('aria-selected', String(i === gemarkeerd)));
  el('adres').setAttribute('aria-activedescendant', `suggestie-${gemarkeerd}`);
}

function meldFout(bericht) {
  const knoop = el('zoekfout');
  knoop.textContent = bericht || '';
  knoop.hidden = !bericht;
}

async function kiesAdres(item) {
  toonSuggesties([]);
  el('adres').value = item.naam;
  meldFout('');
  el('resultaat').hidden = false;
  el('oordeel').className = 'oordeel niveau-onbekend';
  el('oordeel').replaceChildren(maakEl('h2', null, 'Bezig met berekenen…'),
    maakEl('p', null, 'De maaiveldhoogte wordt opgehaald uit het Actueel Hoogtebestand Nederland.'));
  el('resultaat').scrollIntoView({ behavior: 'smooth', block: 'start' });

  let maaiveld = null;
  try {
    maaiveld = await haalMaaiveld(item.lat, item.lon);
  } catch (fout) {
    console.warn('Maaiveldhoogte kon niet worden opgehaald', fout);
  }
  huidigAdres = { ...item, maaiveld };
  beoordeel(huidigAdres);
}

/* --------------------------------------------- maaiveldhoogte uit het AHN */

async function hoogteOpPunt(lat, lon) {
  const d = 0.00002;
  const params = new URLSearchParams({
    SERVICE: 'WMS', VERSION: '1.3.0', REQUEST: 'GetFeatureInfo',
    LAYERS: 'dtm_05m', QUERY_LAYERS: 'dtm_05m', CRS: 'CRS:84',
    BBOX: `${lon - d},${lat - d},${lon + d},${lat + d}`,
    WIDTH: '3', HEIGHT: '3', I: '1', J: '1', INFO_FORMAT: 'application/json',
  });
  const data = await haalJson(`${AHN_WMS}?${params}`);
  const ruw = data.features?.[0]?.properties?.value_list;
  if (ruw == null) return null;
  const waarde = parseFloat(String(ruw).trim().split(/\s+/)[0]);
  return Number.isFinite(waarde) && Math.abs(waarde) < 500 ? waarde : null;
}

/* Het AHN heeft gaten waar gebouwen zijn weggefilterd; daarom meerdere punten
   rond het adres bemonsteren en de mediaan nemen. */
async function haalMaaiveld(lat, lon) {
  const verschuiving = 0.00018; // ongeveer 20 meter
  const punten = [
    [lat, lon],
    [lat + verschuiving, lon], [lat - verschuiving, lon],
    [lat, lon + verschuiving * 1.6], [lat, lon - verschuiving * 1.6],
  ];
  const uitkomsten = await Promise.all(punten.map(([a, b]) => hoogteOpPunt(a, b).catch(() => null)));
  const geldig = uitkomsten.filter((w) => w != null).sort((a, b) => a - b);
  if (!geldig.length) return null;
  const midden = Math.floor(geldig.length / 2);
  const mediaan = geldig.length % 2 ? geldig[midden] : (geldig[midden - 1] + geldig[midden]) / 2;
  return { hoogte: mediaan, metingen: geldig.length, laagste: geldig[0], hoogste: geldig.at(-1) };
}

/* ------------------------------------------------------------- beoordeling */

function dichtstbijzijnde(lat, lon, aantal = 3) {
  return gegevens.stations
    .map((s) => ({ station: s, km: afstandKm(lat, lon, s.lat, s.lon) }))
    .sort((a, b) => a.km - b.km)
    .slice(0, aantal);
}

/* Bepaalt wanneer het water voor het eerst boven een grens uitkomt. */
function eersteOverschrijding(reeks, grensMeter) {
  if (!reeks) return null;
  for (const punt of reeks) if (punt.t > Date.now() && punt.m >= grensMeter) return punt;
  return null;
}

function beoordeel(adres) {
  const buren = dichtstbijzijnde(adres.lat, adres.lon, 3);
  if (!buren.length) {
    el('oordeel').className = 'oordeel niveau-onbekend';
    el('oordeel').replaceChildren(maakEl('h2', null, 'Geen meetpunten beschikbaar'));
    return;
  }
  const dichtstbij = buren[0];
  const station = dichtstbij.station;
  const meting = reeksVan(station.c, 'm');
  const verwachting = reeksVan(station.c, 'v');
  const soortVerwachting = gegevens.reeksen[station.c]?.vs;
  const waterNu = station.v / 100;
  const maaiveld = adres.maaiveld?.hoogte ?? null;
  const marge = maaiveld == null ? null : maaiveld - waterNu;

  const toekomst = (verwachting || []).filter((p) => p.t >= Date.now());
  const hoogsteVerwacht = toekomst.length ? Math.max(...toekomst.map((p) => p.m)) : null;
  const hoogstePunt = toekomst.find((p) => p.m === hoogsteVerwacht) || null;
  const overschrijding = maaiveld == null ? null : eersteOverschrijding(toekomst, maaiveld);
  const kleinsteMarge = maaiveld == null || hoogsteVerwacht == null ? null : maaiveld - hoogsteVerwacht;

  toonOordeel({ adres, station, dichtstbij, marge, maaiveld, waterNu, overschrijding, kleinsteMarge, hoogsteVerwacht, hoogstePunt });
  toonAdresFeiten(adres, dichtstbij, maaiveld);
  toonMeetpuntFeiten(station, dichtstbij, soortVerwachting, hoogsteVerwacht, hoogstePunt, buren);
  tekenGrafiek({ meting, verwachting, maaiveld, soortVerwachting, station });
  toonBovenstrooms(station);
  toonBerekening(station, adres, soortVerwachting);
  toonGeschiedenis(station, maaiveld).catch((fout) => console.warn('Archief niet beschikbaar', fout));
}

function toonOordeel(g) {
  const bak = el('oordeel');
  bak.replaceChildren();
  let niveau = 'onbekend';
  let kop = 'Beoordeling niet mogelijk';
  let verhaal = '';

  if (g.maaiveld == null) {
    verhaal = 'De hoogte van de grond op dit adres kon niet worden opgehaald uit het Actueel Hoogtebestand ' +
      'Nederland. Zonder maaiveldhoogte is er geen marge te berekenen. De waterstand en de verwachting ' +
      'hieronder kloppen wel.';
  } else if (g.marge <= 0) {
    niveau = 'alarm';
    kop = 'Het water staat hoger dan de grond op dit adres';
    verhaal = `Het open water bij ${g.station.n} staat nu ${meter(Math.abs(g.marge))} boven het maaiveld ` +
      `van dit adres. Als dit adres buitendijks ligt, staat het gebied waarschijnlijk onder water. ` +
      `Ligt het achter een dijk, dan houdt de waterkering het water tegen.`;
  } else if (g.overschrijding) {
    niveau = 'alarm';
    kop = 'Het water komt naar verwachting boven het maaiveld uit';
    const uren = (g.overschrijding.t - Date.now()) / 3600000;
    verhaal = `Volgens de verwachting bereikt het water bij ${g.station.n} het niveau van het maaiveld ` +
      `over ongeveer ${duurTekst(uren)}, rond ${datumTijdTekst(new Date(g.overschrijding.t))}. ` +
      `Nu is er nog ${meter(g.marge)} ruimte.`;
  } else if (g.kleinsteMarge != null && g.kleinsteMarge < 0.5) {
    niveau = 'let-op';
    kop = 'Weinig ruimte tussen water en maaiveld';
    verhaal = `Op het hoogste punt van de verwachting blijft er nog ${meter(g.kleinsteMarge)} over tot het ` +
      `maaiveld. Dat is weinig marge; houd de ontwikkeling in de gaten.`;
  } else if (g.marge < 1.5) {
    niveau = 'let-op';
    kop = 'Beperkte marge tot het maaiveld';
    verhaal = `De grond ligt ${meter(g.marge)} boven de huidige waterstand bij ${g.station.n}. ` +
      (g.kleinsteMarge != null
        ? `In de verwachting voor de komende twee dagen blijft er minimaal ${meter(g.kleinsteMarge)} over.`
        : 'Voor dit meetpunt is geen verwachting beschikbaar.');
  } else {
    niveau = 'rustig';
    kop = 'Ruime marge tussen water en maaiveld';
    verhaal = `De grond ligt ${meter(g.marge)} boven de huidige waterstand bij ${g.station.n}. ` +
      (g.kleinsteMarge != null
        ? `Ook bij de hoogste verwachte stand blijft er ${meter(g.kleinsteMarge)} over.`
        : 'Voor dit meetpunt is geen verwachting beschikbaar.');
  }

  bak.className = `oordeel niveau-${niveau}`;
  bak.append(maakEl('h2', null, kop), maakEl('p', null, verhaal));
  if (g.maaiveld != null) {
    const regel = maakEl('p', 'marge');
    regel.textContent =
      `Maaiveld ${meter(g.maaiveld)} NAP · water nu ${meter(g.waterNu)} NAP · ` +
      `verschil ${meter(g.marge)}` +
      (g.hoogsteVerwacht != null ? ` · hoogst verwacht ${meter(g.hoogsteVerwacht)} NAP` : '');
    bak.append(regel);
  }
}

function feitenLijst(paren) {
  const lijst = maakEl('dl', 'feiten');
  for (const [naam, waarde] of paren) {
    if (waarde == null) continue;
    lijst.append(maakEl('dt', null, naam));
    const dd = maakEl('dd');
    if (waarde instanceof Node) dd.append(waarde); else dd.textContent = waarde;
    lijst.append(dd);
  }
  return lijst;
}

function toonAdresFeiten(adres, dichtstbij, maaiveld) {
  const bak = el('adresfeiten');
  bak.replaceChildren(maakEl('h3', null, 'Het adres'));
  const spreiding = adres.maaiveld
    ? `${meter(adres.maaiveld.laagste)} tot ${meter(adres.maaiveld.hoogste)} NAP (${adres.maaiveld.metingen} punten)`
    : null;
  bak.append(feitenLijst([
    ['Locatie', adres.naam],
    ['Maaiveldhoogte', maaiveld == null ? 'niet beschikbaar' : `${meter(maaiveld)} boven NAP`],
    ['Spreiding in de omgeving', spreiding],
    ['Coördinaten', `${nlGetal(adres.lat, 4)}° NB, ${nlGetal(adres.lon, 4)}° OL`],
    ['Dichtstbijzijnde meetpunt', `${dichtstbij.station.n} (${afstandTekst(dichtstbij.km)})`],
  ]));
  const noot = maakEl('p', 'hulp',
    'De maaiveldhoogte is de mediaan van vijf metingen uit het Actueel Hoogtebestand Nederland ' +
    '(maaiveldmodel, 0,5 meter) rond het adres. Gebouwen zitten niet in dat model.');
  bak.append(noot);
}

function toonMeetpuntFeiten(station, dichtstbij, soortVerwachting, hoogsteVerwacht, hoogstePunt, buren) {
  const bak = el('meetpuntfeiten');
  bak.replaceChildren(maakEl('h3', null, 'Het maatgevende meetpunt'));

  const klasse = maakEl('span', 'speld', station.kl || 'geen klasse-indeling');
  if (station.kle) {
    klasse.style.background = station.kle;
    klasse.style.color = '#fff';
  }
  const gemeten = new Date(station.t);

  bak.append(feitenLijst([
    ['Meetpunt', station.n],
    ['Waterstand nu', `${meter(station.v / 100)} NAP`],
    ['Gemeten', `${tijdTekst(gemeten)} (${geledenTekst(gemeten)})`],
    ['Verandering', `${trendPijl(station.tr)} ${trendTekst(station.tr)}`],
    ['Laatste 30 uur', station.min30 == null ? null : `${meter(station.min30 / 100)} tot ${meter(station.max30 / 100)} NAP`],
    ['Klasse van Rijkswaterstaat', klasse],
    ['Hoogst verwacht', hoogsteVerwacht == null ? 'geen verwachting beschikbaar'
      : `${meter(hoogsteVerwacht)} NAP${hoogstePunt ? ` rond ${datumTijdTekst(new Date(hoogstePunt.t))}` : ''}`],
    ['Soort verwachting', soortVerwachting === 'officieel' ? 'officiële verwachting van Rijkswaterstaat'
      : soortVerwachting === 'afgeleid' ? 'afgeleid van een bovenstrooms meetpunt' : null],
  ]));

  const andere = buren.slice(1);
  if (andere.length) {
    const p = maakEl('p', 'hulp');
    p.textContent = 'Andere meetpunten in de buurt: ' +
      andere.map((b) => `${b.station.n} (${afstandTekst(b.km)}, ${meter(b.station.v / 100)} NAP)`).join(', ') + '.';
    bak.append(p);
  }
}

/* ---------------------------------------------------------------- grafiek */

const laatsteGrafieken = new Map();

function tekenGrafiek(opties) {
  const { doel = 'grafiek', legendaDoel = 'grafieklegenda', meting, verwachting, band,
    maaiveld, soortVerwachting, station, moment, toonNu = true, leegTekst } = opties;
  laatsteGrafieken.set(doel, opties);
  const bak = el(doel);
  bak.replaceChildren();
  const punten = [...(meting || []), ...(verwachting || []),
    ...(band || []).flatMap((p) => [{ t: p.t, m: p.lo }, { t: p.t, m: p.hi }])];
  if (!punten.length) {
    bak.append(maakEl('p', 'hulp', leegTekst || 'Voor dit meetpunt is geen reeks beschikbaar.'));
    el(legendaDoel).replaceChildren();
    return;
  }

  const breedte = bak.clientWidth || 880;
  const smal = breedte < 560;
  const B = Math.max(300, Math.min(Math.round(breedte), 900));
  const H = smal ? 250 : 340;
  const tekst = smal ? 11 : 12;
  const marge = { boven: smal ? 24 : 30, rechts: smal ? 8 : 16, onder: smal ? 34 : 40, links: smal ? 42 : 62 };
  const bx = B - marge.links - marge.rechts;
  const by = H - marge.boven - marge.onder;

  const tMin = Math.min(...punten.map((p) => p.t));
  const tMax = Math.max(...punten.map((p) => p.t));
  let yMin = Math.min(...punten.map((p) => p.m));
  let yMax = Math.max(...punten.map((p) => p.m));
  if (maaiveld != null && maaiveld > yMin - 6 && maaiveld < yMax + 6) {
    yMin = Math.min(yMin, maaiveld - 0.3);
    yMax = Math.max(yMax, maaiveld + 0.3);
  }
  const speling = Math.max(0.15, (yMax - yMin) * 0.12);
  yMin -= speling; yMax += speling;

  const x = (t) => marge.links + ((t - tMin) / (tMax - tMin || 1)) * bx;
  const y = (m) => marge.boven + by - ((m - yMin) / (yMax - yMin || 1)) * by;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${B} ${H}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label',
    `Verloop van de waterstand bij ${station.n} van ${datumTijdTekst(new Date(tMin))} tot ${datumTijdTekst(new Date(tMax))}.`);
  const ns = (naam, kenmerken) => {
    const k = document.createElementNS('http://www.w3.org/2000/svg', naam);
    for (const [sleutel, waarde] of Object.entries(kenmerken)) k.setAttribute(sleutel, waarde);
    return k;
  };

  // horizontale hulplijnen met hoogte in meters
  const stappen = smal ? 4 : 5;
  for (let i = 0; i <= stappen; i++) {
    const waarde = yMin + ((yMax - yMin) * i) / stappen;
    const yy = y(waarde);
    svg.append(ns('line', { x1: marge.links, x2: B - marge.rechts, y1: yy, y2: yy, stroke: 'currentColor', 'stroke-opacity': .12 }));
    const label = ns('text', { x: marge.links - 6, y: yy + 4, 'text-anchor': 'end', 'font-size': tekst, fill: 'currentColor', 'fill-opacity': .65 });
    label.textContent = nlGetal(waarde, 1);
    svg.append(label);
  }
  const asTitel = ns('text', { x: 2, y: 12, 'font-size': tekst, fill: 'currentColor', 'fill-opacity': .65 });
  asTitel.textContent = smal ? 'm NAP' : 'meter t.o.v. NAP';
  svg.append(asTitel);

  // dagscheiding en tijdlabels
  const spanUren = (tMax - tMin) / 3600000;
  const stapUren = spanUren > 24 * 40 ? 24 * 14 : spanUren > 24 * 7 ? 24 * 2 : spanUren > 24 * 2 ? (smal ? 24 : 12) : smal ? 12 : 6;
  const stapMs = stapUren * 3600000;
  for (let t = Math.ceil(tMin / stapMs) * stapMs; t <= tMax; t += stapMs) {
    const xx = x(t);
    const datum = new Date(t);
    const middernacht = datum.getHours() === 0;
    svg.append(ns('line', { x1: xx, x2: xx, y1: marge.boven, y2: marge.boven + by, stroke: 'currentColor', 'stroke-opacity': middernacht ? .2 : .07 }));
    if (xx < marge.links + 8 || xx > B - marge.rechts - 8) continue;
    const langeReeks = stapUren >= 24;
    const label = ns('text', { x: xx, y: H - (langeReeks ? 12 : 22), 'text-anchor': 'middle', 'font-size': tekst, fill: 'currentColor', 'fill-opacity': .7 });
    label.textContent = langeReeks
      ? datum.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' })
      : tijdTekst(datum);
    svg.append(label);
    if (middernacht && !langeReeks) {
      const dagLabel = ns('text', { x: xx, y: H - 6, 'text-anchor': 'middle', 'font-size': tekst - 1, fill: 'currentColor', 'fill-opacity': .55 });
      dagLabel.textContent = datum.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' });
      svg.append(dagLabel);
    }
  }

  // maaiveld en overstroomd vlak
  if (maaiveld != null && maaiveld >= yMin && maaiveld <= yMax) {
    svg.append(ns('rect', {
      x: marge.links, y: marge.boven, width: bx, height: Math.max(0, y(maaiveld) - marge.boven),
      fill: '#b3241c', 'fill-opacity': .07,
    }));
    svg.append(ns('line', {
      x1: marge.links, x2: B - marge.rechts, y1: y(maaiveld), y2: y(maaiveld),
      stroke: '#b3241c', 'stroke-width': 2, 'stroke-dasharray': '7 5',
    }));
    const label = ns('text', { x: marge.links + 5, y: Math.max(marge.boven + 11, y(maaiveld) - 6), 'font-size': tekst, fill: '#b3241c' });
    label.textContent = smal ? `maaiveld ${meter(maaiveld)}` : `maaiveld ${meter(maaiveld)} NAP`;
    svg.append(label);
  }

  const pad = (reeks) => reeks.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)} ${y(p.m).toFixed(1)}`).join(' ');

  // De bandbreedte tussen het laagste en het hoogste kwartier binnen elk uur.
  if (band?.length) {
    const boven = band.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)} ${y(p.hi).toFixed(1)}`).join(' ');
    const onder = [...band].reverse().map((p) => `L${x(p.t).toFixed(1)} ${y(p.lo).toFixed(1)}`).join(' ');
    svg.append(ns('path', { d: `${boven} ${onder} Z`, fill: '#0d6b73', 'fill-opacity': .22, stroke: 'none' }));
    svg.append(ns('path', { d: band.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)} ${y(p.hi).toFixed(1)}`).join(' '),
      fill: 'none', stroke: '#0d6b73', 'stroke-width': 1.6, 'stroke-linejoin': 'round' }));
  }

  if (meting?.length) {
    svg.append(ns('path', { d: pad(meting), fill: 'none', stroke: '#0d6b73', 'stroke-width': 2.4, 'stroke-linejoin': 'round' }));
  }
  if (verwachting?.length) {
    svg.append(ns('path', {
      d: pad(verwachting), fill: 'none', stroke: '#0b8a7a', 'stroke-width': 2.4,
      'stroke-dasharray': soortVerwachting === 'afgeleid' ? '4 5' : '10 6', 'stroke-linejoin': 'round',
    }));
  }

  // markering voor het gekozen moment
  if (moment != null && moment >= tMin && moment <= tMax) {
    svg.append(ns('line', { x1: x(moment), x2: x(moment), y1: marge.boven, y2: marge.boven + by,
      stroke: 'var(--accent, #b3630a)', 'stroke-width': 2 }));
  }

  // markering voor "nu"
  const nu = Date.now();
  if (toonNu && nu >= tMin && nu <= tMax) {
    svg.append(ns('line', { x1: x(nu), x2: x(nu), y1: marge.boven, y2: marge.boven + by, stroke: 'currentColor', 'stroke-opacity': .45, 'stroke-width': 1.5 }));
    const label = ns('text', { x: x(nu) + 4, y: marge.boven + 11, 'font-size': tekst, fill: 'currentColor', 'fill-opacity': .7 });
    label.textContent = 'nu';
    svg.append(label);
  }

  bak.append(svg);

  const legenda = el(legendaDoel);
  legenda.replaceChildren();
  const item = (kleur, tekst, streep) => {
    const s = maakEl('span');
    const i = maakEl('i');
    i.style.background = streep ? 'transparent' : kleur;
    if (streep) i.style.borderTop = `3px dashed ${kleur}`;
    s.append(i, document.createTextNode(tekst));
    return s;
  };
  if (band?.length) legenda.append(item('#0d6b73', 'gemeten hoogste en laagste stand per uur'));
  if (meting?.length) legenda.append(item('#0d6b73', 'gemeten waterstand'));
  if (verwachting?.length) {
    legenda.append(item('#0b8a7a',
      soortVerwachting === 'afgeleid'
        ? 'verwachting afgeleid van bovenstrooms meetpunt'
        : 'officiële verwachting van Rijkswaterstaat', true));
  }
  if (maaiveld != null) legenda.append(item('#b3241c', 'maaiveld op dit adres', true));
}

/* -------------------------------------------------------- bovenstrooms beeld */

function toonBovenstrooms(station) {
  const bak = el('bovenstroomsblok');
  bak.replaceChildren(maakEl('h3', null, 'Wat er bovenstrooms aankomt'));
  const relaties = (gegevens.netwerk?.relaties || []).filter((r) => r.beneden === station.c);

  if (station.bron && !relaties.some((r) => r.boven === station.bron.bron)) {
    const bronStation = gegevens.stations.find((s) => s.c === station.bron.bron);
    if (bronStation) {
      const p = maakEl('p', 'uitleg');
      p.textContent =
        `De verwachting voor dit meetpunt is afgeleid van ${bronStation.n}` +
        (station.bron.afstandKm != null ? ` (${nlGetal(station.bron.afstandKm, 1)} km verderop)` : '') +
        `. Dat meetpunt loopt ${station.bron.vertragingUur >= 0 ? 'voor' : 'achter'} met ` +
        `${duurTekst(Math.abs(station.bron.vertragingUur))}; de correlatie tussen beide reeksen is ` +
        `${nlGetal(station.bron.correlatie, 2)} en de doorwerking ${nlGetal(station.bron.versterking * 100, 0)}%.`;
      bak.append(p);
    }
  }

  if (!relaties.length) {
    if (!station.bron) {
      bak.append(maakEl('p', 'uitleg',
        `${station.n} ligt niet in een van de doorgerekende riviervakken, of er is te weinig ` +
        'gemeten data om een betrouwbare relatie met een ander meetpunt te bepalen.'));
    }
    return;
  }

  bak.append(maakEl('p', 'uitleg',
    'Deze meetpunten liggen stroomopwaarts. De vertraging en de doorwerking zijn berekend uit de ' +
    'gemeten reeksen van de afgelopen week; de correlatie geeft aan hoe goed die relatie past.'));

  const lijst = maakEl('div', 'schakels');
  for (const rel of relaties) {
    const boven = gegevens.stations.find((s) => s.c === rel.boven);
    if (!boven) continue;
    const blok = maakEl('div', 'schakel');
    const naam = maakEl('b', null, boven.n);
    blok.append(naam, maakEl('br'));
    blok.append(document.createTextNode(
      `${meter(boven.v / 100)} NAP · ${trendPijl(boven.tr)} ${trendTekst(boven.tr)}`));
    blok.append(maakEl('br'));
    const detail = maakEl('span', 'zwak',
      `komt hier aan na ${duurTekst(rel.vertragingUur)} · doorwerking ${nlGetal(rel.versterking * 100, 0)}% · ` +
      `correlatie ${nlGetal(rel.correlatie, 2)}`);
    blok.append(detail);
    lijst.append(blok);
  }
  bak.append(lijst);

  const sterkste = relaties.filter((r) => r.correlatie >= 0.6);
  if (sterkste.length) {
    const rel = sterkste[0];
    const boven = gegevens.stations.find((s) => s.c === rel.boven);
    if (boven?.tr != null && Math.abs(boven.tr) >= 0.5) {
      const effect = boven.tr * rel.versterking;
      const p = maakEl('p', 'hulp');
      p.textContent =
        `Op dit moment ${boven.tr > 0 ? 'stijgt' : 'daalt'} het water bij ${boven.n} met ` +
        `${nlGetal(Math.abs(boven.tr), 1)} cm per uur. Met de gemeten doorwerking betekent dat hier ` +
        `over ongeveer ${duurTekst(rel.vertragingUur)} een verandering van ongeveer ` +
        `${nlGetal(Math.abs(effect), 1)} cm per uur ${effect > 0 ? 'omhoog' : 'omlaag'}.`;
      bak.append(p);
    }
  }
}

function toonBerekening(station, adres, soortVerwachting) {
  const bak = el('berekeningblok');
  bak.replaceChildren(maakEl('h3', null, 'Hoe deze beoordeling tot stand komt'));
  const lijst = maakEl('ul');
  const punten = [
    `De waterstand komt van meetpunt ${station.n} van Rijkswaterstaat, het dichtstbijzijnde actieve ` +
    'meetpunt voor waterhoogte. Alle hoogtes zijn uitgedrukt ten opzichte van NAP.',
    soortVerwachting === 'officieel'
      ? 'De verwachting voor de komende twee dagen is de officiële verwachting die Rijkswaterstaat voor ' +
        'dit meetpunt publiceert.'
      : soortVerwachting === 'afgeleid'
        ? 'Rijkswaterstaat publiceert voor dit meetpunt geen eigen verwachting. De getoonde verwachting is ' +
          'afgeleid: de verandering bij het bovenstroomse meetpunt wordt overgenomen, vertraagd met de uit ' +
          'de meetreeksen berekende looptijd en geschaald met de gemeten doorwerking.'
        : 'Voor dit meetpunt is geen verwachting beschikbaar; alleen de meting wordt getoond.',
    'De maaiveldhoogte komt uit het Actueel Hoogtebestand Nederland (maaiveldmodel met een resolutie van ' +
    '0,5 meter), opgevraagd via PDOK. Rond het adres worden vijf punten bemonsterd en daarvan wordt de ' +
    'mediaan genomen, omdat gebouwen uit dat model zijn weggefilterd.',
    'De marge is het verschil tussen de maaiveldhoogte en de waterstand. Er wordt geen rekening gehouden ' +
    'met dijken, duinen, keringen, gemalen, opstuwing door wind of golfoverslag.',
  ];
  for (const tekst of punten) lijst.append(maakEl('li', null, tekst));
  bak.append(lijst);
}

/* ------------------------------------------------------------ geschiedenis */

const archief = { index: null, reeksen: new Map() };
let geschiedenisStand = { station: null, maaiveld: null, uren: 168, moment: null };

async function haalArchiefIndex() {
  if (archief.index) return archief.index;
  try { archief.index = await haalJson('data/archief/index.json'); }
  catch { archief.index = { meetpunten: {}, van: null, tot: null }; }
  return archief.index;
}

async function haalArchief(code) {
  if (archief.reeksen.has(code)) return archief.reeksen.get(code);
  let reeks = null;
  try {
    const ruw = await haalJson(`data/archief/${encodeURIComponent(code)}.json`);
    reeks = [];
    for (let i = 0; i < ruw.mn.length; i++) {
      if (ruw.mn[i] == null) continue;
      reeks.push({ t: ruw.van + i * ruw.stap, lo: ruw.mn[i] / 100, hi: ruw.mx[i] / 100 });
    }
  } catch { reeks = null; }
  archief.reeksen.set(code, reeks);
  return reeks;
}

/* Zoekt de perioden waarin het water boven een grens uitkwam. Uren die binnen een
   etmaal van elkaar liggen horen bij dezelfde periode: als het water rond het maaiveld
   schommelt is dat één hoogwater, geen tientallen losse gevallen. Heel korte en heel
   kleine overschrijdingen worden niet als aparte periode geteld, want die liggen binnen
   de meetnauwkeurigheid en binnen de spreiding van de maaiveldhoogte. */
const SAMENVOEGGAT = 24 * 3600000;
const MINSTE_DUUR = 2 * 3600000;
const MINSTE_HOOGTE = 0.05;

function zoekOverschrijdingen(reeks, grensMeter) {
  const ruw = [];
  let huidig = null;
  for (const punt of reeks) {
    if (punt.hi >= grensMeter) {
      if (huidig && punt.t - huidig.eind <= SAMENVOEGGAT) {
        huidig.eind = punt.t;
        if (punt.hi > huidig.piek) { huidig.piek = punt.hi; huidig.piekTijd = punt.t; }
      } else {
        if (huidig) ruw.push(huidig);
        huidig = { begin: punt.t, eind: punt.t, piek: punt.hi, piekTijd: punt.t };
      }
    }
  }
  if (huidig) ruw.push(huidig);
  return ruw.filter((g) => g.eind - g.begin >= MINSTE_DUUR || g.piek - grensMeter >= MINSTE_HOOGTE);
}

async function toonGeschiedenis(station, maaiveld) {
  geschiedenisStand = { ...geschiedenisStand, station, maaiveld };
  const bak = el('geschiedenisblok');
  const uitleg = el('archiefuitleg');
  const index = await haalArchiefIndex();
  const info = index.meetpunten?.[station.c];

  if (!info) {
    uitleg.textContent =
      'Het meetarchief voor dit meetpunt wordt nog opgebouwd. Het vult zich elke nacht verder aan ' +
      'met oudere metingen van Rijkswaterstaat; kom later terug om verder terug te kunnen kijken.';
    el('geschiedenisgrafiek').replaceChildren();
    el('geschiedenislegenda').replaceChildren();
    el('overstromingen').replaceChildren();
    el('moment').disabled = true;
    return;
  }

  const reeks = await haalArchief(station.c);
  if (!reeks?.length) {
    uitleg.textContent = 'Het archief van dit meetpunt kon niet worden geladen.';
    return;
  }

  el('moment').disabled = false;
  const van = new Date(reeks[0].t), tot = new Date(reeks.at(-1).t);
  uitleg.textContent =
    `Het archief van ${station.n} loopt van ${datumTekst(van)} tot ${datumTekst(tot)} en bevat per uur ` +
    'de hoogste en de laagste gemeten stand. Kies een moment of een periode om terug te kijken.';

  const invoer = el('moment');
  invoer.min = naarInvoerTijd(van);
  invoer.max = naarInvoerTijd(tot);
  if (!geschiedenisStand.moment) {
    geschiedenisStand.moment = Math.min(Date.now(), reeks.at(-1).t);
    invoer.value = naarInvoerTijd(new Date(geschiedenisStand.moment));
  }

  tekenGeschiedenis();
  toonOverstromingen(reeks, maaiveld, station);
}

function naarInvoerTijd(datum) {
  const p = (n) => String(n).padStart(2, '0');
  return `${datum.getFullYear()}-${p(datum.getMonth() + 1)}-${p(datum.getDate())}T${p(datum.getHours())}:${p(datum.getMinutes())}`;
}

function datumTekst(datum) {
  return datum.toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' });
}

function tekenGeschiedenis() {
  const { station, maaiveld, uren, moment } = geschiedenisStand;
  if (!station) return;
  const reeks = archief.reeksen.get(station.c);
  if (!reeks?.length) return;

  let venster = reeks;
  if (uren > 0) {
    const halve = (uren / 2) * 3600000;
    venster = reeks.filter((p) => p.t >= moment - halve && p.t <= moment + halve);
    if (venster.length < 3) venster = reeks.slice(-Math.min(reeks.length, uren));
  }

  tekenGrafiek({
    doel: 'geschiedenisgrafiek',
    legendaDoel: 'geschiedenislegenda',
    band: venster,
    maaiveld,
    station,
    moment,
    toonNu: false,
    leegTekst: 'Voor deze periode staan er geen metingen in het archief.',
  });

  // Wat stond het water op het gekozen moment?
  const dichtstbij = reeks.reduce((beste, p) =>
    Math.abs(p.t - moment) < Math.abs(beste.t - moment) ? p : beste, reeks[0]);
  const regel = el('momentwaarde');
  if (Math.abs(dichtstbij.t - moment) > 6 * 3600000) {
    regel.textContent = 'Voor het gekozen moment staat er niets in het archief.';
    return;
  }
  const stukken = [
    `Op ${datumTijdTekst(new Date(dichtstbij.t))} stond het water tussen ${meter(dichtstbij.lo)} en ` +
    `${meter(dichtstbij.hi)} NAP`,
  ];
  if (maaiveld != null) {
    const marge = maaiveld - dichtstbij.hi;
    stukken.push(marge >= 0
      ? `dat is ${meter(marge)} onder uw maaiveld`
      : `dat is ${meter(Math.abs(marge))} boven uw maaiveld`);
  }
  regel.textContent = stukken.join(' — ') + '.';
}

function toonOverstromingen(reeks, maaiveld, station) {
  const bak = el('overstromingen');
  bak.replaceChildren();
  const van = datumTekst(new Date(reeks[0].t));
  const tot = datumTekst(new Date(reeks.at(-1).t));

  if (maaiveld == null) {
    bak.append(maakEl('p', 'hulp',
      'Zonder maaiveldhoogte is niet te bepalen of het water hier ooit boven de grond stond.'));
    return;
  }

  const gebeurtenissen = zoekOverschrijdingen(reeks, maaiveld);
  if (!gebeurtenissen.length) {
    const p = maakEl('p', 'geen-gebeurtenis');
    p.textContent =
      `In het archief van ${station.n} (${van} tot ${tot}) is het water nooit boven uw maaiveld van ` +
      `${meter(maaiveld)} NAP uitgekomen. De hoogste stand in die periode was ` +
      `${meter(Math.max(...reeks.map((p2) => p2.hi)))} NAP.`;
    bak.append(p);
    return;
  }

  const hoogste = reeks.reduce((b, p) => (p.hi > b.hi ? p : b), reeks[0]);
  const kop = maakEl('p');
  kop.textContent =
    `Sinds ${van} kwam het water bij ${station.n} ${gebeurtenissen.length === 1 ? 'één keer' : gebeurtenissen.length + ' keer'} ` +
    `boven uw maaiveld van ${meter(maaiveld)} NAP. De hoogste stand in het hele archief was ` +
    `${meter(hoogste.hi)} NAP op ${datumTijdTekst(new Date(hoogste.t))}, ` +
    `${meter(hoogste.hi - maaiveld)} boven het maaiveld.`;
  bak.append(kop);

  const lijst = maakEl('ul', 'gebeurtenissen');
  for (const g of [...gebeurtenissen].reverse().slice(0, 12)) {
    const item = maakEl('li');
    const duurUren = (g.eind - g.begin) / 3600000 + 1;
    item.append(maakEl('b', null, datumTijdTekst(new Date(g.begin))));
    item.append(document.createTextNode(
      `duurde ${duurTekst(duurUren)} en kwam tot ${meter(g.piek)} NAP, ` +
      `${meter(g.piek - maaiveld)} boven het maaiveld`));
    item.append(maakEl('br'));
    const knop = maakEl('button', 'tekstknop', 'Bekijk deze periode');
    knop.type = 'button';
    knop.addEventListener('click', () => {
      geschiedenisStand.moment = g.piekTijd;
      el('moment').value = naarInvoerTijd(new Date(g.piekTijd));
      kiesBereik(168);
      el('geschiedenisgrafiek').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    item.append(knop);
    lijst.append(item);
  }
  bak.append(lijst);
  if (gebeurtenissen.length > 12) {
    bak.append(maakEl('p', 'hulp', `De twaalf meest recente van ${gebeurtenissen.length} perioden worden getoond.`));
  }
}

function kiesBereik(uren) {
  geschiedenisStand.uren = uren;
  for (const knop of document.querySelectorAll('.knoppenrij button')) {
    knop.classList.toggle('actief', Number(knop.dataset.uren) === uren);
  }
  tekenGeschiedenis();
}

function koppelGeschiedenis() {
  el('moment').addEventListener('change', (e) => {
    const gekozen = Date.parse(e.target.value);
    if (Number.isFinite(gekozen)) { geschiedenisStand.moment = gekozen; tekenGeschiedenis(); }
  });
  for (const knop of document.querySelectorAll('.knoppenrij button')) {
    knop.addEventListener('click', () => kiesBereik(Number(knop.dataset.uren)));
  }
}

/* -------------------------------------------------------------- overzichten */

function toonStijgers() {
  const lijf = el('stijgtabel').querySelector('tbody');
  lijf.replaceChildren();
  const rijen = gegevens.stations
    .filter((s) => s.tr != null && s.tr > 0.5)
    .sort((a, b) => b.tr - a.tr)
    .slice(0, 12);

  if (!rijen.length) {
    const rij = maakEl('tr');
    const cel = maakEl('td', null, 'Op dit moment stijgt het water bij geen enkel meetpunt noemenswaardig.');
    cel.colSpan = 5;
    rij.append(cel);
    lijf.append(rij);
    return;
  }

  for (const s of rijen) {
    const tr = maakEl('tr');
    tr.append(maakEl('th', null, s.n));
    tr.firstChild.setAttribute('scope', 'row');
    const nuCel = maakEl('td', null, `${meter(s.v / 100)} NAP`);
    nuCel.dataset.kop = 'Nu';
    tr.append(nuCel);
    const verandering = maakEl('td', s.tr > 0 ? 'pijl-op' : s.tr < 0 ? 'pijl-neer' : null,
      `${trendPijl(s.tr)} ${nlGetal(s.tr, 1)} cm/u`);
    verandering.dataset.kop = 'Verandering';
    tr.append(verandering);
    const verwachtCel = maakEl('td', null, s.vwMax == null ? '–'
      : `${meter(s.vwMax / 100)} NAP${s.vw === 'afgeleid' ? ' (afgeleid)' : ''}`);
    verwachtCel.dataset.kop = 'Hoogst verwacht';
    tr.append(verwachtCel);
    const klasse = maakEl('td');
    klasse.dataset.kop = 'Klasse';
    const speld = maakEl('span', 'speld', s.kl || '–');
    if (s.kle && s.kl) { speld.style.background = s.kle; speld.style.color = '#fff'; }
    klasse.append(speld);
    tr.append(klasse);
    lijf.append(tr);
  }
}

function toonNetwerk() {
  const bak = el('netwerkblok');
  bak.replaceChildren();
  const relaties = gegevens.netwerk?.relaties || [];
  if (!relaties.length) {
    bak.append(maakEl('p', 'uitleg', 'Er zijn nog geen doorgerekende riviervakken beschikbaar.'));
    return;
  }
  const naamVan = (code) => gegevens.stations.find((s) => s.c === code)?.n || code;

  for (const keten of gegevens.netwerk.ketens) {
    const eigen = relaties.filter((r) => r.keten === keten.naam);
    if (!eigen.length) continue;
    const blok = maakEl('div', 'keten');
    blok.append(maakEl('h3', null, keten.naam +
      (keten.type === 'getij' ? ' — getijdenwater, invloed vanaf zee' : '')));
    const rij = maakEl('div', 'schakels');
    for (const rel of eigen) {
      const kaart = maakEl('div', 'schakel');
      kaart.append(maakEl('b', null, `${naamVan(rel.boven)} → ${naamVan(rel.beneden)}`), maakEl('br'));
      kaart.append(document.createTextNode(
        `looptijd ${duurTekst(rel.vertragingUur)} · doorwerking ${nlGetal(rel.versterking * 100, 0)}%`));
      kaart.append(maakEl('br'));
      kaart.append(maakEl('span', 'zwak',
        `correlatie ${nlGetal(rel.correlatie, 2)}${rel.correlatie < 0.6 ? ' — te zwak om door te rekenen' : ''}`));
      rij.append(kaart);
    }
    blok.append(rij);
    bak.append(blok);
  }
}

function toonLandkaart() {
  if (typeof L === 'undefined') {
    el('landkaart').replaceChildren(maakEl('p', 'hulp', 'De kaart kon niet worden geladen.'));
    return;
  }
  const kaart = L.map('landkaart', { scrollWheelZoom: false }).setView([52.15, 5.3], 7);
  const pdok = L.tileLayer(
    'https://service.pdok.nl/brt/achtergrondkaart/wmts/v2_0/standaard/EPSG:3857/{z}/{x}/{y}.png',
    { maxZoom: 18, attribution: 'Kaartgegevens &copy; <a href="https://www.kadaster.nl/">Kadaster</a>' });
  let terugvalGebruikt = false;
  pdok.on('tileerror', () => {
    if (terugvalGebruikt) return;
    terugvalGebruikt = true;
    kaart.removeLayer(pdok);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(kaart);
  });
  pdok.addTo(kaart);

  // Op een telefoon zou een veeg over de kaart de pagina vastzetten. De kaart wordt
  // daarom pas actief na een tik.
  const aanraakscherm = window.matchMedia('(hover: none)').matches;
  if (aanraakscherm) {
    kaart.dragging.disable();
    kaart.touchZoom.disable();
    const sluier = maakEl('div', 'kaartsluier');
    sluier.append(maakEl('span', null, 'Tik om de kaart te bedienen'));
    sluier.addEventListener('click', () => {
      kaart.dragging.enable();
      kaart.touchZoom.enable();
      sluier.remove();
    });
    el('landkaart').append(sluier);
  }

  for (const s of gegevens.stations) {
    const kleur = s.kle || '#007BC7';
    const straal = 5 + Math.min(4, Math.abs(s.tr || 0));
    const stip = L.circleMarker([s.lat, s.lon], {
      radius: straal, color: '#ffffff', weight: 1.5, fillColor: kleur, fillOpacity: .95,
    }).addTo(kaart);
    const gemeten = new Date(s.t);
    stip.bindPopup(
      `<strong>${s.n}</strong><br>${meter(s.v / 100)} NAP om ${tijdTekst(gemeten)}<br>` +
      `${trendPijl(s.tr)} ${trendTekst(s.tr)}<br>${s.kl || 'geen klasse-indeling'}` +
      (s.vwMax != null ? `<br>hoogst verwacht ${meter(s.vwMax / 100)} NAP` : ''));
  }

  const legenda = el('kaartlegenda');
  legenda.replaceChildren();
  const gezien = new Map();
  for (const s of gegevens.stations) if (s.kl && s.kle && !gezien.has(s.kl)) gezien.set(s.kl, s.kle);
  for (const [naam, kleur] of gezien) {
    const s = maakEl('span');
    const i = maakEl('i', 'stip');
    i.style.background = kleur;
    s.append(i, document.createTextNode(naam));
    legenda.append(s);
  }
}

/* ------------------------------------------------------------------ opstart */

function koppelZoeken() {
  const veld = el('adres');
  let wachter;
  veld.addEventListener('input', () => {
    clearTimeout(wachter);
    const tekst = veld.value.trim();
    if (tekst.length < 3) { toonSuggesties([]); return; }
    wachter = setTimeout(async () => {
      try { toonSuggesties(await zoekSuggesties(tekst)); }
      catch (fout) { console.warn('Zoeken mislukt', fout); }
    }, 220);
  });
  veld.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); markeer(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); markeer(-1); }
    else if (e.key === 'Escape') toonSuggesties([]);
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (gemarkeerd >= 0) kiesAdres(suggestieLijst[gemarkeerd]);
      else zoekEnKies();
    }
  });
  veld.addEventListener('blur', () => setTimeout(() => toonSuggesties([]), 150));
  el('zoekknop').addEventListener('click', zoekEnKies);

  el('locatieknop').addEventListener('click', () => {
    if (!navigator.geolocation) { meldFout('Deze browser kan geen locatie bepalen.'); return; }
    meldFout('');
    navigator.geolocation.getCurrentPosition(
      (positie) => kiesAdres({
        naam: 'Uw huidige locatie',
        soort: 'locatie',
        lat: positie.coords.latitude,
        lon: positie.coords.longitude,
      }),
      () => meldFout('De locatie kon niet worden bepaald. Geef toestemming of vul een adres in.'),
      { enableHighAccuracy: true, timeout: 10000 });
  });
}

async function zoekEnKies() {
  const tekst = el('adres').value.trim();
  if (tekst.length < 3) { meldFout('Vul minstens drie tekens in.'); return; }
  try {
    const lijst = await zoekSuggesties(tekst);
    if (!lijst?.length) { meldFout('Geen adres gevonden. Probeer een andere schrijfwijze.'); return; }
    kiesAdres(lijst[0]);
  } catch (fout) {
    meldFout('Het adres kon niet worden opgezocht. Controleer uw internetverbinding.');
  }
}

koppelZoeken();
koppelGeschiedenis();

// Bij draaien of van breedte veranderen worden de grafieken opnieuw op maat getekend.
// Alleen de breedte telt: op een telefoon verandert de hoogte bij elke scrollbeweging
// doordat de adresbalk in- en uitschuift, en dan zou de pagina onder de vinger springen.
let hertekenWachter;
let laatsteBreedte = window.innerWidth;
addEventListener('resize', () => {
  if (window.innerWidth === laatsteBreedte) return;
  laatsteBreedte = window.innerWidth;
  clearTimeout(hertekenWachter);
  hertekenWachter = setTimeout(() => {
    for (const opties of [...laatsteGrafieken.values()]) tekenGrafiek(opties);
  }, 200);
});

ladenGegevens().catch((fout) => {
  console.error(fout);
  el('ververst').textContent = 'Gegevens niet beschikbaar';
  meldFout('De waterdata kon niet worden geladen. Probeer het later opnieuw.');
});
