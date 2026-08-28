// Probe ronde 4: verwachtingen ophalen en stationinventaris bepalen.
const log = (...a) => console.log(...a);
const clip = (s, n = 1200) => { s = typeof s === 'string' ? s : JSON.stringify(s); return s.length > n ? s.slice(0, n) + `\n…[${s.length}]` : s; };
const post = (b) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
const BASE = 'https://ddapi20-waterwebservices.rijkswaterstaat.nl';

const cat = await (await fetch(BASE + '/METADATASERVICES/OphalenCatalogus',
  post({ CatalogusFilter: { Grootheden: true, ProcesTypes: true, Hoedanigheden: true, Eenheden: true, Compartimenten: true } }))).json();

const ids = {};
for (const a of cat.AquoMetadataLijst) {
  if (a.Grootheid?.Code === 'WATHTE' && a.Hoedanigheid?.Code === 'NAP' && a.Eenheid?.Code === 'cm')
    ids[a.ProcesType || a.Procestype || '?'] = a.AquoMetadata_MessageID;
  if (a.Grootheid?.Code === 'Q' && a.Eenheid?.Code === 'm3/s') ids['Q_' + (a.ProcesType || '?')] = a.AquoMetadata_MessageID;
}
log('WATHTE/NAP/cm ids per procestype:', JSON.stringify(ids));

const locById = new Map(cat.LocatieLijst.map(l => [l.Locatie_MessageID, l]));
const per = {};
for (const k of Object.keys(ids)) per[k] = [];
for (const koppel of cat.AquoMetadataLocatieLijst) {
  for (const [k, id] of Object.entries(ids)) if (koppel.AquoMetaData_MessageID === id) {
    const l = locById.get(koppel.Locatie_MessageID); if (l) per[k].push(l);
  }
}
for (const [k, v] of Object.entries(per)) log(`locaties met ${k}: ${v.length}`);
log('voorbeeld meting:', JSON.stringify(per['meting']?.slice(0, 3)));
log('voorbeeld verwachting:', JSON.stringify(per['verwachting']?.slice(0, 6)));
log('alle verwachting-namen:', (per['verwachting'] || []).map(l => l.Code).join(', '));

// verwachting daadwerkelijk ophalen
const f = (d) => d.toISOString().replace('Z', '+00:00');
for (const code of (per['verwachting'] || []).slice(0, 3).map(l => l.Code)) {
  const r = await fetch(BASE + '/ONLINEWAARNEMINGENSERVICES/OphalenWaarnemingen', post({
    Locatie: { Code: code },
    AquoPlusWaarnemingMetadata: { AquoMetadata: { Eenheid: { Code: 'cm' }, Grootheid: { Code: 'WATHTE' }, Hoedanigheid: { Code: 'NAP' }, ProcesType: 'verwachting' } },
    Periode: { Begindatumtijd: f(new Date(Date.now() - 3600e3)), Einddatumtijd: f(new Date(Date.now() + 10 * 24 * 3600e3)) },
  }));
  const t = await r.text();
  let n = 0, eerste = '', laatste = '';
  try { const j = JSON.parse(t); const m = j.WaarnemingenLijst?.[0]?.MetingenLijst || []; n = m.length; eerste = m[0]?.Tijdstip; laatste = m.at(-1)?.Tijdstip; log(`\nverwachting ${code}: status ${r.status}, reeksen ${j.WaarnemingenLijst?.length}, punten ${n}, van ${eerste} tot ${laatste}`); if (!n) log(clip(t, 700)); }
  catch { log(code, r.status, clip(t, 500)); }
}

// bulk laatste waarnemingen
const codes = (per['meting'] || []).slice(0, 5).map(l => ({ Code: l.Code }));
const r2 = await fetch(BASE + '/ONLINEWAARNEMINGENSERVICES/OphalenLaatsteWaarnemingen', post({
  AquoPlusWaarnemingMetadataLijst: [{ AquoMetadata: { Compartiment: { Code: 'OW' }, Eenheid: { Code: 'cm' }, Grootheid: { Code: 'WATHTE' }, Hoedanigheid: { Code: 'NAP' } } }],
  LocatieLijst: codes,
}));
log('\nlaatste waarnemingen bulk status', r2.status, clip(await r2.text(), 1500));
