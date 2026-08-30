import { brandToken } from '../app/shared/name.ts';
const cases: [string, string][] = [
  ['gimp image editor', 'https://www.gimp.org'],
  ['gimp', 'https://www.gimp.org'],
  ['replit', 'https://replit.com'],
  ['the supabase database', 'https://supabase.com'],
  ['Acme Corp', ''],
  ['bolt', 'https://bolt.new'],
];
for (const [company, site] of cases) {
  console.log(`${JSON.stringify(company).padEnd(28)} + ${(site || '(no site)').padEnd(26)} -> ${JSON.stringify(brandToken(company, site))}`);
}
