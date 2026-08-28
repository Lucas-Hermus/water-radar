# Waterradar

Een particulier hobbyproject. **Geen website van de overheid en op geen enkele manier
verbonden met Rijkswaterstaat, PDOK, het Kadaster of een waterschap** — de site gebruikt
alleen hun openbare data.

Waterradar combineert de actuele waterstanden en de verwachting van Rijkswaterstaat met de
hoogte van de grond, zodat je per adres ziet hoeveel ruimte er is tussen het water en het
maaiveld, wanneer die ruimte volgens de verwachting opraakt, en of het water daar in het
verleden ooit boven het maaiveld heeft gestaan.

De site is volledig Nederlandstalig, werkt op een telefoon en draait als statische pagina
op GitHub Pages.

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
- **Terug in de tijd.** Kies een datum en zie tussen welke standen het water die dag stond,
  met daarbij alle perioden waarin het water bij dat meetpunt boven het gekozen maaiveld uitkwam.
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

## Het meetarchief

De browser kan de WaterWebservices niet zelf bevragen: Rijkswaterstaat stuurt geen
CORS-headers mee, ook niet bij een aanvraag met `Origin` en ook niet op de preflight.
(PDOK doet dat wel, daarom werken het adres zoeken en de maaiveldhoogte wel rechtstreeks.)
Alles wat de site aan waterdata nodig heeft, moet dus vooraf klaarstaan.

Rijkswaterstaat levert de metingen per tien minuten en bewaart ze meer dan tien jaar, maar
één jaar aan tienminutenwaarden is ruwweg 15 MB per meetpunt. Dat in de repository zetten
zou voor alle meetpunten over meerdere jaren op tientallen gigabytes uitkomen.

Het archief bewaart daarom **per dag alleen de hoogste en de laagste gemeten stand**. Dat is
precies wat de vraag "stond het water hier ooit boven mijn maaiveld" nodig heeft, en het kost
ongeveer 4 kB per meetpunt per jaar: alle meetpunten samen over zes jaar blijven onder de tien
megabyte. De browser haalt bovendien alleen het bestand op van het meetpunt dat je bekijkt —
zo'n 20 kB voor het hele archief van dat punt.

Wat er niet in zit, is het verloop binnen een dag van lang geleden. Voor de afgelopen dertig
uur staat het verloop wel in de actuele momentopname.

Opslag is één bestand per meetpunt per jaar in `archief/`. Afgesloten jaren veranderen daarna
niet meer, dus de nachtelijke bijwerking raakt alleen het lopende jaar.

Het ophalen zelf blijft zwaar: om een dagwaarde te kunnen berekenen moeten de
tienminutenwaarden wel binnengehaald worden. Het archief groeit daarom stapsgewijs, elke nacht
een stuk verder terug, tot de ingestelde diepte (standaard ruim zes jaar) bereikt is. Op de
site staat altijd tot welke datum het archief loopt, en bereiken die verder teruggaan dan dat
staan uit in plaats van stilletjes hetzelfde te tonen.

Sneller of gerichter opbouwen kan met de hand via de workflow *Meetarchief bijwerken*:
`stap_dagen` bepaalt hoeveel er per beurt bij komt, `alleen_codes` beperkt het tot een paar
meetpunten.

## Techniek

```
site/                    de statische website (geen bouwstap, geen afhankelijkheden)
  index.html
  stijl.css
  app.js
  data/                  wordt bij elke publicatie gegenereerd
archief/                 de meetgeschiedenis: per meetpunt per jaar de dagwaarden
tools/
  rws.mjs                gedeelde toegang tot de WaterWebservices
  netwerk.mjs            welke meetpunten stroomopwaarts van welke liggen
  bouw-data.mjs          haalt de actuele data op en schrijft de JSON-bestanden
  archief.mjs            vult het meetarchief aan en breidt het verder terug uit
  stel-archief-samen.mjs voegt de maandbestanden samen voor de website
  controleer-data.mjs    controleert de data voordat er gepubliceerd wordt
.github/workflows/
  publiceer.yml          elk half uur verversen en publiceren op GitHub Pages
  archief.yml            elke nacht het meetarchief bijwerken
```

De data wordt niet in de repository vastgelegd. De workflow haalt de gegevens op, controleert
ze en publiceert het resultaat rechtstreeks als GitHub Pages-artefact. Faalt de controle, dan
gaat de publicatie niet door en blijft de vorige versie staan.

Lokaal draaien:

```sh
node tools/bouw-data.mjs && node tools/controleer-data.mjs
npx serve site        # of een andere statische webserver
```
