// Stroomnetwerk: welk meetpunt ligt bovenstrooms van welk ander meetpunt.
// De ketens volgen de werkelijke stroomrichting; bij getijdenwater (benedenrivieren)
// loopt de "bovenstroomse" invloed juist vanaf zee landinwaarts.
// Vertraging en versterking per schakel worden niet geraden maar uit de meetdata berekend.

export const KETENS = [
  {
    naam: 'Rijn en Waal',
    type: 'rivier',
    punten: [
      'lobith.bovenrijn.tolkamer',
      'millingenaanderijn.pannerdensekop',
      'nijmegen.waal',
      'tiel.waal',
      'zaltbommel',
      'dalem',
    ],
  },
  {
    naam: 'Pannerdensch Kanaal, Nederrijn en Lek',
    type: 'rivier',
    punten: [
      'millingenaanderijn.pannerdensekop',
      'westervoort.ijsselkop',
      'huissen.nederrijn',
      'driel.boven',
      'driel.beneden',
      'amerongen.boven',
      'amerongen.beneden',
      'hagestein.boven',
      'hagestein.beneden',
      'krimpenaandelek.lek',
    ],
  },
  {
    naam: 'IJssel',
    type: 'rivier',
    punten: [
      'westervoort.ijsselkop',
      'doesburg.ijssel',
      'zutphen.ijssel',
      'deventer',
      'olst',
      'wijhe',
      'zwolle.ijssel',
      'kampen.ijssel',
    ],
  },
  {
    naam: 'Maas',
    type: 'rivier',
    punten: [
      'eijsden.grens',
      'maastricht.sintpieter',
      'maastricht.borgharen.maas.beneden',
      'elsloo.maas',
      'stevensweert',
      'linne.stuw.beneden',
      'roermond.boven',
      'buggenum',
      'neer',
      'belfeld.boven',
      'steyl',
      'venlo',
      'well',
      'sambeek.boven',
      'sambeek.beneden',
      'gennep',
      'mook',
      'grave.boven',
      'grave.beneden',
      'megen.maas',
      'lith.boven',
      'lith.beneden',
      'heesbeen',
      'hank.bergschemaas',
    ],
  },
  {
    naam: 'Benedenrivieren (getij vanaf zee)',
    type: 'getij',
    punten: [
      'hoekvanholland',
      'maassluis',
      'vlaardingen',
      'rotterdam.nieuwemaas.boompjes',
      'rotterdam.brienenoordbrug',
      'krimpenaandeijssel.hollandscheijssel',
      'alblasserdam',
      'dordrecht.oudemaas.benedenmerwede',
      'sliedrecht',
      'dordrecht.nieuwemerwede',
      'werkendam.nieuwemerwede',
    ],
  },
  {
    naam: 'Haringvliet en Hollandsch Diep',
    type: 'getij',
    punten: [
      'hoekvanholland',
      'hellevoetsluis',
      'moerdijk',
      'willemstad.hollandschdiep',
      'dordrecht.dordtschekil',
    ],
  },
  {
    naam: 'Westerschelde',
    type: 'getij',
    punten: ['vlissingen', 'terneuzen', 'hansweert', 'rilland.bath'],
  },
  {
    naam: 'Waddenzee',
    type: 'getij',
    punten: [
      'denhelder.marsdiep',
      'denoever.waddenzee.voorhaven',
      'harlingen.waddenzee',
      'lauwersoog.waddenzee',
      'delfzijl',
    ],
  },
];

// Alle schakels (bovenstrooms -> benedenstrooms) afgeleid uit de ketens.
export function schakels() {
  const uit = [];
  for (const keten of KETENS) {
    for (let i = 0; i < keten.punten.length - 1; i++) {
      uit.push({ boven: keten.punten[i], beneden: keten.punten[i + 1], keten: keten.naam, type: keten.type });
    }
  }
  return uit;
}

// Elk meetpunt dat in een keten voorkomt, krijgt een langere meetreeks
// zodat vertraging en versterking betrouwbaar te berekenen zijn.
export function netwerkPunten() {
  return [...new Set(KETENS.flatMap((k) => k.punten))];
}
