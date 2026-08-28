// Probe: verifieert welke publieke endpoints bruikbaar zijn en hoe hun antwoord eruitziet.
const OUT = [];
const log = (...a) => { const s = a.join(' '); OUT.push(s); console.log(s); };

function clip(s, n = 2500) {
  s = typeof s === 'string' ? s : JSON.stringify(s);
  return s.length > n ? s.slice(0, n) + `\n…[${s.length} tekens totaal]` : s;
}

async function probe(name, url, opts = {}) {
  log('\n' + '='.repeat(70));
  log('PROBE:', name);
  log('URL:', url);
  try {
    const t0 = Date.now();
    const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(60000) });
    log('status:', res.status, res.statusText, `(${Date.now() - t0}ms)`);
    log('content-type:', res.headers.get('content-type'));
    log('access-control-allow-origin:', res.headers.get('access-control-allow-origin'));
    const txt = await res.text();
    log('body:', clip(txt));
    return { ok: res.ok, txt };
  } catch (e) {
    log('FOUT:', e.name, e.message);
    return { ok: false, err: String(e) };
  }
}

const jsonPost = (body) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
  body: JSON.stringify(body),
});

const now = new Date();
const iso = (d) => d.toISOString().replace('Z', '+00:00');

// ---- 1. DD-API 2.0 catalogus
await probe('ddapi20 OphalenCatalogus (grootheden)',
  'https://ddapi20-waterwebservices.rijkswaterstaat.nl/METADATASERVICES/OphalenCatalogus',
  jsonPost({ CatalogusFilter: { Grootheden: true, Compartimenten: true, Hoedanigheden: true, Eenheden: true } }));

// ---- 2. Legacy catalogus
await probe('legacy OphalenCatalogus',
  'https://waterwebservices.rijkswaterstaat.nl/METADATASERVICES_DBO/OphalenCatalogus',
  jsonPost({ CatalogusFilter: { Grootheden: true } }));

// ---- 3. Laatste waarnemingen (ddapi20)
await probe('ddapi20 OphalenLaatsteWaarnemingen (lobith/nijmegen)',
  'https://ddapi20-waterwebservices.rijkswaterstaat.nl/ONLINEWAARNEMINGENSERVICES/OphalenLaatsteWaarnemingen',
  jsonPost({
    AquoPlusWaarnemingMetadataLijst: [{ AquoMetadata: { Compartiment: { Code: 'OW' }, Eenheid: { Code: 'cm' }, Grootheid: { Code: 'WATHTE' } } }],
    LocatieLijst: [{ Code: 'lobith' }, { Code: 'nijmegenhaven' }, { Code: 'hoekvanholland' }],
  }));

// ---- 4. Waarnemingen tijdreeks (ddapi20)
await probe('ddapi20 OphalenWaarnemingen lobith 24u',
  'https://ddapi20-waterwebservices.rijkswaterstaat.nl/ONLINEWAARNEMINGENSERVICES/OphalenWaarnemingen',
  jsonPost({
    Locatie: { Code: 'lobith' },
    AquoPlusWaarnemingMetadata: { AquoMetadata: { Eenheid: { Code: 'cm' }, Grootheid: { Code: 'WATHTE' }, Hoedanigheid: { Code: 'NAP' } } },
    Periode: { Begindatumtijd: iso(new Date(now - 6 * 3600e3)), Einddatumtijd: iso(now) },
  }));

// ---- 5. waterinfo publieke API
for (const u of [
  'https://waterinfo.rws.nl/api/chart/get?mapType=waterhoogte&locationCode=Nijmegen-haven(NIJM)&values=-6,48',
  'https://waterinfo.rws.nl/api/point/latestmeasurement?parameterid=waterhoogte&locationcode=Nijmegen-haven(NIJM)',
  'https://waterinfo.rws.nl/api/point/latestmeasurements?parameterid=waterhoogte',
  'https://waterinfo.rws.nl/api/nav/parameter?mapType=waterhoogte',
  'https://waterinfo.rws.nl/api/point/details?locationCode=Nijmegen-haven(NIJM)',
]) await probe('waterinfo ' + u.split('/api/')[1].split('?')[0], u, { headers: { 'Accept': 'application/json' } });

// ---- 6. PDOK locatieserver
await probe('PDOK locatieserver free',
  'https://api.pdok.nl/bzk/locatieserver/search/v3_1/free?q=Waalkade%201%20Nijmegen&rows=3&fl=id,weergavenaam,centroide_ll,centroide_rd,type',
  { headers: { 'Accept': 'application/json' } });
await probe('PDOK locatieserver suggest',
  'https://api.pdok.nl/bzk/locatieserver/search/v3_1/suggest?q=Waalkade%20Nijmegen&rows=3',
  { headers: { 'Accept': 'application/json' } });

// ---- 7. AHN hoogte via WMS GetFeatureInfo
const bbox = '5.8600,51.8450,5.8620,51.8470';
for (const [naam, u] of [
  ['AHN wms dtm_05m', `https://service.pdok.nl/rws/ahn/wms/v1_0?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetFeatureInfo&LAYERS=dtm_05m&QUERY_LAYERS=dtm_05m&CRS=CRS:84&BBOX=${bbox}&WIDTH=3&HEIGHT=3&I=1&J=1&INFO_FORMAT=application/json`],
  ['AHN wms capabilities', 'https://service.pdok.nl/rws/ahn/wms/v1_0?SERVICE=WMS&REQUEST=GetCapabilities&VERSION=1.3.0'],
]) await probe(naam, u, { headers: { 'Accept': 'application/json' } });

const fs = await import('node:fs');
fs.mkdirSync('probe-output', { recursive: true });
fs.writeFileSync('probe-output/probe.log', OUT.join('\n'));
