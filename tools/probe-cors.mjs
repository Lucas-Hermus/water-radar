// Kan de browser rechtstreeks bij de diensten, of is een tussenstap nodig?
// Bepalend zijn de CORS-headers bij een aanvraag mét Origin, en de preflight.
const ORIGIN = 'https://lucas-hermus.github.io';

async function toon(naam, url, opties) {
  try {
    const res = await fetch(url, { ...opties, signal: AbortSignal.timeout(60000) });
    const kop = {};
    for (const [k, v] of res.headers) if (/^access-control|^vary/i.test(k)) kop[k] = v;
    console.log(`${naam}\n  status ${res.status} ${res.statusText}`);
    console.log('  cors-headers:', Object.keys(kop).length ? JSON.stringify(kop) : 'GEEN');
    return res;
  } catch (e) { console.log(`${naam}\n  FOUT ${e.message}`); }
}

const DD = 'https://ddapi20-waterwebservices.rijkswaterstaat.nl/ONLINEWAARNEMINGENSERVICES/OphalenWaarnemingen';

console.log('=== DD-API 2.0 ===');
await toon('preflight OPTIONS', DD, {
  method: 'OPTIONS',
  headers: {
    Origin: ORIGIN,
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'content-type',
  },
});

const nu = new Date(), zes = new Date(Date.now() - 6 * 3600e3);
const f = (d) => d.toISOString().replace('Z', '+00:00');
await toon('POST met Origin', DD, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
  body: JSON.stringify({
    Locatie: { Code: 'lobith.bovenrijn.tolkamer' },
    AquoPlusWaarnemingMetadata: { AquoMetadata: { Eenheid: { Code: 'cm' }, Grootheid: { Code: 'WATHTE' }, Hoedanigheid: { Code: 'NAP' }, ProcesType: 'meting' } },
    Periode: { Begindatumtijd: f(zes), Einddatumtijd: f(nu) },
  }),
});

console.log('\n=== Waterinfo ===');
await toon('GET met Origin', 'https://waterinfo.rws.nl/api/point/latestmeasurement?parameterid=waterhoogte',
  { headers: { Origin: ORIGIN } });

console.log('\n=== PDOK (ter vergelijking, werkt al in de browser) ===');
await toon('GET met Origin', 'https://api.pdok.nl/bzk/locatieserver/search/v3_1/free?q=Roermond&rows=1',
  { headers: { Origin: ORIGIN } });
