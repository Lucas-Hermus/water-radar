# Waterradar

Een website die de actuele waterstanden en de overstromingsverwachting van Rijkswaterstaat
combineert met de hoogte van de grond, zodat je per adres ziet hoeveel ruimte er is tussen
het water en het maaiveld — en wanneer die ruimte volgens de verwachting opraakt.

De site is volledig Nederlandstalig en draait als statische pagina op GitHub Pages.

## Wat de site doet

- **Adres kiezen.** Adressen, postcodes en plaatsen komen uit de PDOK Locatieserver.
- **Maaiveldhoogte opzoeken.** De hoogte van de grond komt uit het Actueel Hoogtebestand
  Nederland (maaiveldmodel, 0,5 meter) via de PDOK-kaartdienst. Rond het adres worden vijf
  punten bemonsterd en daarvan wordt de mediaan genomen, omdat gebouwen uit dat model zijn
  weggefilterd.
- **Waterstand en verwachting tonen.** Voor het dichtstbijzijnde actieve meetpunt worden de
  meting van de afgelopen 30 uur en de verwachting voor de komende twee dagen getoond,
  afgezet tegen het maaiveld.
- **Doorrekenen naar benedenstrooms.** Voor meetpunten waarvoor Rijkswaterstaat zelf geen
  verwachting publiceert, wordt de verandering bovenstrooms overgenomen — vertraagd met de
  looptijd en geschaald met de doorwerking, beide berekend uit de meetreeksen.
- **Landelijk beeld.** Alle actieve meetpunten op de kaart, met de klasse-indeling van
  Rijkswaterstaat, plus een overzicht van de sterkste stijgingen.

## Databronnen

| Bron | Gebruik |
| --- | --- |
| [Rijkswaterstaat WaterWebservices (DD-API 2.0)](https://rijkswaterstaatdata.nl/waterdata/) | gemeten en verwachte waterhoogte t.o.v. NAP |
| [Rijkswaterstaat Waterinfo](https://waterinfo.rws.nl/) | klasse-indeling per meetpunt |
| [PDOK Locatieserver](https://www.pdok.nl/) | adressen en coördinaten |
| [Actueel Hoogtebestand Nederland via PDOK](https://www.ahn.nl/) | maaiveldhoogte |
| [PDOK BRT Achtergrondkaart](https://www.pdok.nl/) | achtergrondkaart |

Uit de catalogus van de DD-API worden de meetpunten gehaald die waterhoogte in centimeters
ten opzichte van NAP leveren. Rijkswaterstaat publiceert die reeksen in drie soorten:
`meting`, `verwachting` en `astronomisch`. De radar gebruikt de eerste twee.

## Hoe de looptijden worden bepaald

De looptijd tussen twee meetpunten wordt niet geschat maar berekend. Voor elk riviervak
uit [`tools/netwerk.mjs`](tools/netwerk.mjs) worden de meetreeksen van de afgelopen week op
een raster van tien minuten gezet. Van beide reeksen worden de veranderingen per stap
genomen, waarna wordt gezocht naar de verschuiving waarbij de correlatie tussen boven- en
benedenstrooms het hoogst is. Die verschuiving is de looptijd; de hellingshoek van de
bijbehorende regressie is de doorwerking.

Alleen relaties met een correlatie van ten minste 0,6 worden gebruikt om een verwachting
door te geven. De correlatie staat op de site vermeld, zodat zichtbaar is hoe hard een
relatie is. Bij gestuwde vakken en getijdenwater is die relatie soms zwak; dat wordt dan
ook zo getoond in plaats van weggelaten.

Een afgeleide verwachting wordt verankerd aan de huidige stand van het benedenstroomse
meetpunt: `stand_verwacht(t) = stand_nu + doorwerking × (bovenstrooms(t − looptijd) − bovenstrooms(nu − looptijd))`.
Zo werkt alleen de verandering door en niet het hoogteverschil tussen de meetpunten.

## Voorbehoud

De site is **geen officiële waarschuwingsdienst**. Er wordt geen rekening gehouden met
dijken, duinen, keringen, gemalen of het verschil tussen binnendijks en buitendijks gebied.
Vrijwel heel Nederland ligt achter waterkeringen; een waterstand boven het maaiveld
betekent daar in de praktijk meestal geen wateroverlast. Voor het overstromingsrisico van
een adres is [overstroomik.nl](https://www.overstroomik.nl/) de officiële bron, voor
actuele waterberichtgeving [waterinfo.rws.nl](https://waterinfo.rws.nl/).

## Techniek

```
site/                 de statische website (geen bouwstap, geen afhankelijkheden)
  index.html
  stijl.css
  app.js
  data/               wordt bij elke publicatie gegenereerd
tools/
  netwerk.mjs         welke meetpunten stroomopwaarts van welke liggen
  bouw-data.mjs       haalt de data op en schrijft de JSON-bestanden
  controleer-data.mjs controleert de data voordat er gepubliceerd wordt
.github/workflows/
  publiceer.yml       elk half uur verversen en publiceren op GitHub Pages
```

De data wordt niet in de repository vastgelegd. De workflow haalt de gegevens op, controleert
ze en publiceert het resultaat rechtstreeks als GitHub Pages-artefact. Faalt de controle, dan
gaat de publicatie niet door en blijft de vorige versie staan.

Lokaal draaien:

```sh
node tools/bouw-data.mjs && node tools/controleer-data.mjs
npx serve site        # of een andere statische webserver
```
