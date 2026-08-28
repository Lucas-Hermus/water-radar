// Onderzoekt hoe ver terug en hoe groot een enkele aanvraag bij de DD-API mag zijn.
const BASE = 'https://ddapi20-waterwebservices.rijkswaterstaat.nl';
const post = (b) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
const f = (d) => new Date(d).toISOString().replace('Z', '+00:00');

async function meet(code, dagen) {
  const tot = Date.now() - 24 * 3600e3;
  const vanaf = tot - dagen * 24 * 3600e3;
  const t0 = Date.now();
  try {
    const res = await fetch(BASE + '/ONLINEWAARNEMINGENSERVICES/OphalenWaarnemingen', post({
      Locatie: { Code: code },
      AquoPlusWaarnemingMetadata: { AquoMetadata: { Eenheid: { Code: 'cm' }, Grootheid: { Code: 'WATHTE' }, Hoedanigheid: { Code: 'NAP' }, ProcesType: 'meting' } },
      Periode: { Begindatumtijd: f(vanaf), Einddatumtijd: f(tot) },
    }));
    const tekst = await res.text();
    const ms = Date.now() - t0;
    let punten = 0, eerste = '', laatste = '', fout = '';
    try {
      const j = JSON.parse(tekst);
      if (j.Succesvol === false) fout = JSON.stringify(j).slice(0, 300);
      const m = j.WaarnemingenLijst?.flatMap((w) => w.MetingenLijst || []) || [];
      punten = m.length; eerste = m[0]?.Tijdstip || ''; laatste = m.at(-1)?.Tijdstip || '';
    } catch { fout = tekst.slice(0, 300); }
    console.log(`${code} ${String(dagen).padStart(4)} dagen: status ${res.status} | ${(tekst.length / 1048576).toFixed(2)} MB | ` +
      `${punten} punten | ${(ms / 1000).toFixed(1)} s | ${eerste.slice(0, 16)} → ${laatste.slice(0, 16)} ${fout}`);
    return punten;
  } catch (e) {
    console.log(`${code} ${dagen} dagen: FOUT ${e.message} na ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    return 0;
  }
}

for (const dagen of [7, 31, 92, 366, 1096]) await meet('lobith.bovenrijn.tolkamer', dagen);
console.log('---');
for (const dagen of [31, 366]) await meet('hoekvanholland', dagen);
console.log('--- hoe ver gaat het archief terug? ---');
const oud = async (jaarGeleden) => {
  const tot = Date.now() - jaarGeleden * 365 * 24 * 3600e3;
  const vanaf = tot - 3 * 24 * 3600e3;
  const res = await fetch(BASE + '/ONLINEWAARNEMINGENSERVICES/OphalenWaarnemingen', post({
    Locatie: { Code: 'lobith.bovenrijn.tolkamer' },
    AquoPlusWaarnemingMetadata: { AquoMetadata: { Eenheid: { Code: 'cm' }, Grootheid: { Code: 'WATHTE' }, Hoedanigheid: { Code: 'NAP' }, ProcesType: 'meting' } },
    Periode: { Begindatumtijd: f(vanaf), Einddatumtijd: f(tot) },
  }));
  const j = await res.json().catch(() => ({}));
  const m = j.WaarnemingenLijst?.flatMap((w) => w.MetingenLijst || []) || [];
  console.log(`${jaarGeleden} jaar geleden: status ${res.status} | ${m.length} punten | ${m[0]?.Tijdstip || ''} | status ${m[0]?.WaarnemingMetadata?.Statuswaarde || ''}`);
};
for (const j of [1, 2, 3, 5, 10]) await oud(j);
