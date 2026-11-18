// The demo's people and their keys, with no Node-only imports, so the Node
// app (src/seedDemo.js, src/demo.js) and the Cloudflare Worker share them.

export const MOCK_NAMES = [
  'Alice Moreira', 'Bruno Teixeira', 'Carla Mendes', 'Daniel Sousa',
  'Elisa Carvalho', 'Fábio Nunes', 'Gabriela Pinto', 'Hugo Ribeiro',
  'Joana Correia', 'Leonor Matos', 'Manuel Antunes', 'Marta Freitas',
  'Nádia Barros', 'Óscar Lima', 'Paula Neves',
  'Tiago Fonseca', 'Sofia Gaspar', 'Vasco Dias', 'Vera Lobo',
  'Xavier Salgado', 'Zé Monteiro', 'Inácio Pires', 'Simão Valente',
];

// The one demo user pre-promoted to admin on every fresh seed.
export const PRESET_ADMIN_NAME = 'Elisa Carvalho';

// The guest the public demo's login screen offers (see src/demo.js).
export const DEMO_GUEST_NAME = 'Alice Moreira';

/** A name stripped to a key base: "Fábio Nunes" -> "fabionunes". */
export function tokenBase(name) {
  return String(name)
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '') || 'user';
}

/** Deterministic demo key: the same name always gives the same key. */
export function generateDemoUserToken(name) {
  const base = tokenBase(name);
  let hash = 0;
  for (const ch of base) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const digits = String(hash % 10000).padStart(4, '0');
  return `${base}${digits}`;
}
