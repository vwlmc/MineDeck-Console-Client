'use strict'
// Text patterns for macros: "*" stands for any text and is captured as {1},
// {2}, ... Everything else is matched literally, ignoring upper/lower case.
//
//   "has joined"            matches any message containing "has joined"
//   "* has joined"          {1} = the start of the message up to " has joined"
//   "[* -> me] *"           {1} = who sent a private message, {2} = the message
//
// A pattern without a leading "*" may match anywhere in the text; a leading or
// trailing "*" anchors that side to the start or end of the text. Matching is
// done with a small table (pattern length x text length), so no pattern can
// make it slow, unlike regular expressions.

const MAX_PATTERN = 200
const MAX_TEXT = 1000

/**
 * @param {string} pattern
 * @param {string} text
 * @returns {null | { match: string, groups: string[] }}
 */
function matchPattern (pattern, text) {
  const p = String(pattern ?? '').slice(0, MAX_PATTERN)
  const t = String(text ?? '').slice(0, MAX_TEXT)
  if (!p.trim()) return { match: t, groups: [] }
  const P = p.toLowerCase()
  const T = t.toLowerCase()
  const m = P.length
  const n = T.length
  const anchorStart = P[0] === '*'
  const anchorEnd = P[m - 1] === '*'
  // ok[i * (n + 1) + j]: the pattern from position i can match the text from position j
  const W = n + 1
  const ok = new Uint8Array((m + 1) * W)
  for (let j = 0; j <= n; j++) ok[m * W + j] = anchorEnd ? (j === n ? 1 : 0) : 1
  for (let i = m - 1; i >= 0; i--) {
    const c = P[i]
    for (let j = n; j >= 0; j--) {
      if (c === '*') ok[i * W + j] = ok[(i + 1) * W + j] || (j < n && ok[i * W + j + 1]) ? 1 : 0
      else ok[i * W + j] = j < n && T[j] === c && ok[(i + 1) * W + j + 1] ? 1 : 0
    }
  }
  let start = -1
  if (anchorStart) start = ok[0] ? 0 : -1
  else for (let j = 0; j <= n; j++) if (ok[j]) { start = j; break }
  if (start < 0) return null
  // walk forward: each "*" takes as little text as it can (leftmost, shortest)
  const groups = []
  let j = start
  for (let i = 0; i < m; i++) {
    if (P[i] === '*') {
      let k = j
      while (!ok[(i + 1) * W + k]) k++
      groups.push(t.slice(j, k))
      j = k
    } else {
      j++
    }
  }
  return { match: t.slice(start, j), groups }
}

module.exports = { matchPattern }
