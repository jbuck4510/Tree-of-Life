// Live smoke test / usage demo against the real API: node examples/explore.js [ottId]
import { OtolClient } from '../src/otol-client.js';

const otol = new OtolClient();
const show = (n, indent = '') =>
  console.log(
    `${indent}${n.name} [${n.rank}] ${n.id}  hasChildren=${n.hasChildren} childrenCount=${n.childrenCount} tips=${n.numTips}`,
  );

const timed = async (label, fn) => {
  const t = performance.now();
  const result = await fn();
  console.log(`  (${label}: ${(performance.now() - t).toFixed(0)}ms)`);
  return result;
};

const info = await otol.getTreeInfo();
console.log(`Synthetic tree ${info.synthId}, taxonomy ${info.taxonomyVersion}\n`);

const root = await timed('root, network', () => otol.getRoot());
show(root);
root.children.forEach((c) => show(c, '  '));

// Follow the largest child down a few levels, lazily.
let node = root;
for (let depth = 0; depth < 3 && node.children?.length; depth++) {
  const biggest = [...node.children].sort((a, b) => b.numTips - a.numTips)[0];
  node = await timed(`${biggest.name}, network`, () => otol.getNode(biggest.id));
  console.log(`\n${node.name}: ${node.childrenCount} children`);
  node.children.slice(0, 5).forEach((c) => show(c, '  '));
}

const target = process.argv[2] ?? 'ott244265'; // Mammalia
console.log('\nSame branch twice:');
await timed('first (network)', () => otol.getChildren(target));
await timed('second (cache)', () => otol.getChildren(target));

console.log('\nError handling:');
try {
  await otol.getNode('ott5');
} catch (err) {
  console.log(`  ${err.name} code=${err.code} status=${err.status} reason=${err.reason}`);
}
