#!/usr/bin/env node
/**
 * Diagnóstico do Feed sugerido no servidor (não imprime cookies).
 * Mostra cada pedido feito à rede (caminho + status HTTP + redirecionamento)
 * e quantos vídeos foram encontrados. Não cria matérias.
 *
 * Uso (como viralizeai, na pasta do projeto):
 *   node scripts/test-feed-sugerido.js instagram
 *   node scripts/test-feed-sugerido.js instagram "https://www.instagram.com/reels/DdwGDHRDU3f/"
 *   node scripts/test-feed-sugerido.js facebook
 *   node scripts/test-feed-sugerido.js youtube "" gospel
 */
require('dotenv').config();

const { coletarSugeridos } = require('../src/services/feedSugeridoColetor');

async function main() {
  const rede = String(process.argv[2] || 'instagram').toLowerCase();
  const seedUrl = String(process.argv[3] || '').trim();
  const tema = String(process.argv[4] || '').trim();
  const trace = [];
  console.log(`[feed-sugerido] testando ${rede}${seedUrl ? ` a partir de ${seedUrl}` : ''}…`);
  const resultado = await coletarSugeridos(rede, { quantidade: 5, seedUrl, tema, trace });
  console.log('\nPassos:');
  for (const passo of resultado.trace || trace) console.log(`  ${passo}`);
  console.log(`\nOrigem: ${resultado.origem || '—'}`);
  console.log(`Vídeos encontrados: ${resultado.itens.length}`);
  for (const item of resultado.itens) console.log(`  - ${item.url}${item.autor ? ` (@${item.autor})` : ''}`);
  if (resultado.motivo) console.log(`\nMotivo: ${resultado.motivo}`);
}

main().catch((err) => {
  console.error('Falhou:', err.message);
  process.exit(1);
});
