// Minimal SPDX license-expression evaluator for the license allowlist.
//
//   satisfies('(MIT OR Apache-2.0) AND ISC', allowed)   -> true when some choice of OR branches is wholly allowed
//
// Grammar: expr := term (OR term)* ; term := factor (AND factor)* ; factor := ID | '(' expr ')'.
// AND binds tighter than OR (as in the SPDX spec). `WITH` exceptions, `+` suffixes, LicenseRef-* and
// anything that does not parse are NOT allowed: an unparseable expression fails closed.

function tokenize(expression) {
  const tokens = expression.match(/\(|\)|[^\s()]+/g);
  return tokens ?? [];
}

export function satisfies(expression, allowed) {
  if (typeof expression !== 'string' || expression.trim() === '') return false;
  const tokens = tokenize(expression);
  let pos = 0;

  const parseExpr = () => {
    let value = parseTerm();
    while (tokens[pos] === 'OR') {
      pos += 1;
      const right = parseTerm();
      value = value || right;
    }
    return value;
  };
  const parseTerm = () => {
    let value = parseFactor();
    while (tokens[pos] === 'AND') {
      pos += 1;
      const right = parseFactor();
      value = value && right;
    }
    return value;
  };
  const parseFactor = () => {
    const token = tokens[pos];
    if (token === undefined) throw new Error('unexpected end of expression');
    if (token === '(') {
      pos += 1;
      const value = parseExpr();
      if (tokens[pos] !== ')') throw new Error('missing )');
      pos += 1;
      return value;
    }
    if (token === ')' || token === 'AND' || token === 'OR' || token === 'WITH') throw new Error(`unexpected ${token}`);
    pos += 1;
    if (tokens[pos] === 'WITH') throw new Error('WITH exceptions are not on the allowlist');
    return allowed.has(token);
  };

  try {
    const value = parseExpr();
    return pos === tokens.length && value;
  } catch {
    return false;
  }
}
