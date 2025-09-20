function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

function buildUnique(n) {
  const pool = [];
  for (let i = 0; i <= 67; i++) pool.push(i.toString());
  shuffle(pool);
  return pool.slice(0, n);
}

function distTo34(score) {
  return Math.abs(34 - score);
}

function compare(a, b) {
  a = Number(a) || 0;
  b = Number(b) || 0;
  if (a > b) return 1;
  if (b > a) return -1;
  return 0;
}

function delta(a, b) {
  a = Number(a) || 0;
  b = Number(b) || 0;
  return Math.abs(a - b);
}

module.exports = { buildUnique, distTo34, compare, delta };
