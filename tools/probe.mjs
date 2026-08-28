// Probe ronde 2: verwachtingen, stationcatalogus en klasse-indeling.
const log = (...a) => console.log(...a);
const clip = (s, n = 1800) => { s = typeof s === 'string' ? s : JSON.stringify(s); return s.length > n ? s.slice(0, n) + `\n…[${s.length}]` : s; };

async function get(name, url, opts = {}) {
  log('\n' + '='.repeat(70), '\n#', name, '\n', url);
  try {
    const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(90000) });
    const t = await r.text();
    log('status', r.status, '| ct', r.headers.get('content-type'), '| acao', r.headers.get('access-control-allow-origin'));
    log(clip(t));
    return t;
  } catch (e) { log('FOUT', e.message); return null; }
}
const post = (b) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });

// --- A. waterinfo chart met locationCodes (meervoud)
for (const code of ['Nijmegen-haven(NIJM)', 'nijmegenhaven', 'Lobith(LOBH)', 'lobith', 'Hoek-van-Holland(HOEK)']) {
  await get('chart ' + code,
    `https://waterinfo.rws.nl/api/chart/get?mapType=waterhoogte&locationCodes=${encodeURIComponent(code)}&values=-12,48`);
}

// --- B. andere waterinfo endpoints
for (const u of [
  'https://waterinfo.rws.nl/api/point/expertinfo?parameterid=waterhoogte',
  'https://waterinfo.rws.nl/api/details/get?locationCode=lobith&parameterId=waterhoogte',
  'https://waterinfo.rws.nl/api/nav/themakaarten',
  'https://waterinfo.rws.nl/api/point/latestmeasurement?parameterid=waterafvoer',
]) await get(u.split('/api/')[1].slice(0, 60), u);

// --- C. DD-API catalogus: welke locaties leveren WATHTE?
log('\n' + '='.repeat(70), '\n# DD-API catalogus met locaties');
try {
  const r = await fetch('https://ddapi20-waterwebservices.rijkswaterstaat.nl/METADATASERVICES/OphalenCatalogus',
    post({ CatalogusFilter: { Grootheden: true, Compartimenten: true, Hoedanigheden: true, Eenheden: true, Parameters: true } }));
  const j = await r.json();
  log('toplevel keys:', Object.keys(j).join(', '));
  for (const k of Object.keys(j)) if (Array.isArray(j[k])) log(' ', k, 'lengte', j[k].length);
  if (j.LocatieLijst) {
    log('locatie voorbeeld:', JSON.stringify(j.LocatieLijst[0]));
    const hits = j.LocatieLijst.filter(l => /lobith|nijmegen|dordrecht|hoek van holland|keizersveer/i.test(l.Naam || ''));
    log('gezochte locaties:', JSON.stringify(hits.slice(0, 12)));
  }
  if (j.AquoMetadataLocatieLijst) log('koppel voorbeeld:', JSON.stringify(j.AquoMetadataLocatieLijst.slice(0, 3)));
  const wathte = (j.AquoMetadataLijst || []).filter(a => a.Grootheid?.Code === 'WATHTE');
  log('WATHTE metadata:', JSON.stringify(wathte.slice(0, 8)));
} catch (e) { log('FOUT', e.message); }

// --- D. hoeveel waterhoogte-stations en welke klasse-labels bestaan er?
log('\n' + '='.repeat(70), '\n# waterinfo latestmeasurement samenvatting');
try {
  const r = await fetch('https://waterinfo.rws.nl/api/point/latestmeasurement?parameterid=waterhoogte');
  const j = await r.json();
  log('aantal features:', j.features.length);
  log('properties top:', clip(JSON.stringify(j.properties), 1200));
  const labels = new Set(), params = new Set();
  for (const f of j.features) for (const m of f.properties.measurements || []) { labels.add(m.measurementLabel); params.add(m.parameterId); }
  log('labels:', [...labels].join(' | '));
  log('parameterIds:', [...params].join('\n  '));
  log('voorbeeldfeature:', clip(JSON.stringify(j.features.find(f => /lobith/i.test(f.properties.name))), 1500));
} catch (e) { log('FOUT', e.message); }
