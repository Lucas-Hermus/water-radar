// Probe ronde 3: verwachtingen vinden.
const log = (...a) => console.log(...a);
const clip = (s, n = 1500) => { s = typeof s === 'string' ? s : JSON.stringify(s); return s.length > n ? s.slice(0, n) + `\n…[${s.length}]` : s; };
const post = (b) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });

// --- 1. Welke API-routes gebruikt waterinfo zelf?
log('='.repeat(70), '\n# waterinfo JS-bundels doorzoeken op /api/-routes');
try {
  const html = await (await fetch('https://waterinfo.rws.nl/publiek/waterhoogte')).text();
  log('html lengte', html.length);
  const srcs = [...html.matchAll(/(?:src|href)="([^"]+\.js[^"]*)"/g)].map(m => m[1]);
  log('scripts:', srcs.join('\n  '));
  const routes = new Set();
  for (const s of srcs.slice(0, 25)) {
    const u = s.startsWith('http') ? s : new URL(s, 'https://waterinfo.rws.nl/publiek/waterhoogte').href;
    try {
      const js = await (await fetch(u)).text();
      for (const m of js.matchAll(/["'`\/]((?:\/)?api\/[A-Za-z0-9_\-\/{}.$]{2,60})/g)) routes.add(m[1]);
    } catch (e) { log('  js fout', u, e.message); }
  }
  log('gevonden routes:\n  ' + [...routes].sort().join('\n  '));
  // inline routes in html
  const inline = new Set();
  for (const m of html.matchAll(/api\/[A-Za-z0-9_\-\/{}.$]{2,60}/g)) inline.add(m[0]);
  log('routes in html:\n  ' + [...inline].sort().join('\n  '));
} catch (e) { log('FOUT', e.message); }

// --- 2. DD-API: bestaan er verwachting-grootheden / procestypes?
log('\n' + '='.repeat(70), '\n# DD-API grootheden/procestypes met "verwacht"');
try {
  const j = await (await fetch('https://ddapi20-waterwebservices.rijkswaterstaat.nl/METADATASERVICES/OphalenCatalogus',
    post({ CatalogusFilter: { Grootheden: true, ProcesTypes: true, Hoedanigheden: true, Eenheden: true, Compartimenten: true } }))).json();
  const set = new Set(), proc = new Set();
  for (const a of j.AquoMetadataLijst || []) {
    if (/verwacht|astronom|voorspel/i.test(JSON.stringify(a))) set.add(JSON.stringify({ id: a.AquoMetadata_MessageID, G: a.Grootheid, P: a.Procestype || a.ProcesType, H: a.Hoedanigheid, E: a.Eenheid }));
    if (a.Procestype || a.ProcesType) proc.add(JSON.stringify(a.Procestype || a.ProcesType));
  }
  log('verwachting-achtige metadata:\n  ' + [...set].slice(0, 25).join('\n  '));
  log('procestypes:', [...proc].slice(0, 30).join(' | '));
  const wathteNap = (j.AquoMetadataLijst || []).find(a => a.Grootheid?.Code === 'WATHTE' && a.Hoedanigheid?.Code === 'NAP' && a.Eenheid?.Code === 'cm');
  log('WATHTE/NAP/cm messageID:', wathteNap?.AquoMetadata_MessageID);
} catch (e) { log('FOUT', e.message); }

// --- 3. DD-API tijdreeks met een echte code
log('\n' + '='.repeat(70), '\n# DD-API OphalenWaarnemingen lobith.bovenrijn.haven');
const isoNu = new Date(), iso6 = new Date(Date.now() - 6 * 3600e3);
const f = (d) => d.toISOString().replace('Z', '+00:00');
try {
  const r = await fetch('https://ddapi20-waterwebservices.rijkswaterstaat.nl/ONLINEWAARNEMINGENSERVICES/OphalenWaarnemingen',
    post({
      Locatie: { Code: 'lobith.bovenrijn.haven' },
      AquoPlusWaarnemingMetadata: { AquoMetadata: { Eenheid: { Code: 'cm' }, Grootheid: { Code: 'WATHTE' }, Hoedanigheid: { Code: 'NAP' } } },
      Periode: { Begindatumtijd: f(iso6), Einddatumtijd: f(isoNu) },
    }));
  const t = await r.text();
  log('status', r.status);
  log(clip(t, 2500));
} catch (e) { log('FOUT', e.message); }

// --- 4. kandidaat-verwachtingsparameters op waterinfo
for (const p of ['waterhoogte-verwacht', 'waterhoogteverwachting', 'waterhoogte_verwacht', 'astronomische-getij', 'waterafvoer-verwacht']) {
  try {
    const r = await fetch(`https://waterinfo.rws.nl/api/point/latestmeasurement?parameterid=${p}`);
    const t = await r.text();
    log(`\n# parameterid=${p} -> ${r.status} ${clip(t, 300)}`);
  } catch (e) { log(p, 'FOUT', e.message); }
}
