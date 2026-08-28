// Gedeelde toegang tot de WaterWebservices (DD-API 2.0) van Rijkswaterstaat.

export const DDAPI = 'https://ddapi20-waterwebservices.rijkswaterstaat.nl';
export const UUR = 3600e3;

export const tijdstempel = (d) => new Date(d).toISOString().replace('Z', '+00:00');

export const teller = { verzoeken: 0, bytes: 0 };

export async function api(pad, body, pogingen = 3) {
  for (let poging = 1; poging <= pogingen; poging++) {
    try {
      teller.verzoeken++;
      const res = await fetch(DDAPI + pad, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180000),
      });
      const tekst = await res.text();
      teller.bytes += tekst.length;
      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + tekst.slice(0, 200));
      return JSON.parse(tekst);
    } catch (fout) {
      if (poging === pogingen) throw fout;
      await new Promise((r) => setTimeout(r, 1000 * poging));
    }
  }
}

// Voert taken uit met een begrensd aantal gelijktijdige verzoeken.
export async function parallel(items, grens, taak) {
  const uit = new Array(items.length);
  let volgende = 0;
  await Promise.all(Array.from({ length: Math.min(grens, items.length) }, async () => {
    while (true) {
      const i = volgende++;
      if (i >= items.length) return;
      try { uit[i] = await taak(items[i], i); }
      catch (fout) { uit[i] = { fout: String(fout.message || fout) }; }
    }
  }));
  return uit;
}

export async function haalCatalogus() {
  return api('/METADATASERVICES/OphalenCatalogus', {
    CatalogusFilter: { Grootheden: true, ProcesTypes: true, Hoedanigheden: true, Eenheden: true, Compartimenten: true },
  });
}

// Welke meetpunten leveren waterhoogte in cm t.o.v. NAP, per procestype?
export function meetpuntenPerProces(catalogus) {
  const ids = {};
  for (const a of catalogus.AquoMetadataLijst) {
    if (a.Grootheid?.Code === 'WATHTE' && a.Hoedanigheid?.Code === 'NAP' && a.Eenheid?.Code === 'cm') {
      ids[a.ProcesType] = a.AquoMetadata_MessageID;
    }
  }
  const locatiePerId = new Map(catalogus.LocatieLijst.map((l) => [l.Locatie_MessageID, l]));
  const uit = {};
  for (const proces of Object.keys(ids)) uit[proces] = new Set();
  for (const koppel of catalogus.AquoMetadataLocatieLijst) {
    for (const [proces, id] of Object.entries(ids)) {
      if (koppel.AquoMetaData_MessageID === id) {
        const loc = locatiePerId.get(koppel.Locatie_MessageID);
        if (loc) uit[proces].add(loc.Code);
      }
    }
  }
  return { ids, codes: uit };
}

// Haalt een meetreeks op. Let op: de dienst geeft lange perioden terug als meerdere
// blokken die niet op tijd geordend zijn en elkaar kunnen overlappen, dus sorteren
// en ontdubbelen is noodzakelijk.
export async function haalReeks(code, procesType, vanaf, tot) {
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
  const perTijd = new Map();
  for (const w of antwoord.WaarnemingenLijst || []) {
    for (const m of w.MetingenLijst || []) {
      const waarde = m.Meetwaarde?.Waarde_Numeriek;
      if (waarde == null || Math.abs(waarde) > 10000) continue;
      perTijd.set(new Date(m.Tijdstip).getTime(), waarde);
    }
  }
  return [...perTijd.entries()].sort((a, b) => a[0] - b[0]);
}
